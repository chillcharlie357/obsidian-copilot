/**
 * Obsidian Copilot — Obsidian 插件入口。
 * 通过 ACP（Agent Client Protocol）连接 agent：
 * 内置 DSH 预设（dsh-acp-adapter → DeepSeek Harness），也支持任意 ACP agent profile。
 */
import { Component, FileSystemAdapter, Plugin } from "obsidian";
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

    // 若启动即空闲则自动打开侧边栏
    this.app.workspace.onLayoutReady(() => {
      void this.activateView();
    });
  }

  onunload(): void {
    this.service?.dispose();
    this.mdComponent?.unload();
  }

  renderingComponent(): Component {
    return this.mdComponent ?? new Component();
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
