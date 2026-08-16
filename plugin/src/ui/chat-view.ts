/**
 * 侧边栏聊天视图：会话列表 + 消息流 + 输入框（行内 @ / 命令选择器）。
 */
import {
  App,
  ItemView,
  Modal,
  Notice,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { PermissionOption } from "@dsh-obsidian/acp-core";
import type DshCopilotPlugin from "../main.js";
import type { PermissionRequestInfo, ServiceStatus } from "../service/acp-service.js";
import { ThreadStore } from "../service/threads.js";
import {
  COMMANDS_DIR,
  expandTemplate,
  listCustomCommands,
  parseCommandMeta,
  type CustomCommand,
} from "../service/commands.js";
import { Composer, type Mention } from "./composer.js";
import type { PickerItem } from "./picker.js";
import { renderBlocks } from "./render.js";
import { uuid } from "../util.js";

export const VIEW_TYPE = "obsidian-copilot-view";

export class ChatView extends ItemView {
  private headerStatusEl!: HTMLElement;
  private threadTitleEl!: HTMLElement;
  private threadsPanelEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private composer!: Composer;
  private activeThreadId: string | null = null;
  private renderScheduled = false;
  private customCommands: CustomCommand[] = [];
  private customCommandsLoadedAt = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: DshCopilotPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Obsidian Copilot";
  }

  getIcon(): string {
    return "bot";
  }

  private get service() {
    return this.plugin.service;
  }

  private get threads(): ThreadStore {
    return this.plugin.threads;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.addClass("dsh-copilot");
    root.empty();

    // ---------- 头部 ----------
    const header = root.createDiv({ cls: "dsh-header" });
    const newButton = header.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "新建对话" } });
    setIcon(newButton, "plus");
    newButton.addEventListener("click", () => void this.newThread());

    this.threadTitleEl = header.createDiv({ cls: "dsh-title" });
    this.threadTitleEl.setText("Obsidian Copilot");

    this.headerStatusEl = header.createDiv({ cls: "dsh-status" });
    this.headerStatusEl.setAttr("data-state", "idle");

    const listButton = header.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "会话列表" } });
    setIcon(listButton, "history");
    listButton.addEventListener("click", () => {
      const hidden = this.threadsPanelEl.hasClass("dsh-hidden");
      this.threadsPanelEl.toggleClass("dsh-hidden", !hidden);
      if (!hidden) this.renderThreadList();
    });

    // ---------- 会话列表 ----------
    this.threadsPanelEl = root.createDiv({ cls: "dsh-threads-panel dsh-hidden" });

    // ---------- 消息区 ----------
    this.messagesEl = root.createDiv({ cls: "dsh-messages" });

    // ---------- 输入区 ----------
    const composerWrap = root.createDiv({ cls: "dsh-composer" });
    this.composer = new Composer(composerWrap, this.plugin, {
      onSubmit: (text, mentions) => void this.send(text, mentions),
      onStop: () => this.cancel(),
      onCommandSelected: () => undefined,
      providers: {
        files: () => this.filePickerItems(),
        commands: () => this.commandPickerItems(),
      },
    });

    // ---------- 事件 ----------
    this.register(this.service.on((event, payload) => this.onServiceEvent(event, payload)));

    // ---------- vault 变更监听：显示 agent 修改的文件 ----------
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file, true)));

    try {
      await this.activateThread(this.threads.activeThreadId ?? this.threads.list()[0]?.id ?? null);
    } catch (error) {
      console.error("[obsidian-copilot] 激活会话失败:", error);
      new Notice(`Obsidian Copilot：会话加载失败（${error instanceof Error ? error.message : String(error)}）`);
    }
    this.renderThreadList();
  }

  // -------------------------------------------------------------------------
  // 服务事件
  // -------------------------------------------------------------------------

  private onServiceEvent(event: string, payload: unknown): void {
    switch (event) {
      case "status":
        this.headerStatusEl.setAttr("data-state", payload as ServiceStatus);
        break;
      case "update": {
        const { threadId } = payload as { threadId: string };
        if (threadId === this.activeThreadId) this.scheduleRender();
        break;
      }
      case "prompt-done":
      case "prompt-error": {
        const { threadId } = payload as { threadId: string };
        if (threadId === this.activeThreadId) {
          this.scheduleRender();
          this.composer.setBusy(this.service.threadState(threadId).busy);
        }
        break;
      }
      case "prompt-cancelling": {
        const { threadId } = payload as { threadId: string };
        if (threadId === this.activeThreadId) this.scheduleRender();
        break;
      }
      case "permission":
        this.showPermissionModal(payload as PermissionRequestInfo);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // vault 变更
  // -------------------------------------------------------------------------

  private onVaultChange(file: TAbstractFile, deleted = false): void {
    this.invalidateCustomCommands(file);
    if (!this.activeThreadId) return;
    const state = this.service.threadState(this.activeThreadId);
    if (!state.busy) return;
    const path = file.path;
    const blocks = state.blocks.blocks;
    const last = blocks[blocks.length - 1];
    if (last?.kind === "file-change" && last.path === path && !deleted) return;
    blocks.push({ kind: "file-change", path: deleted ? `${path}（已删除）` : path });
    this.scheduleRender();
  }

  // -------------------------------------------------------------------------
  // 会话管理
  // -------------------------------------------------------------------------

  private async newThread(): Promise<void> {
    const record = await this.threads.create(uuid(), "", "新对话");
    this.activeThreadId = record.id;
    this.service.threadState(record.id);
    this.threadTitleEl.setText(record.title);
    this.scheduleRender();
    this.renderThreadList();
    this.composer.setBusy(false);
    this.composer.focus();
  }

  private async activateThread(threadId: string | null): Promise<void> {
    if (!threadId) {
      await this.newThread();
      return;
    }
    this.activeThreadId = threadId;
    const record = this.threads.get(threadId);
    if (!record) {
      await this.newThread();
      return;
    }
    this.threadTitleEl.setText(record.title);
    this.composer.setBusy(this.service.threadState(threadId).busy);

    const state = this.service.threadState(threadId);
    if (state.blocks.blocks.length > 0 || !record.sessionId) {
      this.scheduleRender();
      return;
    }
    // 重放历史
    state.replaying = true;
    this.composer.setBusy(true);
    this.scheduleRender();
    try {
      await this.service.loadSession(record.sessionId);
    } catch (error) {
      state.blocks = {
        blocks: [...state.blocks.blocks, { kind: "error", message: error instanceof Error ? error.message : String(error) }],
        streaming: false,
      };
      new Notice(`Obsidian Copilot：会话加载失败（${error instanceof Error ? error.message : String(error)}）`);
    } finally {
      state.replaying = false;
      this.composer.setBusy(state.busy);
      this.scheduleRender();
    }
  }

  private renderThreadList(): void {
    this.threadsPanelEl.empty();
    const list = this.threads.list();
    for (const record of list) {
      const row = this.threadsPanelEl.createDiv({
        cls: `dsh-thread-row${record.id === this.activeThreadId ? " dsh-thread-active" : ""}`,
      });
      row.createDiv({ cls: "dsh-thread-name", text: record.title || "未命名对话" });
      row.createDiv({ cls: "dsh-thread-date", text: new Date(record.updatedAt).toLocaleString() });
      row.addEventListener("click", () => {
        void this.threads.setActive(record.id);
        this.threadsPanelEl.addClass("dsh-hidden");
        void this.activateThread(record.id);
      });
      const del = row.createEl("button", { cls: "dsh-icon-btn dsh-thread-del", attr: { "aria-label": "删除会话" } });
      setIcon(del, "trash");
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await this.threads.remove(record.id);
        if (this.activeThreadId === record.id) {
          this.activeThreadId = null;
          await this.activateThread(this.threads.list()[0]?.id ?? null);
        }
        this.renderThreadList();
      });
    }
    if (list.length === 0) {
      this.threadsPanelEl.createDiv({ cls: "dsh-thread-empty", text: "暂无对话" });
    }
  }

  // -------------------------------------------------------------------------
  // 发送 / 取消
  // -------------------------------------------------------------------------

  private async send(rawText: string, mentions: Mention[]): Promise<void> {
    const threadId = this.activeThreadId;
    if (!threadId) return;
    const record = this.threads.get(threadId);
    if (!record) return;

    // 标题：首条消息前 30 字
    if (!record.sessionId || record.title === "新对话") {
      const title = rawText.replace(/@\[[^\]]+\]\([^)]+\)/g, "").trim().slice(0, 30) || "新对话";
      await this.threads.setTitle(threadId, title);
      this.threadTitleEl.setText(title);
      this.renderThreadList();
    }

    // 惰性建会话
    if (!record.sessionId) {
      try {
        const sessionId = await this.service.newSession();
        await this.threads.setSessionId(threadId, sessionId);
        this.service.bindSession(threadId, sessionId);
      } catch (error) {
        new Notice(`Obsidian Copilot：创建会话失败（${error instanceof Error ? error.message : String(error)}）`);
        return;
      }
    }

    // 自定义命令展开：模板在客户端执行，agent 命令原样发送（如 /plan）
    const { promptText, displayText } = await this.preparePrompt(rawText);
    await this.service.sendPrompt(threadId, record.sessionId, promptText);
    this.service.appendUserBlock(threadId, displayText, mentions);
    await this.threads.touch(threadId);
    this.composer.setBusy(true);
    this.scheduleRender();
  }

  /**
   * 发送前处理：
   * - 自定义命令（.obsidian-copilot/commands/*.md）：展开模板（$ARGUMENTS）
   * - 展示文本：@[名](路径) → @名（命令保持原样展示）
   */
  private async preparePrompt(rawText: string): Promise<{ promptText: string; displayText: string }> {
    const displayText = rawText.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_all, name: string) => `@${name}`);
    const match = /^\s*\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(rawText.trim());
    if (!match) return { promptText: rawText, displayText };
    const name = match[1] ?? "";
    const command = (await this.loadCustomCommands()).find((c) => c.name === name);
    if (!command) return { promptText: rawText, displayText };
    try {
      const content = await this.app.vault.adapter.read(command.path);
      const { body } = parseCommandMeta(content);
      const args = (match[2] ?? "").trim();
      return { promptText: expandTemplate(body, args), displayText };
    } catch {
      return { promptText: rawText, displayText };
    }
  }

  private cancel(): void {
    const threadId = this.activeThreadId;
    if (!threadId) return;
    const record = this.threads.get(threadId);
    if (!record?.sessionId) return;
    this.service.cancel(threadId, record.sessionId);
  }

  // -------------------------------------------------------------------------
  // 行内选择器数据源（@ 文件 / slash 命令）
  // -------------------------------------------------------------------------

  private filePickerItems(): PickerItem[] {
    return this.app.vault
      .getMarkdownFiles()
      .map((file) => ({
        key: `file:${file.path}`,
        label: file.basename,
        hint: file.path,
        icon: "file-text",
        meta: { name: file.basename, path: file.path },
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  private commandPickerItems(): PickerItem[] {
    const threadId = this.activeThreadId ?? "";
    const agent: PickerItem[] = this.service.threadState(threadId).commands.map((command) => ({
      key: `agent:${command.name}`,
      label: `/${command.name}`,
      hint: command.input?.hint ? `${command.description} · ${command.input.hint}` : command.description,
      icon: "bot",
      meta: { name: command.name, hint: command.input?.hint },
    }));
    const custom: PickerItem[] = this.customCommands.map((command) => ({
      key: `custom:${command.name}`,
      label: `/${command.name}`,
      hint: command.description || "自定义命令",
      icon: "terminal",
      meta: { name: command.name },
    }));
    return [...agent, ...custom];
  }

  /** 加载 vault 自定义命令（5 秒缓存）。 */
  private async loadCustomCommands(): Promise<CustomCommand[]> {
    if (Date.now() - this.customCommandsLoadedAt > 5000) {
      this.customCommands = await listCustomCommands(this.app.vault);
      this.customCommandsLoadedAt = Date.now();
    }
    return this.customCommands;
  }

  /** vault 内自定义命令目录发生变化时使缓存失效。 */
  private invalidateCustomCommands(file: TAbstractFile): void {
    if (file.path.startsWith(`${COMMANDS_DIR}/`)) {
      this.customCommandsLoadedAt = 0;
    }
  }

  // -------------------------------------------------------------------------
  // 权限弹窗
  // -------------------------------------------------------------------------

  private showPermissionModal(info: PermissionRequestInfo): void {
    new PermissionModal(this.app, info, info.options, (outcome, optionId) => {
      this.plugin.service.answerPermission(info, outcome, optionId);
    }).open();
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  private render(): void {
    const threadId = this.activeThreadId;
    if (!threadId) return;
    const state = this.service.threadState(threadId);
    renderBlocks(this.plugin, this.messagesEl, state.blocks.blocks, this.messagesEl);
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
    if (state.busy) this.threadTitleEl.addClass("dsh-busy");
    else this.threadTitleEl.removeClass("dsh-busy");
  }
}

// ---------------------------------------------------------------------------
// 权限弹窗
// ---------------------------------------------------------------------------

class PermissionModal extends Modal {
  constructor(
    app: App,
    private readonly info: PermissionRequestInfo,
    private readonly options: PermissionOption[],
    private readonly onDecision: (outcome: "selected" | "cancelled", optionId?: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("dsh-permission");
    contentEl.createEl("h3", { text: "Agent 请求权限" });
    contentEl.createEl("div", { cls: "dsh-permission-title", text: this.info.title });
    if (this.info.reason) {
      contentEl.createEl("pre", { cls: "dsh-permission-reason", text: this.info.reason });
    }
    const bar = contentEl.createDiv({ cls: "dsh-permission-bar" });
    for (const option of this.options) {
      const button = bar.createEl("button", {
        cls: option.kind.startsWith("allow") ? "mod-cta" : "",
        text: option.name,
      });
      button.addEventListener("click", () => {
        this.onDecision("selected", option.optionId);
        this.close();
      });
    }
    const cancelButton = bar.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => {
      this.onDecision("cancelled");
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
