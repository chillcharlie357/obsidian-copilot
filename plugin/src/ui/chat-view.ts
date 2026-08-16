/**
 * 侧边栏聊天视图：会话列表 + 消息流 + 输入框（行内 @ / 命令选择器）。
 */
import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  TAbstractFile,
  TFolder,
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
import { appendMemory, MEMORY_FILE, readMemory } from "../service/memory.js";
import { Composer, parseMentions as parseMentionsCompat, type Mention } from "./composer.js";
import type { PickerItem } from "./picker.js";
import { renderBlocks } from "./render.js";
import type { UiBlock } from "../service/model.js";
import { uuid } from "../util.js";

export const VIEW_TYPE = "obsidian-copilot-view";

/** 内置快捷命令（动态展开，依赖当前笔记/划选内容） */
const BUILTIN_COMMANDS: PickerItem[] = [
  {
    key: "builtin:summarize-note",
    label: "/总结当前笔记",
    hint: "总结当前打开笔记的核心内容与要点",
    icon: "sparkles",
    meta: { name: "总结当前笔记" },
  },
  {
    key: "builtin:actions",
    label: "/生成行动项",
    hint: "从当前笔记提取行动项，按优先级列出",
    icon: "list-checks",
    meta: { name: "生成行动项" },
  },
  {
    key: "builtin:summarize-selection",
    label: "/总结所选",
    hint: "总结编辑器里划选的文本",
    icon: "highlighter",
    meta: { name: "总结所选" },
  },
  {
    key: "builtin:refine-selection",
    label: "/精简所选",
    hint: "精简划选文本，输出可直接替换的版本",
    icon: "wand-sparkles",
    meta: { name: "精简所选" },
  },
  {
    key: "builtin:remember",
    label: "/remember",
    hint: "把偏好/事实写入持续记忆（memory.md）",
    icon: "brain",
    meta: { name: "remember" },
  },
];

export class ChatView extends ItemView {
  private headerStatusEl!: HTMLElement;
  private headerStopEl!: HTMLElement;
  private modelSelectEl!: HTMLSelectElement;
  private threadTitleEl!: HTMLElement;
  private threadsPanelEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private composer!: Composer;
  private activeThreadId: string | null = null;
  private renderScheduled = false;
  private customCommands: CustomCommand[] = [];
  private customCommandsLoadedAt = 0;
  private contextBarEl!: HTMLElement;

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

    // 备用停止按钮：忙时显示在头部，避免与底边栏/输入区冲突
    this.headerStopEl = header.createEl("button", {
      cls: "dsh-icon-btn dsh-header-stop",
      attr: { "aria-label": "停止生成" },
    });
    setIcon(this.headerStopEl, "octagon-x");
    this.headerStopEl.hide();
    this.headerStopEl.addEventListener("click", () => this.cancel());

    // 模型选择器（DSH 后端支持；其他 agent 自动隐藏）
    this.modelSelectEl = header.createEl("select", { cls: "dsh-model-select" });
    this.modelSelectEl.createEl("option", { text: "模型…", value: "" });
    this.modelSelectEl.hide();
    this.modelSelectEl.addEventListener("change", () => void this.onModelChange());

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

    // ---------- 当前上下文 pill（跟随活动笔记） ----------
    this.contextBarEl = root.createDiv({ cls: "dsh-context-bar" });
    this.updateContextBar();

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
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateContextBar()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateContextBar()));

    // ---------- 文件拖拽：从文件树拖入即插入引用 chip ----------
    this.registerDomEvent(this.contentEl, "dragover", (ev: DragEvent) => {
      if (this.dragHasFile(ev)) {
        ev.preventDefault();
        this.contentEl.addClass("dsh-drag-over");
      }
    });
    this.registerDomEvent(this.contentEl, "dragleave", (ev: DragEvent) => {
      if (!this.contentEl.contains(ev.relatedTarget as Node | null)) {
        this.contentEl.removeClass("dsh-drag-over");
      }
    });
    this.registerDomEvent(this.contentEl, "drop", (ev: DragEvent) => {
      ev.preventDefault();
      this.contentEl.removeClass("dsh-drag-over");
      this.onDropFile(ev);
    });

    // ---------- vault 变更监听：显示 agent 修改的文件 ----------
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file, true)));

    // 预加载自定义命令，让 / 选择器首次打开就有内容
    void this.loadCustomCommands();

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
    // 立即建会话：让 agent 命令（/plan /goal …）马上出现在选择器里
    void this.ensureSessionFor(record.id, true);
  }

  /**
   * 确保 thread 有对应会话（惰性创建；已存在则绑定映射）。
   * 返回最新记录；失败时 quiet=false 会弹提示。
   */
  private async ensureSessionFor(threadId: string, quiet = false): Promise<boolean> {
    const record = this.threads.get(threadId);
    if (!record) return false;
    if (record.sessionId) {
      this.service.bindSession(threadId, record.sessionId);
      void this.refreshModels();
      return true;
    }
    try {
      const sessionId = await this.service.newSession();
      await this.threads.setSessionId(threadId, sessionId);
      this.service.bindSession(threadId, sessionId);
      return true;
    } catch (error) {
      if (!quiet) {
        new Notice(`Obsidian Copilot：创建会话失败（${error instanceof Error ? error.message : String(error)}）`);
      }
      return false;
    }
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

    // 绑定会话映射：agent 命令广告（available_commands_update）依赖它
    if (record.sessionId) {
      this.service.bindSession(threadId, record.sessionId);
      void this.refreshModels();
    }

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
    try {
      await this.doSend(rawText, mentions);
    } catch (error) {
      console.error("[obsidian-copilot] 发送失败:", error);
      new Notice(`Obsidian Copilot：发送失败（${error instanceof Error ? error.message : String(error)}）`);
      const threadId = this.activeThreadId;
      if (threadId) {
        this.service.threadState(threadId).blocks.blocks.push({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRender();
      }
      this.composer.setBusy(false);
    }
  }

  private async doSend(rawText: string, mentions: Mention[]): Promise<void> {
    const threadId = this.activeThreadId;
    console.log("[obsidian-copilot] send 开始", { threadId, len: rawText.length });
    if (!threadId) {
      console.log("[obsidian-copilot] send 中止：无活动会话");
      return;
    }
    const record = this.threads.get(threadId);
    if (!record) {
      console.log("[obsidian-copilot] send 中止：线程记录不存在");
      return;
    }

    // /remember：本地写入持续记忆
    if (await this.handleRememberCommand(rawText)) return;

    // 标题：首条消息前 30 字
    if (!record.sessionId || record.title === "新对话") {
      const title = rawText.replace(/@\[[^\]]+\]\([^)]+\)/g, "").trim().slice(0, 30) || "新对话";
      await this.threads.setTitle(threadId, title);
      this.threadTitleEl.setText(title);
      this.renderThreadList();
    }

    // 惰性建会话（正常情况下 newThread 已提前创建）
    console.log("[obsidian-copilot] send 确保会话", { sessionId: record.sessionId });
    if (!(await this.ensureSessionFor(threadId))) return;
    void this.refreshModels();
    console.log("[obsidian-copilot] send 会话就绪", { sessionId: record.sessionId });

    // 内置快捷命令 / 自定义命令展开
    const { promptText, displayText } = await this.preparePrompt(rawText);
    if (promptText === "") return;
    console.log("[obsidian-copilot] send 提交提示", { len: promptText.length });
    await this.service.sendPrompt(threadId, record.sessionId, promptText);
    this.service.appendUserBlock(threadId, displayText, mentions);
    await this.threads.touch(threadId);
    this.composer.setBusy(true);
    this.scheduleRender();
  }

  /**
   * 发送前处理：
   * - 内置快捷命令（依赖当前笔记/划选内容）动态展开
   * - 自定义命令（.obsidian-copilot/commands/*.md）：展开模板（$ARGUMENTS）
   * - 展示文本：@[名](路径) → @名（命令保持原样展示）
   */
  private async preparePrompt(rawText: string): Promise<{ promptText: string; displayText: string }> {
    const displayText = rawText.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_all, name: string) => `@${name}`);
    const match = /^\s*\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(rawText.trim());
    if (!match) return { promptText: rawText, displayText };
    const name = match[1] ?? "";
    const args = (match[2] ?? "").trim();

    // 内置快捷命令
    const builtin = this.buildBuiltinCommand(name, args);
    if (builtin) {
      return { promptText: builtin, displayText };
    }
    // 自定义命令
    const command = (await this.loadCustomCommands()).find((c) => c.name === name);
    if (!command) return { promptText: rawText, displayText };
    try {
      const content = await this.app.vault.adapter.read(command.path);
      const { body } = parseCommandMeta(content);
      return { promptText: expandTemplate(body, args), displayText };
    } catch {
      return { promptText: rawText, displayText };
    }
  }

  /** 内置快捷命令展开；不匹配返回 null。 */
  private buildBuiltinCommand(name: string, args: string): string | null {
    const file = this.app.workspace.getActiveFile();
    const mention = file ? `@[${file.basename}](${file.path})` : "";
    const tail = args !== "" ? `\n\n补充要求：${args}` : "";
    switch (name) {
      case "总结当前笔记":
        if (!file) {
          new Notice("Obsidian Copilot：当前没有打开的笔记");
          return "";
        }
        return `请总结这篇笔记的核心内容与要点，输出结构化摘要（核心论点 / 关键细节 / 待办事项）。\n\n${mention}${tail}`;
      case "生成行动项":
        if (!file) {
          new Notice("Obsidian Copilot：当前没有打开的笔记");
          return "";
        }
        return `阅读这篇笔记，提取其中的行动项与待办，按优先级列出，每条附原文依据。\n\n${mention}${tail}`;
      case "总结所选":
      case "精简所选": {
        const selection = this.getActiveSelection();
        if (!selection || selection.text.trim() === "") {
          new Notice("Obsidian Copilot：当前编辑器没有划选内容");
          return "";
        }
        const quote = selection.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        const source = selection.file
          ? `（选段来源：@[${selection.file.basename}](${selection.file.path}) 第 ${selection.fromLine}–${selection.toLine} 行）`
          : `（选段来源：第 ${selection.fromLine}–${selection.toLine} 行）`;
        const instruction =
          name === "总结所选"
            ? "针对以下划选内容，给出简明总结（3–5 条要点）。"
            : "请精简以下划选内容，保持原意与语气，输出可直接替换的版本。";
        return `${instruction}\n\n${quote}\n\n${source}${tail}`;
      }
      default:
        return null;
    }
  }

  /** 当前编辑器划选内容（含来源文件与行号）。 */
  private getActiveSelection(): { text: string; file: TFile | null; fromLine: number; toLine: number } | null {
    const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
    if (!leaf) return null;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return null;
    const editor = view.editor;
    const text = editor.getSelection().trim();
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    return { text, file: view.file, fromLine: from.line + 1, toLine: to.line + 1 };
  }

  /** /remember：本地写入持续记忆，不发送给 agent。返回 true 表示已处理。 */
  private async handleRememberCommand(rawText: string): Promise<boolean> {
    const match = /^\s*\/remember(?:\s+([\s\S]+))?$/.exec(rawText.trim());
    if (!match) return false;
    const content = (match[1] ?? "").trim();
    if (!content) {
      new Notice("Obsidian Copilot：用法 /remember 要记住的内容");
      return true;
    }
    const threadId = this.activeThreadId;
    const displayText = rawText.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_all, name: string) => `@${name}`);
    if (threadId) {
      this.service.appendUserBlock(threadId, displayText, parseMentionsCompat(rawText));
      this.service.threadState(threadId).blocks.blocks.push({
        kind: "notice",
        text: `已写入持续记忆（${MEMORY_FILE}）`,
      });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    await appendMemory(this.app.vault, `- [${stamp}] ${content}`);
    this.scheduleRender();
    return true;
  }

  private cancel(): void {
    const threadId = this.activeThreadId;
    if (!threadId) return;
    const record = this.threads.get(threadId);
    if (!record?.sessionId) return;
    this.service.cancel(threadId, record.sessionId);
  }

  // -------------------------------------------------------------------------
  // 右键划词 / 文件拖拽：把上下文插入输入框
  // -------------------------------------------------------------------------

  /** 编辑器划选文本 → 「添加到 Copilot」右键菜单入口。 */
  insertSelectionContext(file: TFile | null, selection: string, fromLine: number, toLine: number): void {
    const name = file?.basename ?? "当前笔记";
    const path = file?.path ?? "";
    const source = path === "" ? `第 ${fromLine}–${toLine} 行` : `${path} 第 ${fromLine}–${toLine} 行`;
    this.composer.insertSelectionContext(name, path, selection, source);
    this.composer.focus();
  }

  private dragHasFile(ev: DragEvent): boolean {
    const types = Array.from(ev.dataTransfer?.types ?? []);
    return types.includes("text/uri-list") || types.includes("text/plain");
  }

  private onDropFile(ev: DragEvent): void {
    const raw =
      ev.dataTransfer?.getData("text/uri-list") ??
      ev.dataTransfer?.getData("text/plain") ??
      "";
    if (!raw) return;
    const path = this.parseDroppedPath(raw);
    if (!path) {
      new Notice("Obsidian Copilot：无法识别拖入的文件");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.composer.insertMentionChip(file.basename, file.path);
      new Notice(`已添加引用：${file.basename}`);
    } else if (file instanceof TFolder) {
      this.composer.insertMentionChip(file.name, `${file.path}/`);
      new Notice(`已添加文件夹引用：${file.name}/`);
    } else {
      new Notice(`Obsidian Copilot：找不到 ${path}`);
    }
  }

  /** 解析 Obsidian 文件拖拽的 dataTransfer 内容。 */
  private parseDroppedPath(raw: string): string | null {
    const uri = raw.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
    try {
      // obsidian://open?vault=...&file=路径
      if (uri.startsWith("obsidian://")) {
        const url = new URL(uri);
        const file = url.searchParams.get("file");
        if (file) return decodeURIComponent(file);
      }
      // app://obsidian.md/<vault>/<路径>
      if (uri.startsWith("app://")) {
        const rest = decodeURIComponent(uri.slice("app://".length));
        const parts = rest.replace(/^\//, "").split("/");
        const vaultName = this.app.vault.getName();
        if (parts[0] === vaultName) parts.shift();
        return parts.join("/") || null;
      }
    } catch {
      /* fallthrough */
    }
    // 纯路径兜底
    const candidate = uri.replace(/^file:\/\//, "");
    if (candidate && !candidate.includes("://") && this.app.vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 模型选择（DSH 后端）
  // -------------------------------------------------------------------------

  private async refreshModels(): Promise<void> {
    const threadId = this.activeThreadId;
    if (!threadId) return;
    const record = this.threads.get(threadId);
    if (!record?.sessionId) return;
    const models = await this.service.agentModelsGet(record.sessionId);
    if (!models) {
      this.modelSelectEl.hide();
      return;
    }
    const previous = this.modelSelectEl.value;
    this.modelSelectEl.empty();
    for (const group of models.groups) {
      const optgroup = this.modelSelectEl.createEl("optgroup", { attr: { label: group.name ?? group.id } });
      for (const model of group.models) {
        optgroup.createEl("option", { text: model.name ?? model.id, value: `${group.id}|${model.id}` });
      }
    }
    const current = models.current;
    const currentValue = `${current.provider}|${current.model}`;
    if (![...this.modelSelectEl.querySelectorAll("option")].some((o) => o.value === currentValue)) {
      this.modelSelectEl.createEl("option", { text: `${current.provider} · ${current.model}`, value: currentValue });
    }
    this.modelSelectEl.value = currentValue || previous;
    this.modelSelectEl.show();
  }

  private async onModelChange(): Promise<void> {
    const threadId = this.activeThreadId;
    if (!threadId) return;
    const record = this.threads.get(threadId);
    if (!record?.sessionId) return;
    const value = this.modelSelectEl.value;
    if (!value) return;
    const [provider, model] = value.split("|");
    if (!provider || !model) return;
    const models = await this.service.agentModelsGet(record.sessionId);
    const current = models?.current;
    const ok = await this.service.agentModelsSet(record.sessionId, provider, model, current?.reasoningEffort);
    new Notice(ok ? `已切换模型：${provider} / ${model}（下一轮生效）` : "模型切换失败（当前 agent 不支持或未连接）");
    if (!ok) void this.refreshModels();
  }

  // -------------------------------------------------------------------------
  // 当前笔记上下文 pill
  // -------------------------------------------------------------------------

  private updateContextBar(): void {
    if (!this.contextBarEl) return;
    this.contextBarEl.empty();
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.contextBarEl.hide();
      return;
    }
    this.contextBarEl.show();
    const pill = this.contextBarEl.createEl("button", { cls: "dsh-context-pill" });
    setIcon(pill.createSpan(), "book-open");
    pill.createSpan({ text: ` ${file.basename}` });
    pill.setAttr("aria-label", `把 ${file.path} 加入对话上下文`);
    pill.addEventListener("click", () => {
      if (this.composer.containsMention(file.path)) {
        new Notice(`已在上下文中：${file.basename}`);
        return;
      }
      this.composer.insertMentionChip(file.basename, file.path);
    });
  }

  // -------------------------------------------------------------------------
  // 行内选择器数据源（@ 文件/文件夹 / slash 命令）
  // -------------------------------------------------------------------------

  private filePickerItems(): PickerItem[] {
    const pinned: PickerItem[] = [];
    const rest: PickerItem[] = [];
    // 置顶：当前笔记 + 最近笔记
    const current = this.app.workspace.getActiveFile();
    if (current) {
      pinned.push({
        key: "pinned:current",
        label: current.basename,
        hint: `当前笔记 · ${current.path}`,
        icon: "book-open",
        meta: { name: current.basename, path: current.path },
      });
    }
    const files = this.app.vault.getMarkdownFiles();
    const recent = files
      .filter((file) => file.path !== current?.path)
      .sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0))
      .slice(0, 5);
    for (const file of recent) {
      pinned.push({
        key: `pinned:recent:${file.path}`,
        label: file.basename,
        hint: `最近修改 · ${file.path}`,
        icon: "clock",
        meta: { name: file.basename, path: file.path },
      });
    }
    // 文件夹：从笔记路径推导（每个都至少含一篇笔记）
    const folders = new Map<string, number>();
    for (const file of files) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        folders.set(folder, (folders.get(folder) ?? 0) + 1);
      }
    }
    for (const [path, count] of folders.entries()) {
      rest.push({
        key: `folder:${path}`,
        label: `${path.split("/").pop() ?? path}/`,
        hint: `${path} · ${count} 篇笔记`,
        icon: "folder",
        meta: { name: path.split("/").pop() ?? path, path: `${path}/` },
      });
    }
    for (const file of files) {
      rest.push({
        key: `file:${file.path}`,
        label: file.basename,
        hint: file.path,
        icon: "file-text",
        meta: { name: file.basename, path: file.path },
      });
    }
    rest.sort((a, b) => a.label.localeCompare(b.label));
    return [...pinned, ...rest];
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
    return [...BUILTIN_COMMANDS, ...agent, ...custom];
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
    renderBlocks(this.plugin, this.messagesEl, state.blocks.blocks, this.messagesEl, {
      onFeedback: (block, direction) => void this.handleFeedback(block, direction),
    });
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
    if (state.busy) {
      this.threadTitleEl.addClass("dsh-busy");
      this.headerStopEl.show();
    } else {
      this.threadTitleEl.removeClass("dsh-busy");
      this.headerStopEl.hide();
    }
  }

  // -------------------------------------------------------------------------
  // 消息反馈（👍/👎 → 持续记忆）
  // -------------------------------------------------------------------------

  private async handleFeedback(block: UiBlock, direction: "up" | "down"): Promise<void> {
    if (block.kind !== "assistant") return;
    block.feedback = block.feedback === direction ? undefined : direction;
    this.scheduleRender();
    if (direction !== "down") return;
    new FeedbackModal(this.app, (reason) => {
      void this.writeFeedback(block, reason);
    }).open();
  }

  private async writeFeedback(block: Extract<UiBlock, { kind: "assistant" }>, reason: string): Promise<void> {
    const quote = block.text.replace(/\s+/g, " ").slice(0, 200);
    const stamp = new Date().toISOString().slice(0, 10);
    await appendMemory(this.app.vault, `- [用户反馈 ${stamp}] 对回答「${quote}」不满意：${reason}`);
    new Notice("已记录反馈到持续记忆");
  }
}

// ---------------------------------------------------------------------------
// 反馈原因弹窗
// ---------------------------------------------------------------------------

class FeedbackModal extends Modal {
  constructor(
    app: App,
    private readonly onSubmit: (reason: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("dsh-feedback");
    contentEl.createEl("h3", { text: "这条回答哪里不好？" });
    const textarea = contentEl.createEl("textarea", { cls: "dsh-feedback-input" });
    textarea.setAttr("placeholder", "例如：没有遵循我的写作风格 / 信息过时 / 格式不对…");
    const bar = contentEl.createDiv({ cls: "dsh-permission-bar" });
    const save = bar.createEl("button", { cls: "mod-cta", text: "写入持续记忆" });
    save.addEventListener("click", () => {
      const reason = textarea.value.trim();
      this.close();
      if (reason) this.onSubmit(reason);
    });
    const cancel = bar.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// 权限弹窗
// ---------------------------------------------------------------------------

class PermissionModal extends Modal {
  private decided = false;

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
        this.decided = true;
        this.onDecision("selected", option.optionId);
        this.close();
      });
    }
    const cancelButton = bar.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => {
      this.decided = true;
      this.onDecision("cancelled");
      this.close();
    });
  }

  onClose(): void {
    // 关键修复：Esc/点击外部关闭 = 明确拒绝，绝不让审批静默悬挂
    if (!this.decided) this.onDecision("cancelled");
    this.contentEl.empty();
  }
}
