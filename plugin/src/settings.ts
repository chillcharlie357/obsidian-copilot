import { App, PluginSettingTab, Setting } from "obsidian";
import type DshCopilotPlugin from "./main.js";
import { DEFAULT_SYSTEM_PROMPT, SYSTEM_PROMPT_RESET_LABEL } from "./service/preamble.js";

export interface DshCopilotSettings {
  /** DSH web API 地址（传给适配器） */
  dsn: string;
  /** DSH 未运行时自动启动 dsh web */
  autoStartDsh: boolean;
  /** dsh 可执行文件（留空自动探测） */
  dshBin: string;
  /** node 可执行文件（留空自动探测，GUI 启动时 PATH 里通常没有） */
  nodeBin: string;
  /** 适配器退出时关闭由它启动的 DSH */
  killDshOnExit: boolean;
  /** @引用文件内嵌内容的最大字符数 */
  maxMentionChars: number;
  /** 显示推理过程 */
  showReasoning: boolean;
  /** 会话首条消息前注入的 Obsidian 场景前缀（空 = 关闭） */
  systemPrompt: string;
}

export const DEFAULT_SETTINGS: DshCopilotSettings = {
  dsn: "http://127.0.0.1:3080",
  autoStartDsh: true,
  dshBin: "",
  nodeBin: "",
  killDshOnExit: true,
  maxMentionChars: 12000,
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

    new Setting(containerEl).setName("DSH 服务地址").setDesc("DSH web API 的 HTTP 地址（ACP 适配器通过它连接 DeepSeek Harness）").addText((text) =>
      text
        .setPlaceholder("http://127.0.0.1:3080")
        .setValue(settings.dsn)
        .onChange(async (value) => {
          settings.dsn = value.trim() || DEFAULT_SETTINGS.dsn;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("自动启动 DSH").setDesc("DSH 未运行时，由适配器自动在后台启动 dsh web（工作目录为当前 vault）").addToggle((toggle) =>
      toggle.setValue(settings.autoStartDsh).onChange(async (value) => {
        settings.autoStartDsh = value;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("dsh 可执行文件").setDesc("用于自动启动的 dsh 命令路径；留空自动探测（Homebrew/pnpm 等常见位置）").addText((text) =>
      text
        .setPlaceholder("自动探测（如 /opt/homebrew/bin/dsh）")
        .setValue(settings.dshBin)
        .onChange(async (value) => {
          settings.dshBin = value.trim();
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("node 可执行文件").setDesc("运行适配器用的 node 路径；留空自动探测，找不到时回退到 Electron Node 模式").addText((text) =>
      text
        .setPlaceholder("自动探测（如 /opt/homebrew/bin/node）")
        .setValue(settings.nodeBin)
        .onChange(async (value) => {
          settings.nodeBin = value.trim();
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("退出时关闭 DSH").setDesc("插件卸载/禁用时，是否关闭由适配器启动的 DSH 进程（不影响手动启动的服务）").addToggle((toggle) =>
      toggle.setValue(settings.killDshOnExit).onChange(async (value) => {
        settings.killDshOnExit = value;
        await this.plugin.saveSettings();
      })
    );

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

    new Setting(containerEl).setName("显示推理过程").setDesc("在对话中显示模型的思考（reasoning）折叠块").addToggle((toggle) =>
      toggle.setValue(settings.showReasoning).onChange(async (value) => {
        settings.showReasoning = value;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl)
      .setName("会话系统提示词")
      .setDesc("在每个新会话的第一条消息前注入（聊天界面不可见）。针对 Obsidian 场景优化 agent 行为；清空即关闭注入。")
      .addTextArea((area) => {
        area
          .setPlaceholder("留空关闭注入")
          .setValue(settings.systemPrompt)
          .onChange(async (value) => {
            settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        area.inputEl.rows = 12;
        area.inputEl.cols = 50;
        area.inputEl.addClass("dsh-settings-prompt");
      });

    new Setting(containerEl).setName(SYSTEM_PROMPT_RESET_LABEL).setDesc("将系统提示词恢复为内置默认值").addButton((button) =>
      button.setButtonText("恢复默认").onClick(async () => {
        settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        await this.plugin.saveSettings();
        this.display();
      })
    );

    new Setting(containerEl).setName("重新连接 agent").setDesc("重启 ACP 适配器进程（设置修改后生效）").addButton((button) =>
      button.setButtonText("重启").onClick(async () => {
        await this.plugin.service.restart();
      })
    );
  }
}
