import { App, Component, DropdownComponent, MarkdownRenderer, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type DshCopilotPlugin from "./main.js";
import { DEFAULT_SYSTEM_PROMPT, SYSTEM_PROMPT_RESET_LABEL } from "./service/preamble.js";
import { builtinDshProfile, type AgentProfile } from "./service/profiles.js";
import { uuid } from "./util.js";

export interface DshCopilotSettings {
  /** agent profile 列表（DSH 为内置预设之一，可新增任意 ACP agent） */
  profiles: AgentProfile[];
  /** 当前激活的 profile id */
  activeProfileId: string;
  /** @引用文件内嵌内容的最大字符数 */
  maxMentionChars: number;
  /** 文件夹 @ 引用最多内嵌的笔记篇数 */
  maxFolderFiles: number;
  /** 显示推理过程 */
  showReasoning: boolean;
  /** 会话首条消息前注入的 Obsidian 场景前缀（空 = 关闭） */
  systemPrompt: string;
}

export const DEFAULT_SETTINGS: DshCopilotSettings = {
  profiles: [builtinDshProfile()],
  activeProfileId: builtinDshProfile().id,
  maxMentionChars: 12000,
  maxFolderFiles: 30,
  showReasoning: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

export class DshCopilotSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: DshCopilotPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;

    // -----------------------------------------------------------------------
    // Agent Profile
    // -----------------------------------------------------------------------
    new Setting(containerEl).setName("Agent Profile").setHeading();

    const profiles = settings.profiles.length > 0 ? settings.profiles : [builtinDshProfile()];
    const active = profiles.find((p) => p.id === settings.activeProfileId) ?? profiles[0]!;

    new Setting(containerEl).setName("当前 agent").setDesc("选择要连接的 ACP agent；切换后自动重连").addDropdown((dropdown) => {
      for (const profile of profiles) dropdown.addOption(profile.id, profile.name);
      dropdown.setValue(active.id);
      dropdown.onChange(async (value) => {
        settings.activeProfileId = value;
        await this.plugin.saveSettings();
        const selected = profiles.find((p) => p.id === value);
        new Notice(`已切换到「${selected?.name ?? value}」，正在重连…`);
        await this.plugin.service.restart();
      });
    });

    for (const profile of profiles) {
      const item = new Setting(containerEl)
        .setName(profile.name)
        .setDesc(`${profile.description ?? "自定义 agent"}${profile.builtin ? "（内置预设）" : ""}`)
        .addButton((button) =>
          button.setButtonText("编辑").onClick(() => {
            new ProfileEditorModal(this.app, this.plugin, profile).open();
          })
        )
        .addButton((button) =>
          button.setButtonText("复制").onClick(async () => {
            const copy: AgentProfile = {
              ...profile,
              id: uuid(),
              name: `${profile.name}（副本）`,
              builtin: undefined,
            };
            settings.profiles.push(copy);
            settings.activeProfileId = copy.id;
            await this.plugin.saveSettings();
            new Notice(`已复制为「${copy.name}」，正在重连…`);
            await this.plugin.service.restart();
            this.display();
          })
        );
      if (!profile.builtin) {
        item.addButton((button) =>
          button.setButtonText("删除").setWarning().onClick(async () => {
            settings.profiles = settings.profiles.filter((p) => p.id !== profile.id);
            if (settings.activeProfileId === profile.id) {
              settings.activeProfileId = settings.profiles[0]?.id ?? builtinDshProfile().id;
            }
            await this.plugin.saveSettings();
            await this.plugin.service.restart();
            this.display();
          })
        );
      }
    }

    new Setting(containerEl).setName("新建 profile").setDesc("接入任意支持 ACP 的 agent（如 codex acp、zed 等），或自定义命令").addButton((button) =>
      button.setButtonText("新建").onClick(() => {
        new ProfileEditorModal(this.app, this.plugin, null).open();
      })
    );

    // -----------------------------------------------------------------------
    // Agent 能力（DSH）
    // -----------------------------------------------------------------------
    new Setting(containerEl).setName("Agent 能力").setHeading();

    const PERMISSION_LABELS: Record<string, string> = {
      "read-only": "只读（read-only）",
      "workspace-write": "工作区可写（workspace-write，推荐）",
      "danger-full-access": "完全访问（danger-full-access）",
    };
    let permissionDropdown: DropdownComponent | null = null;
    new Setting(containerEl)
      .setName("权限预设")
      .setDesc("agent 对文件系统的权限级别（DSH 全局预设）：只读 / 仅工作区（vault）可写 / 完全访问。仅 DSH 后端支持。")
      .addDropdown((dropdown) => {
        permissionDropdown = dropdown;
        for (const [value, label] of Object.entries(PERMISSION_LABELS)) dropdown.addOption(value, label);
        dropdown.setValue("workspace-write");
        dropdown.onChange(async (value) => {
          const ok = await this.plugin.service.agentPermissionSet(value);
          if (ok) new Notice(`权限预设已切换为「${PERMISSION_LABELS[value] ?? value}」`);
          else {
            new Notice("权限预设切换失败（当前 agent 不支持或未连接）");
            this.display();
          }
        });
      });
    void this.plugin.service.agentPermissionGet().then((preset) => {
      if (preset) permissionDropdown?.setValue(preset);
    });

    // -----------------------------------------------------------------------
    // 引用与上下文
    // -----------------------------------------------------------------------
    new Setting(containerEl).setName("引用与上下文").setHeading();

    new Setting(containerEl).setName("@引用内容上限").setDesc("通过 @ 引用文件时内嵌进上下文的最大字符数（超出部分 agent 可用工具自行读取）").addText((text) =>
      text
        .setPlaceholder("12000")
        .setValue(String(settings.maxMentionChars))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.maxMentionChars = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.maxMentionChars;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("文件夹引用篇数上限").setDesc("@ 引用文件夹时最多内嵌多少篇笔记（会附目录清单，超出部分 agent 可用工具自行读取）").addText((text) =>
      text
        .setPlaceholder("30")
        .setValue(String(settings.maxFolderFiles))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.maxFolderFiles = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.maxFolderFiles;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("显示推理过程").setDesc("在对话中显示模型的思考（reasoning）折叠块").addToggle((toggle) =>
      toggle.setValue(settings.showReasoning).onChange(async (value) => {
        settings.showReasoning = value;
        await this.plugin.saveSettings();
      })
    );

    // -----------------------------------------------------------------------
    // 系统提示词
    // -----------------------------------------------------------------------
    new Setting(containerEl).setName("会话系统提示词").setHeading();

    new Setting(containerEl)
    // 系统提示词卡片：预览（Markdown 渲染，默认）/ 编辑 双模式
    this.renderPromptCard(containerEl);

    new Setting(containerEl).setName(SYSTEM_PROMPT_RESET_LABEL).setDesc("将系统提示词恢复为内置默认值").addButton((button) =>
      button.setButtonText("恢复默认").onClick(async () => {
        this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        await this.plugin.saveSettings();
        this.display();
      })
    );

    new Setting(containerEl).setName("重新连接 agent").setDesc("重启当前 agent profile 进程（profile 修改后生效）").addButton((button) =>
      button.setButtonText("重启").onClick(async () => {
        await this.plugin.service.restart();
      })
    );
  }

  // -------------------------------------------------------------------------
  // 系统提示词卡片（预览 / 编辑）
  // -------------------------------------------------------------------------

  private promptChild: Component | null = null;
  private promptMode: "preview" | "edit" = "preview";

  private renderPromptCard(containerEl: HTMLElement): void {
    // 重新渲染设置页时释放上一次预览的渲染组件
    this.promptChild?.unload();
    this.promptChild = null;
    const settings = this.plugin.settings;
    const card = containerEl.createDiv({ cls: "dsh-prompt-card" });

    const head = card.createDiv({ cls: "dsh-prompt-head" });
    head.createSpan({ cls: "dsh-prompt-title", text: "系统提示词" });
    head.createSpan({ cls: "dsh-prompt-count" });
    const previewBtn = head.createEl("button", { cls: "dsh-prompt-mode-btn", text: "预览" });
    const editBtn = head.createEl("button", { cls: "dsh-prompt-mode-btn", text: "编辑" });
    const hint = head.createSpan({ cls: "dsh-prompt-head-hint", text: "每个新会话首条消息前注入，聊天界面不可见；清空 = 关闭" });

    const previewEl = card.createDiv({ cls: "dsh-prompt-preview" });
    const editEl = card.createDiv({ cls: "dsh-prompt-edit" });
    const textarea = editEl.createEl("textarea", { cls: "dsh-prompt-textarea" });
    textarea.value = settings.systemPrompt;
    textarea.setAttr("placeholder", "留空关闭注入");
    const count = (): void => {
      const value = settings.systemPrompt;
      const span = head.querySelector(".dsh-prompt-count");
      if (span) span.setText(`${value.length.toLocaleString()} 字符`);
    };
    count();

    const show = (mode: "preview" | "edit"): void => {
      this.promptMode = mode;
      previewBtn.toggleClass("is-active", mode === "preview");
      editBtn.toggleClass("is-active", mode === "edit");
      previewEl.toggleClass("dsh-hidden", mode !== "preview");
      editEl.toggleClass("dsh-hidden", mode !== "edit");
      if (mode === "preview") {
        this.renderPromptPreview(previewEl);
      } else {
        this.promptChild?.unload();
        this.promptChild = null;
      }
    };

    const save = async (): Promise<void> => {
      settings.systemPrompt = textarea.value;
      await this.plugin.saveSettings();
      count();
    };

    previewBtn.addEventListener("click", () => show("preview"));
    editBtn.addEventListener("click", () => show("edit"));
    textarea.addEventListener("input", () => void save());

    show("preview");
  }

  /** 用 Obsidian 的 Markdown 渲染器展示提示词预览（可读性优先）。 */
  private renderPromptPreview(el: HTMLElement): void {
    this.promptChild?.unload();
    this.promptChild = new Component();
    this.promptChild.load();
    el.empty();
    const text = this.plugin.settings.systemPrompt.trim();
    const markdown =
      text === ""
        ? "*（留空 = 关闭会话前缀注入）*"
        : // 提示词里的 [[wiki链接]]、![[嵌入]] 是给 agent 看的语法示例，
          // 不能被 MarkdownRenderer 解析成 vault 链接（否则会出现“嵌入未创建”）
          text.replace(/(!?)\[\[([^\]]+)\]\]/g, (_match, bang: string, inner: string) => `\`${bang}[[${inner}]]\``);
    void MarkdownRenderer.render(this.app, markdown, el, "", this.promptChild);
  }
}

// ---------------------------------------------------------------------------
// Profile 编辑弹窗
// ---------------------------------------------------------------------------

class ProfileEditorModal extends Modal {
  private nameEl!: HTMLInputElement;
  private commandEl!: HTMLTextAreaElement;

  constructor(
    app: App,
    private readonly plugin: DshCopilotPlugin,
    private readonly profile: AgentProfile | null
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("dsh-profile-editor");
    contentEl.createEl("h3", { text: this.profile ? "编辑 Agent Profile" : "新建 Agent Profile" });

    new Setting(contentEl).setName("名称").setDesc("在设置页和状态中显示的 profile 名称").addText((text) => {
      this.nameEl = text.inputEl;
      text.setPlaceholder("如：DeepSeek Harness（DSH）").setValue(this.profile?.name ?? "");
    });

    new Setting(contentEl)
      .setName("启动命令")
      .setDesc(
        "ACP agent 的启动命令（stdio 传输）。可用占位符：{adapter} 内置适配器路径、{vault} vault 根目录；路径含空格时用引号包裹。示例：node \"{adapter}\" --dsn http://127.0.0.1:3080"
      )
      .addTextArea((area) => {
        this.commandEl = area.inputEl;
        this.commandEl.rows = 5;
        this.commandEl.addClass("dsh-settings-prompt");
        area.setPlaceholder('node "{adapter}" --dsn http://127.0.0.1:3080').setValue(this.profile?.command ?? "");
      });

    if (!this.profile) {
      const template = contentEl.createDiv({ cls: "setting-item-description" });
      template.setText("常用模板：DSH 默认 / codex acp / zed --acp …");
    }

    const bar = contentEl.createDiv({ cls: "dsh-profile-actions" });
    const saveButton = bar.createEl("button", { cls: "mod-cta", text: "保存" });
    saveButton.addEventListener("click", async () => {
      const name = this.nameEl.value.trim();
      const command = this.commandEl.value.trim();
      if (!name || !command) {
        new Notice("名称与启动命令不能为空");
        return;
      }
      const settings = this.plugin.settings;
      if (this.profile) {
        this.profile.name = name;
        this.profile.command = command;
      } else {
        const created: AgentProfile = { id: uuid(), name, command };
        settings.profiles.push(created);
        settings.activeProfileId = created.id;
      }
      await this.plugin.saveSettings();
      this.close();
      new Notice(`Profile「${name}」已保存，正在重连…`);
      await this.plugin.service.restart();
      this.plugin.settingTab?.display();
    });
    const cancelButton = bar.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
