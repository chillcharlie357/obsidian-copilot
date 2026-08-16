/**
 * JSON-RPC 2.0 对端：请求关联、通知分发、服务端请求处理。
 * 插件与适配器两侧通用。
 */
import {
  ERR_INTERNAL,
  ERR_METHOD_NOT_FOUND,
  isNotification,
  isRequest,
  isResponse,
  RpcError,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./types.js";
import type { StdioStream } from "./transport.js";

let nextId = 0;

export interface PeerOptions {
  /** 请求默认超时（毫秒），0 表示不限时 */
  requestTimeoutMs?: number;
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class Peer {
  private pending = new Map<JsonRpcId, PendingRequest>();
  private requestHandler: RequestHandler | null = null;
  private notificationHandler: NotificationHandler | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    readonly stream: StdioStream,
    private readonly options: PeerOptions = {}
  ) {}

  setRequestHandler(handler: RequestHandler | null): void {
    this.requestHandler = handler;
  }

  setNotificationHandler(handler: NotificationHandler | null): void {
    this.notificationHandler = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stream.start();
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    for await (const msg of this.stream.messages()) {
      try {
        if (isRequest(msg)) await this.handleRequest(msg);
        else if (isResponse(msg)) this.handleResponse(msg);
        else if (isNotification(msg)) await this.handleNotification(msg);
      } catch (error) {
        // 单条消息处理异常不终止连接
        console.error("[acp] message handling error:", error);
      }
    }
    // 连接关闭：拒绝所有未决请求
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new RpcError(ERR_INTERNAL, "connection closed"));
    }
    this.pending.clear();
  }

  private async handleRequest(msg: Extract<JsonRpcMessage, { id: JsonRpcId; method: string }>): Promise<void> {
    const handler = this.requestHandler;
    try {
      if (!handler) {
        this.stream.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: ERR_METHOD_NOT_FOUND, message: `no handler for ${msg.method}` },
        });
        return;
      }
      const result = await handler(msg.method, msg.params);
      this.stream.send({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? null : result });
    } catch (error) {
      const rpc =
        error instanceof RpcError
          ? error
          : new RpcError(ERR_INTERNAL, error instanceof Error ? error.message : String(error));
      this.stream.send({ jsonrpc: "2.0", id: msg.id, error: { code: rpc.code, message: rpc.message, ...(rpc.data !== undefined ? { data: rpc.data } : {}) } });
    }
  }

  private handleResponse(msg: { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: JsonRpcError }): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.error !== undefined) {
      pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  private async handleNotification(msg: Extract<JsonRpcMessage, { method: string }>): Promise<void> {
    await this.notificationHandler?.(msg.method, msg.params);
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError(ERR_INTERNAL, "connection closed"));
    const id = ++nextId;
    const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 0;
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(ERR_INTERNAL, `request ${method} timed out after ${timeout}ms`));
        }, timeout);
      }
      this.pending.set(id, entry);
      this.stream.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.stream.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
