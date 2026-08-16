/**
 * ACP server 语义层：把 ACP 会话方法映射到 DSH web API，并把 DSH 事件流
 * 翻译成 ACP session/update 通知。
 */
import {
  ERR_AGENT_UNAVAILABLE,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_SESSION_NOT_FOUND,
  ACP_PROTOCOL_VERSION,
  RpcError,
  type AgentCapabilities,
  type ContentBlock,
  type InitializeRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type Peer,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionOutcome,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from "@dsh-obsidian/acp-core";
import { DshClient } from "./dsh/rpc.js";
import { DshStreams, type HostFramePayload, type MuxFramePayload } from "./dsh/mux.js";
import { DshServerManager } from "./dsh/lifecycle.js";
import {
  chunkToUpdate,
  isUserMessageEvent,
  mapToolKind,
  promptBlockToDsh,
  textOfMessageEvent,
  toolCallToUpdate,
  toolResultToUpdates,
  turnEndToStopReason,
} from "./dsh/mapping.js";

export interface AdapterConfig {
  dsn: string;
  autoStartDsh: boolean;
  dshBin: string;
  killDshOnExit: boolean;
  log: (message: string) => void;
  debug?: boolean;
}

/** DSH 内置 slash 命令目录（agent 定义，随会话广告给客户端） */
const DSH_COMMANDS: SessionUpdate[] = [
  {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "plan", description: "生成实施计划并进入计划模式（需批准）", input: { hint: "要规划的任务描述" } },
      { name: "goal", description: "创建长期目标，agent 自动多轮执行直到完成", input: { hint: "目标描述" } },
      { name: "compact", description: "压缩当前会话上下文，释放上下文窗口", input: { hint: "" } },
      { name: "feedback", description: "记录对会话结果的反馈", input: { hint: "反馈内容" } },
    ],
  },
];

interface PendingPrompt {
  rpcId: string;
  resolve: (response: PromptResponse) => void;
  reject: (error: RpcError) => void;
  seen: boolean;
  ended: boolean;
  stopReason: StopReason;
  errorMessage: string | null;
  cancelRequested: boolean;
}

interface SessionCtx {
  sessionId: string;
  cwd: string;
  pending: PendingPrompt[];
  /** 当前 turn 对应的 pending（user/message 到达后、turn/end 前） */
  active: PendingPrompt | null;
  /** 当前 turn 内是否已开始新的 turn（goal 模式） */
  turnOpen: boolean;
  /** 已转发给客户端的 job 工具卡 */
  jobStatus: Map<string, string>;
  /** turn/end 后用于 unknown 状态的延迟兜底 */
  settleTimer: ReturnType<typeof setTimeout> | null;
  /** 实时流中按 turn:step 累积的 chunk 文本（用于与 assistant/message 去重） */
  chunkedKeys: Map<string, string>;
}

export class AcpServer {
  private client: DshClient;
  private streams: DshStreams;
  private manager: DshServerManager;
  private sessions = new Map<string, SessionCtx>();
  private readonly target: { host: string; port: number };
  private started = false;
  private readonly debug: boolean;

  constructor(
    private readonly peer: Peer,
    private readonly config: AdapterConfig
  ) {
    this.debug = config.debug === true;
    const url = new URL(config.dsn);
    this.target = { host: url.hostname || "127.0.0.1", port: url.port ? Number(url.port) : 80 };
    this.client = new DshClient(this.target);
    this.manager = new DshServerManager(
      this.client,
      {
        autoStart: config.autoStartDsh,
        dshBin: config.dshBin || "dsh",
        port: this.target.port,
        killOnExit: config.killDshOnExit,
      },
      config.log
    );
    this.streams = new DshStreams(
      this.target,
      {
        onMuxFrame: (rpcId, payload) => void this.onMuxFrame(rpcId, payload),
        onHostFrame: (rpcId, payload) => void this.onHostFrame(payload),
        onState: (stream, state) => config.log(`[streams] ${stream}: ${state}`),
      },
      config.log
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.streams.start();
    this.peer.setRequestHandler((method, params) => this.handleRequest(method, params));
    this.peer.setNotificationHandler((method, params) => this.handleNotification(method, params));
    this.peer.start();
  }

  dispose(): void {
    this.streams.stop();
    this.manager.dispose();
    for (const ctx of this.sessions.values()) {
      if (ctx.settleTimer) clearTimeout(ctx.settleTimer);
      this.failPending(ctx, new RpcError(ERR_AGENT_UNAVAILABLE, "adapter shutting down"));
    }
  }

  // -------------------------------------------------------------------------
  // ACP 请求分发
  // -------------------------------------------------------------------------

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "session/new":
        return this.sessionNew(params);
      case "session/load":
        return this.sessionLoad(params);
      case "session/prompt":
        return this.sessionPrompt(params);
      case "session/cancel":
        // 规范中 cancel 是通知；容忍 request 形式
        this.cancel((params as { sessionId: string })?.sessionId);
        return null;
      default:
        throw new RpcError(ERR_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    switch (method) {
      case "session/cancel":
        this.cancel((params as { sessionId: string })?.sessionId);
        break;
      default:
        this.config.log(`[acp] 忽略未知通知: ${method}`);
    }
  }

  private initialize(params: unknown): {
    protocolVersion: number;
    agentCapabilities: AgentCapabilities;
    agentInfo: { name: string; title: string; version: string };
    authMethods: [];
  } {
    const req = params as InitializeRequest;
    if (typeof req?.protocolVersion !== "number" || req.protocolVersion < 1) {
      throw new RpcError(ERR_INVALID_PARAMS, `unsupported protocolVersion: ${String(req?.protocolVersion)}`);
    }
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      agentInfo: { name: "dsh-acp-adapter", title: "DeepSeek Harness", version: "0.1.0" },
      authMethods: [],
    };
  }

  private async sessionNew(params: unknown): Promise<{ sessionId: string }> {
    const req = params as NewSessionRequest;
    if (!req || typeof req.cwd !== "string" || req.cwd === "") {
      throw new RpcError(ERR_INVALID_PARAMS, "session/new requires an absolute cwd");
    }
    if (!Array.isArray(req.mcpServers) || req.mcpServers.length > 0) {
      throw new RpcError(ERR_INVALID_PARAMS, "mcpServers must be [] (DSH 使用自身 MCP 客户端)");
    }
    await this.manager.ensure(req.cwd);
    let sessionId: string;
    try {
      const res = await this.client.call<{ sessionId: string }>("session.create", { cwd: req.cwd });
      sessionId = res.sessionId;
    } catch (error) {
      throw this.toRpc(error, "创建会话失败");
    }
    let ctx = this.sessions.get(sessionId);
    if (!ctx) {
      ctx = this.newCtx(sessionId, req.cwd);
      this.sessions.set(sessionId, ctx);
    }
    this.config.log(`[acp] session/new → ${sessionId}`);
    this.advertiseCommands(ctx);
    return { sessionId };
  }

  private async sessionLoad(params: unknown): Promise<null> {
    const req = params as LoadSessionRequest;
    if (!req || typeof req.sessionId !== "string" || typeof req.cwd !== "string") {
      throw new RpcError(ERR_INVALID_PARAMS, "session/load requires sessionId and cwd");
    }
    await this.manager.ensure(req.cwd);
    let ctx = this.sessions.get(req.sessionId);
    if (!ctx) {
      ctx = this.newCtx(req.sessionId, req.cwd);
      this.sessions.set(req.sessionId, ctx);
    }
    await this.replay(ctx);
    return null;
  }

  private async sessionPrompt(params: unknown): Promise<PromptResponse> {
    const req = params as PromptRequest;
    if (!req || typeof req.sessionId !== "string" || !Array.isArray(req.prompt)) {
      throw new RpcError(ERR_INVALID_PARAMS, "session/prompt requires sessionId and prompt[]");
    }
    const ctx = this.sessions.get(req.sessionId);
    if (!ctx) throw new RpcError(ERR_SESSION_NOT_FOUND, `unknown session: ${req.sessionId}`);
    await this.manager.ensure(ctx.cwd);

    let content: { type: "text"; text: string }[];
    try {
      content = req.prompt.map(promptBlockToDsh);
    } catch (error) {
      throw new RpcError(ERR_INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }

    return new Promise<PromptResponse>((resolve, reject) => {
      const pending: PendingPrompt = {
        rpcId: "",
        resolve,
        reject,
        seen: false,
        ended: false,
        stopReason: "end_turn",
        errorMessage: null,
        cancelRequested: false,
      };
      ctx.pending.push(pending);
      void (async () => {
        try {
          const rpcId = randomUuid();
          pending.rpcId = rpcId;
          await this.client.call(
            "session.prompt",
            { sessionId: req.sessionId, mode: "queue", content },
            { rpcId, timeoutMs: 30_000 }
          );
          // accepted：等待事件流驱动完成
        } catch (error) {
          const at = ctx.pending.indexOf(pending);
          if (at >= 0) ctx.pending.splice(at, 1);
          reject(this.toRpc(error, "提交提示失败"));
        }
      })();
    });
  }

  // -------------------------------------------------------------------------
  // 事件流处理
  // -------------------------------------------------------------------------

  private async onMuxFrame(rpcId: string, payload: MuxFramePayload): Promise<void> {
    if (payload.type === "session/event" && this.debug) {
      this.config.log(`[mux] ${payload.event.type} #${payload.event.seq} (${payload.sessionId.slice(0, 13)}…)`);
    }
    switch (payload.type) {
      case "session/event": {
        const ctx = this.sessions.get(payload.sessionId);
        if (!ctx) return;
        this.onSessionEvent(ctx, payload.event);
        break;
      }
      case "approval/requested": {
        const ctx = this.sessions.get(payload.sessionId);
        if (!ctx) return;
        void this.bridgeApproval(ctx, rpcId, payload);
        break;
      }
      case "question/requested": {
        const ctx = this.sessions.get(payload.sessionId);
        if (!ctx) return;
        // v1：暂不支持 elicitation，自动取消并给出可见提示
        const text = payload.questions
          .map((q) => `⚠️ Agent 提问${q.header ? `（${q.header}）` : ""}：${q.question}（当前版本自动取消）`)
          .join("\n");
        this.notifyUpdate(ctx.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
        try {
          await this.client.respond(rpcId, {}, { cancel: true });
        } catch (error) {
          this.config.log(`[acp] 取消 question 失败: ${String(error)}`);
        }
        break;
      }
      case "session/jobs":
        this.onJobs(payload.sessionId, payload.jobs);
        break;
      case "approval/resolved":
      case "session/subscribed":
      case "session/queue":
      case "session/projection":
      case "stream/error":
        break;
    }
  }

  private onHostFrame(payload: HostFramePayload): void {
    if (payload.type === "host/session-status" && !payload.running) {
      const ctx = this.sessions.get(payload.sessionId);
      if (ctx && ctx.pending.length > 0) this.settle(ctx);
    }
    if (payload.type === "host/agent-error") {
      const ctx = this.sessions.get(payload.sessionId);
      if (ctx?.active && !ctx.active.errorMessage) {
        ctx.active.errorMessage = payload.message;
      }
    }
  }

  private onSessionEvent(ctx: SessionCtx, event: { type: string; seq: number; data: unknown }): void {
    switch (event.type) {
      case "user/message": {
        const rpcId = (event.data as { source?: { rpcId?: string } })?.source?.rpcId;
        const pending = rpcId ? ctx.pending.find((p) => p.rpcId === rpcId) : ctx.pending.find((p) => !p.seen);
        if (pending && !pending.seen) {
          pending.seen = true;
          ctx.active = pending;
          ctx.turnOpen = true;
          if (ctx.settleTimer) {
            clearTimeout(ctx.settleTimer);
            ctx.settleTimer = null;
          }
        }
        break;
      }
      case "assistant/chunk": {
        const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
          const turn = (event.data as { turn?: number }).turn;
          const step = (event.data as { step?: number }).step;
          const key = `${String(turn)}:${String(step)}`;
          ctx.chunkedKeys.set(key, (ctx.chunkedKeys.get(key) ?? "") + chunk.text);
        }
        const update = chunkToUpdate(event as never);
        if (this.debug) {
          this.config.log(`[chunk] type=${chunk?.type} → update=${update === null ? "null" : update.sessionUpdate}`);
        }
        if (update) this.notifyUpdate(ctx.sessionId, update);
        break;
      }
      case "assistant/message": {
        // 实时路径以 chunk 流为准；未流式产生的消息（罕见）直接补发
        const text = textOfMessageEvent(event as never);
        if (text !== "") {
          const turn = (event.data as { turn?: number })?.turn;
          const step = (event.data as { step?: number })?.step;
          const key = `${String(turn)}:${String(step)}`;
          const seen = ctx.chunkedKeys.get(key);
          if (seen === undefined) {
            this.notifyUpdate(ctx.sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            });
          } else if (seen !== text) {
            this.notifyUpdate(ctx.sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            });
          }
          ctx.chunkedKeys.delete(key);
        }
        break;
      }
      case "tool/call": {
        const update = toolCallToUpdate(event as never);
        if (update) this.notifyUpdate(ctx.sessionId, update);
        break;
      }
      case "tool/result": {
        for (const update of toolResultToUpdates(event as never)) this.notifyUpdate(ctx.sessionId, update);
        break;
      }
      case "turn/start":
        ctx.turnOpen = true;
        break;
      case "turn/end": {
        const reason = (event.data as { reason?: { kind?: unknown } })?.reason?.kind;
        const pending = ctx.active;
        ctx.turnOpen = false;
        if (pending && !pending.ended) {
          pending.ended = true;
          pending.stopReason = turnEndToStopReason(reason);
          if (reason === "error") {
            const err = (event.data as { reason?: { error?: { code?: string; message?: string } } })?.reason
              ?.error;
            pending.errorMessage = err?.message ?? err?.code ?? "turn ended with error";
          }
          ctx.active = null;
          if (pending.cancelRequested && reason === "completed") {
            // 取消请求已发出但模型完成——尊重取消语义
            pending.stopReason = "cancelled";
          }
        }
        const running = this.streams.isRunning(ctx.sessionId);
        if (ctx.pending.length > 0) {
          if (running === false) this.settle(ctx);
          else if (!running) this.scheduleSettle(ctx);
        }
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 完成判定
  // -------------------------------------------------------------------------

  private scheduleSettle(ctx: SessionCtx): void {
    if (ctx.settleTimer) clearTimeout(ctx.settleTimer);
    ctx.settleTimer = setTimeout(() => {
      ctx.settleTimer = null;
      // goal 模式会在旧 turn 结束后开启新 turn；两秒内没有新 turn 就结算
      if (!ctx.turnOpen && ctx.pending.length > 0) this.settle(ctx);
    }, 2000);
  }

  private settle(ctx: SessionCtx): void {
    if (ctx.settleTimer) {
      clearTimeout(ctx.settleTimer);
      ctx.settleTimer = null;
    }
    const pendings = ctx.pending.splice(0);
    for (const pending of pendings) {
      if (pending.errorMessage) {
        pending.reject(new RpcError(ERR_AGENT_UNAVAILABLE, pending.errorMessage));
        continue;
      }
      pending.resolve({ stopReason: pending.stopReason });
    }
    ctx.active = null;
    ctx.turnOpen = false;
  }

  private failPending(ctx: SessionCtx, error: RpcError): void {
    const pendings = ctx.pending.splice(0);
    for (const pending of pendings) pending.reject(error);
    ctx.active = null;
  }

  // -------------------------------------------------------------------------
  // 取消
  // -------------------------------------------------------------------------

  private cancel(sessionId: string): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    const active = ctx.active;
    if (active) {
      active.cancelRequested = true;
      void this.client.call("session.cancel", { sessionId }).catch((error) => {
        this.config.log(`[acp] session.cancel 失败: ${String(error)}`);
      });
      return;
    }
    // 排队中尚未开始的 prompt：直接以 cancelled 结算
    const first = ctx.pending.find((p) => !p.seen);
    if (first) {
      first.cancelRequested = true;
      first.seen = true;
      first.ended = true;
      first.stopReason = "cancelled";
      const at = ctx.pending.indexOf(first);
      if (at >= 0) ctx.pending.splice(at, 1);
      first.resolve({ stopReason: "cancelled" });
    }
  }

  // -------------------------------------------------------------------------
  // 权限桥接
  // -------------------------------------------------------------------------

  private async bridgeApproval(
    ctx: SessionCtx,
    rpcId: string,
    payload: Extract<MuxFramePayload, { type: "approval/requested" }>
  ): Promise<void> {
    const toolCallId = payload.callId ?? payload.approvalId;
    try {
      const result = (await this.peer.request(
        "session/request_permission",
        {
          sessionId: ctx.sessionId,
          toolCall: {
            toolCallId,
            title: payload.toolName,
            kind: mapToolKind(payload.toolName),
            ...(payload.reason ? { content: [{ type: "content", content: { type: "text", text: payload.reason } }] } : {}),
          },
          options: [
            { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
            { optionId: "reject-once", name: "拒绝", kind: "reject_once" },
          ],
        },
        300_000
      )) as { outcome: RequestPermissionOutcome };
      const outcome = result.outcome;
      if (outcome.outcome === "selected" && outcome.optionId === "allow-once") {
        await this.client.respond(rpcId, { sessionId: ctx.sessionId, approvalId: payload.approvalId, outcome: "allowed-once" });
      } else if (outcome.outcome === "selected" && outcome.optionId === "reject-once") {
        await this.client.respond(rpcId, { sessionId: ctx.sessionId, approvalId: payload.approvalId, outcome: "rejected" });
      } else {
        await this.client.respond(rpcId, {}, { cancel: true });
      }
    } catch (error) {
      this.config.log(`[acp] 权限桥接失败: ${String(error)}`);
      try {
        await this.client.respond(rpcId, {}, { cancel: true });
      } catch {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------------
  // 会话重放
  // -------------------------------------------------------------------------

  private async replay(ctx: SessionCtx): Promise<void> {
    const pages: Array<Array<{ event: { type: string; seq: number; data: unknown }; view?: unknown }>> = [];
    let beforeSeq: number | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let res: { events: Array<{ event: { type: string; seq: number; data: unknown }; view?: unknown }>; hasMore: boolean };
      try {
        res = await this.client.call("session.history", {
          sessionId: ctx.sessionId,
          ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          maxMessages: 200,
        });
      } catch (error) {
        const rpc = this.toRpc(error, "读取会话历史失败");
        if (rpc.message.includes("session-not-found")) throw new RpcError(ERR_SESSION_NOT_FOUND, `会话不存在: ${ctx.sessionId}`);
        throw rpc;
      }
      if (!Array.isArray(res.events)) {
        throw new RpcError(ERR_SESSION_NOT_FOUND, `会话历史不可读: ${ctx.sessionId}`);
      }
      pages.unshift(res.events);
      if (!res.hasMore || res.events.length === 0) break;
      const minSeq = Math.min(...res.events.map((entry) => entry.event.seq));
      beforeSeq = minSeq;
    }

    const chunkedKeys = new Map<string, string>();
    for (const entry of pages.flat()) {
      const event = entry.event;
      switch (event.type) {
        case "user/message": {
          if (isUserMessageEvent(event as never)) {
            const text = textOfMessageEvent(event as never);
            if (text !== "") {
              this.notifyUpdate(ctx.sessionId, {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text },
              });
            }
          }
          break;
        }
        case "assistant/chunk": {
          const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
            const turn = (event.data as { turn?: number }).turn;
            const step = (event.data as { step?: number }).step;
            const key = `${String(turn)}:${String(step)}`;
            chunkedKeys.set(key, (chunkedKeys.get(key) ?? "") + chunk.text);
          }
          break;
        }
        case "assistant/message": {
          const text = textOfMessageEvent(event as never);
          if (text === "") break;
          const turn = (event.data as { turn?: number }).turn;
          const step = (event.data as { step?: number }).step;
          const key = `${String(turn)}:${String(step)}`;
          const chunked = chunkedKeys.get(key);
          // 优先重放 chunk 级文本；无 chunk 时用完整消息
          if (chunked === undefined) {
            this.notifyUpdate(ctx.sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            });
          } else if (chunked !== text) {
            this.notifyUpdate(ctx.sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: text.slice(chunked.length) },
            });
          }
          break;
        }
        case "tool/call": {
          const update = toolCallToUpdate(event as never);
          if (update) this.notifyUpdate(ctx.sessionId, update);
          break;
        }
        case "tool/result": {
          for (const update of toolResultToUpdates(event as never)) this.notifyUpdate(ctx.sessionId, update);
          break;
        }
        default:
          break;
      }
    }
    this.config.log(`[acp] session/load → ${ctx.sessionId} 重放完成（${pages.flat().length} 事件）`);
    this.advertiseCommands(ctx);
  }

  // -------------------------------------------------------------------------
  // jobs → 工具卡
  // -------------------------------------------------------------------------

  private onJobs(sessionId: string, jobs: Array<{ id: string; label: string; status: string }>): void {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    for (const job of jobs) {
      const toolCallId = `job-${job.id}`;
      const known = ctx.jobStatus.get(job.id);
      const status =
        job.status === "running" || job.status === "stopping"
          ? "in_progress"
          : job.status === "failed"
            ? "failed"
            : "completed";
      if (known === undefined) {
        ctx.jobStatus.set(job.id, job.status);
        this.notifyUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: job.label,
          kind: "execute",
          status,
        });
      } else if (known !== job.status) {
        ctx.jobStatus.set(job.id, job.status);
        this.notifyUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 工具方法
  // -------------------------------------------------------------------------

  private newCtx(sessionId: string, cwd: string): SessionCtx {
    return {
      sessionId,
      cwd,
      pending: [],
      active: null,
      turnOpen: false,
      jobStatus: new Map(),
      settleTimer: null,
      chunkedKeys: new Map(),
    };
  }

  private notifyUpdate(sessionId: string, update: SessionUpdate): void {
    const notification: SessionNotification = { sessionId, update };
    this.peer.notify("session/update", notification);
  }

  /** 广告 DSH 内置 slash 命令目录。 */
  private advertiseCommands(ctx: SessionCtx): void {
    for (const update of DSH_COMMANDS) {
      this.notifyUpdate(ctx.sessionId, update);
    }
  }

  private toRpc(error: unknown, fallback: string): RpcError {
    if (error instanceof RpcError) return error;
    return new RpcError(
      ERR_AGENT_UNAVAILABLE,
      `${fallback}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
