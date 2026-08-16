/**
 * Obsidian Copilot — Obsidian 插件入口。
 * 通过 ACP（Agent Client Protocol）连接 agent：
 * 内置 DSH 预设（dsh-acp-adapter → DeepSeek Harness），也支持任意 ACP agent profile。
 */
import { Component, FileSystemAdapter, MarkdownView, Plugin, TFile, setIcon } from "obsidian";
import { AcpService } from "./service/acp-service.js";
import { ThreadStore } from "./service/threads.js";
import { ChatView, VIEW_TYPE } from "./ui/chat-view.js";
import { DEFAULT_SETTINGS, DshCopilotSettingTab, type DshCopilotSettings } from "./settings.js";
import { builtinDshProfile, migrateLegacyDshProfile } from "./service/profiles.js";

export default class DshCopilotPlugin extends Plugin {
  declare settings: DshCopilotSettings;
  threads!: ThreadStore;
  service!: AcpService;
  settingTab!: DshCopilotSettingTab;
  vaultRoot = "";
  adapterPath = "";
  private mdComponent: Component | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.threads = new ThreadStore(this);
    await this.threads.load();

    const adapter = this.app.vault.adapter;
    this.vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
    this.adapterPath = `${this.vaultRoot}/${this.app.vault.configDir}/plugins/${this.manifest.id}/adapter.cjs`;

    this.mdComponent = new Component();
    this.mdComponent.load();

    this.service = new AcpService(this.app, this.settings, this.adapterPath, this.vaultRoot);
    await this.service.start();

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon("bot", "打开 Obsidian Copilot", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-obsidian-copilot",
      name: "打开 Obsidian Copilot 侧边栏",
      callback: () => void this.activateView(),
    });

    this.settingTab = new DshCopilotSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // 编辑器划词 → 右键菜单「添加到 Copilot」
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = editor.getSelection().trim();
        if (!selection) return;
        menu.addItem((item) => {
          item
            .setTitle("添加到 Copilot")
            .setIcon("bot")
            .onClick(async () => {
              await this.activateView();
              const from = editor.getCursor("from");
              const to = editor.getCursor("to");
              const chatView = this.getChatView();
              const file = view.file instanceof TFile ? view.file : null;
              chatView?.insertSelectionContext(file, selection, from.line + 1, to.line + 1);
            });
        });
      })
    );

    // 阅读视图：划选文本右键 → 注入「添加到 Copilot」菜单项
    // （Obsidian 没有阅读视图的菜单 API，采用 DOM 注入方式）
    this.registerDomEvent(document, "contextmenu", (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest(".markdown-preview-view, .markdown-rendered")) return;
      const selection = window.getSelection()?.toString().trim() ?? "";
      if (!selection) return;
      this.injectReadingViewMenu(selection);
    });

    // 命令面板兜底：编辑/阅读视图都可用
    this.addCommand({
      id: "add-selection-to-copilot",
      name: "将所选内容添加到 Copilot",
      checkCallback: (checking) => {
        const sel = this.getAnySelection();
        if (checking) return sel.text.trim() !== "";
        void (async () => {
          await this.activateView();
          const chatView = this.getChatView();
          chatView?.insertSelectionContext(sel.file, sel.text, sel.fromLine, sel.toLine);
        })();
        return true;
      },
    });

    // 若启动即空闲则自动打开侧边栏
    this.app.workspace.onLayoutReady(() => {
      void this.activateView();
    });
  }

  /** 阅读视图右键菜单注入：等 Obsidian 渲染出 .menu 后追加菜单项。 */
  private injectReadingViewMenu(selection: string): void {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const menu = document.querySelector(".menu");
      if (menu && !menu.querySelector(".dsh-menu-item")) {
        this.appendReadingMenuItems(menu, selection);
        clearInterval(timer);
      } else if (attempts > 8) {
        clearInterval(timer);
      }
    }, 30);
  }

  private appendReadingMenuItems(menu: Element, selection: string): void {
    const host = menu as unknown as HTMLElement;
    const separator = host.createDiv({ cls: "menu-separator" });
    const item = host.createDiv({ cls: "menu-item dsh-menu-item" });
    const icon = item.createSpan({ cls: "menu-item-icon" });
    setIcon(icon, "bot");
    item.createDiv({ cls: "menu-item-title", text: "添加到 Copilot" });
    item.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      void (async () => {
        await this.activateView();
        const chatView = this.getChatView();
        chatView?.insertSelectionContext(file, selection, 0, 0);
      })();
    });
    void separator;
  }

  /** 通用选区获取：编辑视图用 editor，阅读视图用 window.getSelection。 */
  private getAnySelection(): { text: string; file: TFile | null; fromLine: number; toLine: number } {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.getMode() === "source") {
      const editor = activeView.editor;
      const text = editor.getSelection().trim();
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      return { text, file: activeView.file, fromLine: from.line + 1, toLine: to.line + 1 };
    }
    const text = window.getSelection()?.toString().trim() ?? "";
    return { text, file: activeView?.file ?? this.app.workspace.getActiveFile(), fromLine: 0, toLine: 0 };
  }

  onunload(): void {
    this.service?.dispose();
    this.mdComponent?.unload();
  }

  renderingComponent(): Component {
    return this.mdComponent ?? new Component();
  }

  /** 取当前（或新建的）聊天视图实例。 */
  getChatView(): ChatView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const view = leaf?.view;
    return view instanceof ChatView ? view : null;
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Record<string, unknown> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
    // 旧版 DSH 硬编码设置 → 迁移为 profile（一次性）
    const profiles = this.settings.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
      const legacy = stored as {
        dsn?: string;
        autoStartDsh?: boolean;
        dshBin?: string;
        killDshOnExit?: boolean;
      } | null;
      const migrated =
        legacy && (legacy.dsn !== undefined || legacy.autoStartDsh !== undefined || legacy.dshBin !== undefined || legacy.killDshOnExit !== undefined)
          ? migrateLegacyDshProfile(legacy)
          : builtinDshProfile();
      this.settings.profiles = [migrated];
      this.settings.activeProfileId = migrated.id;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

export type { DshCopilotSettings };
