/**
 * ACP 服务：管理 agent 子进程（dsh-acp-adapter）、完成 initialize 握手、
 * 分发 session/update、处理 agent 发起的 fs/权限请求。
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  Peer,
  StdioStream,
  RpcError,
  ERR_METHOD_NOT_FOUND,
  ACP_PROTOCOL_VERSION,
  type AgentCapabilities,
  type AvailableCommand,
  type ContentBlock,
  type PermissionOption,
  type PromptResponse,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
} from "@dsh-obsidian/acp-core";
import { Notice, type App } from "obsidian";
import { applyUpdate, emptyThread, finishStreaming, type ThreadBlocks } from "./model.js";
import { isPathInside, normalizePathAbs, relativeTo } from "../util.js";
import { electronNodeFallback, resolveDshBin, resolveNodeBin } from "./bins.js";

export type ServiceStatus = "idle" | "starting" | "ready" | "offline";

export interface PermissionRequestInfo {
  sessionId: string;
  toolCallId: string;
  title: string;
  reason?: string;
  options: PermissionOption[];
  resolve: (outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }) => void;
}

export interface AcpSettings {
  dsn: string;
  autoStartDsh: boolean;
  dshBin: string;
  nodeBin: string;
  killDshOnExit: boolean;
  maxMentionChars: number;
  /** 会话首条消息前注入的 Obsidian 场景前缀（空 = 关闭） */
  systemPrompt: string;
}

type Listener = (event: string, payload: unknown) => void;

export class AcpService {
  private child: ChildProcess | null = null;
  private peer: Peer | null = null;
  private status: ServiceStatus = "idle";
  private capabilities: AgentCapabilities | null = null;
  private restartAttempts = 0;
  private disposed = false;
  private listeners = new Set<Listener>();
  private permissionQueue: PermissionRequestInfo[] = [];
  /** threadId → 渲染状态 */
  readonly threadStates = new Map<string, { blocks: ThreadBlocks; busy: boolean; replaying: boolean; commands: AvailableCommand[]; primed: boolean }>();

  constructor(
    private readonly app: App,
    private readonly settings: AcpSettings,
    private readonly adapterPath: string,
    private readonly vaultRoot: string
  ) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch (error) {
        console.error("[obsidian-copilot] listener error", error);
      }
    }
  }

  getStatus(): ServiceStatus {
    return this.status;
  }

  getCapabilities(): AgentCapabilities | null {
    return this.capabilities;
  }

  threadState(threadId: string): { blocks: ThreadBlocks; busy: boolean; replaying: boolean; commands: AvailableCommand[]; primed: boolean } {
    let state = this.threadStates.get(threadId);
    if (!state) {
      state = { blocks: emptyThread(), busy: false, replaying: false, commands: [], primed: false };
      this.threadStates.set(threadId, state);
    }
    return state;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.disposed = false;
    await this.startAdapter();
  }

  async restart(): Promise<void> {
    this.stopAdapter();
    this.restartAttempts = 0;
    await this.startAdapter();
  }

  private async startAdapter(): Promise<void> {
    this.setStatus("starting");

    // node 二进制解析：GUI 启动的 Obsidian PATH 里通常没有 Homebrew
    let command = resolveNodeBin(this.settings.nodeBin);
    let env = { ...process.env };
    if (!command) {
      const fallback = electronNodeFallback();
      command = fallback.command;
      env = fallback.env;
      console.log("[obsidian-copilot] 未找到 node，回退到 ELECTRON_RUN_AS_NODE");
    }
    const dshBin = resolveDshBin(this.settings.dshBin) ?? this.settings.dshBin ?? "dsh";

    const child = spawn(
      command,
      [
        this.adapterPath,
        "--dsn",
        this.settings.dsn,
        "--auto-start-dsh",
        this.settings.autoStartDsh ? "true" : "false",
        "--dsh-bin",
        dshBin,
        "--kill-dsh-on-exit",
        this.settings.killDshOnExit ? "true" : "false",
      ],
      { stdio: ["pipe", "pipe", "pipe"], env }
    );
    this.child = child;
    const stream = new StdioStream(child.stdout, child.stdin);
    const peer = new Peer(stream, { requestTimeoutMs: 0 });
    this.peer = peer;
    this.registerRequestHandlers(peer);
    this.registerNotificationHandler(peer);
    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trimEnd();
      if (line) console.log("[dsh-acp-adapter]", line);
    });
    child.on("exit", (code) => {
      console.log(`[obsidian-copilot] adapter 退出 code=${String(code)}`);
      this.child = null;
      this.peer = null;
      if (this.disposed) {
        this.setStatus("idle");
        return;
      }
      if (this.restartAttempts < 3) {
        this.restartAttempts += 1;
        this.setStatus("starting");
        setTimeout(() => {
          if (!this.disposed) void this.startAdapter();
        }, 2000 * this.restartAttempts);
      } else {
        this.setStatus("offline");
        new Notice("Obsidian Copilot：agent 进程多次退出，已停止重试（可在设置中调整后重启）");
      }
    });
    peer.start();
    try {
      const result = (await peer.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
          clientInfo: { name: "obsidian-copilot", title: "Obsidian Copilot", version: "0.1.0" },
        },
        10_000
      )) as { protocolVersion: number; agentCapabilities?: AgentCapabilities; agentInfo?: unknown };
      this.capabilities = result.agentCapabilities ?? null;
      this.restartAttempts = 0;
      this.setStatus("ready");
      this.emit("agent-info", result.agentInfo ?? {});
    } catch (error) {
      console.error("[obsidian-copilot] initialize 失败:", error);
      this.stopAdapter();
      this.setStatus("offline");
      new Notice(`Obsidian Copilot：无法连接 agent（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  private stopAdapter(): void {
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
    this.peer = null;
  }

  dispose(): void {
    this.disposed = true;
    // 拒绝所有等待中的权限请求
    for (const pending of this.permissionQueue.splice(0)) {
      pending.resolve({ outcome: "cancelled" });
    }
    this.stopAdapter();
  }

  private setStatus(status: ServiceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  // -------------------------------------------------------------------------
  // 会话管理
  // -------------------------------------------------------------------------

  private ensurePeer(): Peer {
    if (!this.peer || this.status !== "ready") {
      throw new RpcError(-32001, "agent 未连接");
    }
    return this.peer;
  }

  async newSession(): Promise<string> {
    const peer = this.ensurePeer();
    const result = (await peer.request("session/new", { cwd: this.vaultRoot, mcpServers: [] }, 60_000)) as {
      sessionId: string;
    };
    return result.sessionId;
  }

  async loadSession(sessionId: string): Promise<void> {
    const peer = this.ensurePeer();
    await peer.request("session/load", { sessionId, cwd: this.vaultRoot, mcpServers: [] }, 120_000);
    // 已有历史的会话无需再注入会话前缀
    const threadId = this.threadIdForSession(sessionId);
    if (threadId) this.threadState(threadId).primed = true;
  }

  /**
   * 发送提示：解析 @ 引用并构造 ACP prompt 块（展示文本由 UI 层另行渲染）。
   * 会话首条消息前注入 Obsidian 场景前缀（system prompt，聊天 UI 不可见）。
   */
  async sendPrompt(threadId: string, sessionId: string, rawText: string): Promise<void> {
    const peer = this.ensurePeer();
    const state = this.threadState(threadId);
    state.busy = true;

    const { prompt } = await this.buildPrompt(rawText);
    const systemPrompt = this.settings.systemPrompt?.trim() ?? "";
    if (!state.primed && systemPrompt !== "") {
      prompt.unshift({ type: "text", text: systemPrompt });
      state.primed = true;
    }
    const promise = peer.request(
      "session/prompt",
      { sessionId, prompt },
      0 // 无超时：长任务由 agent 自己控制；取消走 session/cancel
    );
    void promise
      .then((result) => {
        const stop = (result as PromptResponse).stopReason;
        const blocks = finishStreaming(state.blocks);
        state.blocks = blocks;
        state.busy = false;
        this.emit("prompt-done", { threadId, sessionId, stopReason: stop });
      })
      .catch((error) => {
        state.busy = false;
        state.blocks = {
          blocks: [...state.blocks.blocks, { kind: "error", message: error instanceof Error ? error.message : String(error) }],
          streaming: false,
        };
        this.emit("prompt-error", { threadId, sessionId, message: error instanceof Error ? error.message : String(error) });
      });
  }

  cancel(threadId: string, sessionId: string): void {
    const peer = this.ensurePeer();
    peer.notify("session/cancel", { sessionId });
    this.emit("prompt-cancelling", { threadId, sessionId });
  }

  // -------------------------------------------------------------------------
  // 提示构造（@ 引用 → embedded resource）
  // -------------------------------------------------------------------------

  private async buildPrompt(rawText: string): Promise<{ prompt: ContentBlock[] }> {
    // @[名称](相对路径)
    const mentionRe = /@\[([^\]]+)\]\(([^)]+)\)/g;
    const mentions: Array<{ name: string; path: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRe.exec(rawText)) !== null) {
      mentions.push({ name: match[1] ?? "", path: match[2] ?? "" });
    }
    const text = rawText.replace(mentionRe, (_all, name) => `@${name}`);

    const prompt: ContentBlock[] = [{ type: "text", text }];
    const embedded = this.capabilities?.promptCapabilities?.embeddedContext !== false;
    for (const mention of mentions) {
      const absolute = this.resolveVaultPath(mention.path);
      if (!absolute) continue;
      try {
        const content = await this.app.vault.adapter.read(mention.path);
        const truncated = content.length > this.settings.maxMentionChars
          ? `${content.slice(0, this.settings.maxMentionChars)}\n…[内容过长已截断，agent 可自行读取完整文件]`
          : content;
        if (embedded) {
          prompt.push({
            type: "resource",
            resource: {
              uri: `file://${absolute}`,
              mimeType: "text/markdown",
              text: truncated,
            },
          });
        } else {
          prompt.push({
            type: "text",
            text: `<context path="${mention.path}">\n${truncated}\n</context>`,
          });
        }
      } catch (error) {
        prompt.push({
          type: "text",
          text: `<context-error path="${mention.path}">无法读取：${error instanceof Error ? error.message : String(error)}</context-error>`,
        });
      }
    }
    return { prompt };
  }

  /** vault 相对路径 → 绝对路径（无 vault 信息时用 vaultRoot 拼接） */
  resolveVaultPath(relative: string): string | null {
    try {
      return `${this.vaultRoot}/${relative}`.replace(/\/+/g, "/");
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // agent → client 请求处理
  // -------------------------------------------------------------------------

  private registerRequestHandlers(peer: Peer): void {
    peer.setRequestHandler((method, params) => {
      switch (method) {
        case "session/request_permission":
          return this.handlePermission(params as RequestPermissionRequest);
        case "fs/read_text_file":
          return this.handleReadFile(params as ReadTextFileRequest);
        case "fs/write_text_file":
          return this.handleWriteFile(params as WriteTextFileRequest);
        default:
          throw new RpcError(ERR_METHOD_NOT_FOUND, `client method not supported: ${method}`);
      }
    });
  }

  private registerNotificationHandler(peer: Peer): void {
    peer.setNotificationHandler((method, params) => {
      if (method === "session/update") {
        const notification = params as SessionNotification;
        const threadId = this.threadIdForSession(notification.sessionId);
        if (notification.update.sessionUpdate === "available_commands_update") {
          if (!threadId) {
            // 会话刚创建、映射尚未建立：先缓存，bindSession 时补发
            this.pendingCommands.set(notification.sessionId, notification.update.availableCommands);
            return;
          }
          this.threadState(threadId).commands = notification.update.availableCommands;
          this.emit("update", { threadId, sessionId: notification.sessionId });
          return;
        }
        if (!threadId) return;
        const state = this.threadState(threadId);
        if (notification.update.sessionUpdate === "user_message_chunk") state.primed = true;
        state.blocks = applyUpdate(state.blocks, notification.update, { replaying: state.replaying });
        this.emit("update", { threadId, sessionId: notification.sessionId });
      }
    });
  }

  private threadIdForSession(sessionId: string): string | null {
    // 由 UI 层注册映射
    return this.sessionToThread.get(sessionId) ?? null;
  }

  readonly sessionToThread = new Map<string, string>();
  /** 等待映射的命令广告（session/new 竞态窗口） */
  private readonly pendingCommands = new Map<string, AvailableCommand[]>();

  async handlePermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const tool = request.toolCall;
    const reasonText = tool.content
      ?.filter((c): c is Extract<typeof c, { type: "content" }> => c.type === "content")
      .map((c) => (c.content.type === "text" ? c.content.text : ""))
      .join("\n");
    const info: PermissionRequestInfo = {
      sessionId: request.sessionId,
      toolCallId: tool.toolCallId,
      title: tool.title ?? "未知工具",
      reason: reasonText || undefined,
      options: request.options,
      resolve: () => undefined,
    };
    return new Promise<RequestPermissionResponse>((resolve) => {
      info.resolve = (outcome) => {
        resolve({ outcome });
      };
      this.permissionQueue.push(info);
      this.emit("permission", info);
    });
  }

  /** UI 层回答权限请求 */
  answerPermission(info: PermissionRequestInfo, outcome: "selected" | "cancelled", optionId?: string): void {
    const at = this.permissionQueue.indexOf(info);
    if (at >= 0) this.permissionQueue.splice(at, 1);
    if (outcome === "cancelled") info.resolve({ outcome: "cancelled" });
    else info.resolve({ outcome: "selected", optionId: optionId ?? "reject-once" });
  }

  private async handleReadFile(request: ReadTextFileRequest): Promise<{ content: string }> {
    const rel = this.assertVaultPath(request.path);
    let content = await this.app.vault.adapter.read(rel);
    const line = request.line;
    const limit = request.limit;
    if (line != null && limit != null && limit > 0) {
      const lines = content.split("\n");
      content = lines.slice(Math.max(0, line - 1), Math.max(0, line - 1) + limit).join("\n");
    }
    return { content };
  }

  private async handleWriteFile(request: WriteTextFileRequest): Promise<null> {
    const rel = this.assertVaultPath(request.path);
    const adapter = this.app.vault.adapter;
    const slash = rel.lastIndexOf("/");
    if (slash > 0) {
      const dir = rel.slice(0, slash);
      if (!(await adapter.exists(dir))) await this.app.vault.createFolder(dir).catch(() => undefined);
    }
    await adapter.write(rel, request.content);
    return null;
  }

  private assertVaultPath(absolute: string): string {
    const normalized = normalizePathAbs(absolute);
    if (!isPathInside(normalized, this.vaultRoot)) {
      throw new RpcError(-32602, `路径不在 vault 内: ${absolute}`);
    }
    return relativeTo(normalized, this.vaultRoot);
  }

  /** 便捷：为 thread 注册 session 映射 */
  bindSession(threadId: string, sessionId: string): void {
    this.sessionToThread.set(sessionId, threadId);
    // 补发绑定前到达的命令广告
    const pending = this.pendingCommands.get(sessionId);
    if (pending) {
      this.pendingCommands.delete(sessionId);
      this.threadState(threadId).commands = pending;
      this.emit("update", { threadId, sessionId });
    }
  }

  /** 便捷：本地追加用户消息块 */
  appendUserBlock(threadId: string, text: string, refs: Array<{ name: string; path: string }>): void {
    const state = this.threadState(threadId);
    state.blocks.blocks.push({ kind: "user", text, refs });
    this.emit("update", { threadId, sessionId: this.sessionToThread.get(threadId) });
  }
}
