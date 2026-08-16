/**
 * DSH 下行事件流客户端：/api/events.mux 与 /api/events.host 两条 WebSocket。
 * 帧格式：{type:"server-request", rpcId, method?, payload:{...}}
 */
import WebSocket from "ws";
import type { DshTarget } from "./rpc.js";

// ---------------------------------------------------------------------------
// 帧类型
// ---------------------------------------------------------------------------

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  sourceEventSeqs?: number[];
  surfaceOp?: unknown;
  ignorable?: true;
}

export type MuxFramePayload =
  | {
      type: "session/event";
      sessionId: string;
      event: DshSessionEvent;
      view?: { for: "call" | "result"; view: { card: string } };
    }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | {
      type: "approval/requested";
      sessionId: string;
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    }
  | {
      type: "approval/resolved";
      sessionId: string;
      approvalId: string;
      outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable";
    }
  | { type: "question/requested"; sessionId: string; questions: DshQuestion[] }
  | { type: "question/resolved"; sessionId: string; questionRpcId: string; outcome: "answered" | "cancelled" }
  | { type: "session/queue"; sessionId: string; items: unknown[] }
  | { type: "session/jobs"; sessionId: string; jobs: DshJobView[] }
  | { type: "session/projection"; sessionId: string; key: string; value: unknown; seq: number }
  | { type: "stream/error"; error: { code: string; message: string; details?: unknown } };

export interface DshQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface DshJobView {
  id: string;
  kind: string;
  label: string;
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

export type HostFramePayload =
  | { type: "host/session-added"; sessionId: string; blank: boolean; cwd?: string; agentPreset?: string }
  | { type: "host/session-removed"; sessionId: string }
  | { type: "host/session-status"; sessionId: string; running: boolean }
  | { type: "host/agent-error"; sessionId: string; message: string }
  | { type: "host/workspace-changed"; workspace: unknown }
  | { type: "host/workspace-removed"; workspaceId: string }
  | { type: "host/workspace-order-changed"; workspaceIds: string[] }
  | { type: "host/archived-sessions-changed"; archivedSessionIds: string[] }
  | { type: "host/remote-event"; event: string; args: unknown[] }
  | { type: "stream/error"; error: { code: string; message: string; details?: unknown } };

interface ServerRequestFrame {
  type: string;
  rpcId: string;
  method?: string;
  payload: MuxFramePayload | HostFramePayload;
}

// ---------------------------------------------------------------------------
// 重连型 WebSocket 客户端
// ---------------------------------------------------------------------------

export interface FrameListener<T> {
  onFrame?: (rpcId: string, payload: T) => void;
  onState?: (state: "connected" | "reconnecting" | "closed") => void;
}

const BACKOFF_BASE = 500;
const BACKOFF_MAX = 10_000;

class ReconnectingSocket<T> {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly target: DshTarget,
    private readonly path: string,
    private readonly listener: FrameListener<T>,
    private readonly log: (message: string) => void
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.terminate();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const url = `ws://${this.target.host}:${this.target.port}${this.path}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { handshakeTimeout: 3000 });
    } catch (error) {
      this.log(`[mux] 连接失败 ${url}: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      this.attempt = 0;
      this.listener.onState?.("connected");
    });
    socket.on("message", (data: WebSocket.RawData) => {
      let frame: ServerRequestFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerRequestFrame;
      } catch {
        this.log("[mux] 丢弃无法解析的帧");
        return;
      }
      if (frame.type !== "server-request") return;
      this.listener.onFrame?.(frame.rpcId, frame.payload as T);
    });
    socket.on("error", (error) => {
      this.log(`[mux] 流错误 ${this.path}: ${error.message}`);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) {
        this.listener.onState?.("reconnecting");
        this.scheduleReconnect();
      } else {
        this.listener.onState?.("closed");
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** Math.max(0, this.attempt));
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay + Math.random() * delay * 0.5);
  }
}

export class DshStreams {
  private muxSocket: ReconnectingSocket<MuxFramePayload>;
  private hostSocket: ReconnectingSocket<HostFramePayload>;
  /** host 流中每个 session 的最新 running 状态 */
  readonly running = new Map<string, boolean>();

  constructor(
    target: DshTarget,
    private readonly listeners: {
      onMuxFrame?: (rpcId: string, payload: MuxFramePayload) => void;
      onHostFrame?: (rpcId: string, payload: HostFramePayload) => void;
      onState?: (stream: "mux" | "host", state: "connected" | "reconnecting" | "closed") => void;
    },
    private readonly log: (message: string) => void
  ) {
    this.muxSocket = new ReconnectingSocket<MuxFramePayload>(
      target,
      "/api/events.mux",
      {
        onFrame: (rpcId, payload) => listeners.onMuxFrame?.(rpcId, payload),
        onState: (state) => listeners.onState?.("mux", state),
      },
      log
    );
    this.hostSocket = new ReconnectingSocket<HostFramePayload>(
      target,
      "/api/events.host",
      {
        onFrame: (rpcId, payload) => {
          if (payload.type === "host/session-status") {
            this.running.set(payload.sessionId, payload.running);
          }
          listeners.onHostFrame?.(rpcId, payload);
        },
        onState: (state) => listeners.onState?.("host", state),
      },
      log
    );
  }

  start(): void {
    this.muxSocket.start();
    this.hostSocket.start();
  }

  stop(): void {
    this.muxSocket.stop();
    this.hostSocket.stop();
  }

  isRunning(sessionId: string): boolean {
    return this.running.get(sessionId) === true;
  }
}
