/**
 * 块渲染：把 UiBlock[] 渲染到容器（完整重渲染，由视图层节流）。
 */
import { MarkdownRenderer, setIcon, TFile } from "obsidian";
import type DshCopilotPlugin from "../main.js";
import type { UiBlock } from "../service/model.js";
import { escapeHtml } from "../util.js";
import type { ToolCallContent } from "@dsh-obsidian/acp-core";

const TOOL_ICONS: Record<string, string> = {
  read: "file-text",
  edit: "file-pen",
  delete: "trash",
  move: "folder-input",
  search: "search",
  execute: "terminal",
  think: "brain",
  fetch: "globe",
  other: "wrench",
};
const DEFAULT_TOOL_ICON = "wrench";

const TOOL_KIND_LABEL: Record<string, string> = {
  read: "读取",
  edit: "修改",
  delete: "删除",
  move: "移动",
  search: "搜索",
  execute: "执行",
  think: "思考",
  fetch: "获取",
  other: "工具",
};

export function renderBlocks(
  plugin: DshCopilotPlugin,
  container: HTMLElement,
  blocks: UiBlock[],
  _scrollEl: HTMLElement
): void {
  container.empty();
  for (const block of blocks) renderBlock(plugin, container, block);
}

function renderBlock(plugin: DshCopilotPlugin, container: HTMLElement, block: UiBlock): void {
  switch (block.kind) {
    case "user": {
      const wrap = container.createDiv({ cls: "dsh-msg dsh-user" });
      const bubble = wrap.createDiv({ cls: "dsh-bubble" });
      bubble.createEl("div", { cls: "dsh-user-text", text: block.text });
      if (block.refs.length > 0) {
        const refs = wrap.createDiv({ cls: "dsh-refs" });
        for (const ref of block.refs) {
          const chip = refs.createEl("span", { cls: "dsh-ref-chip" });
          chip.setText(`📎 ${ref.path}`);
        }
      }
      break;
    }
    case "assistant": {
      const wrap = container.createDiv({ cls: "dsh-msg dsh-assistant" });
      const content = wrap.createDiv({ cls: "dsh-markdown" });
      if (block.text.trim() === "") {
        content.createDiv({ cls: "dsh-streaming-hint", text: block.done ? "" : "思考中…" });
      }
      void MarkdownRenderer.render(
        plugin.app,
        block.text,
        content,
        "",
        plugin.renderingComponent()
      );
      break;
    }
    case "thought": {
      const details = container.createEl("details", { cls: "dsh-thought" });
      const summary = details.createEl("summary");
      setIcon(summary.createSpan(), "brain");
      summary.createSpan({ text: " 推理过程" });
      const pre = details.createEl("pre", { cls: "dsh-thought-body" });
      pre.setText(block.text);
      break;
    }
    case "tool":
      renderTool(plugin, container, block);
      break;
    case "plan": {
      const planEl = container.createDiv({ cls: "dsh-plan" });
      planEl.createEl("div", { cls: "dsh-plan-title", text: "📋 执行计划" });
      for (const entry of block.entries) {
        const row = planEl.createDiv({ cls: "dsh-plan-row" });
        const icon = row.createSpan({ cls: `dsh-plan-icon dsh-plan-${entry.status}` });
        icon.setText(entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "…" : "·");
        row.createSpan({ text: entry.content, cls: "dsh-plan-content" });
      }
      break;
    }
    case "file-change": {
      const row = container.createDiv({ cls: "dsh-file-change" });
      setIcon(row.createSpan(), "file-pen");
      row.createSpan({ text: ` 修改了 ${block.path}` });
      row.addEventListener("click", async () => {
        const file = plugin.app.vault.getAbstractFileByPath(block.path);
        if (file instanceof TFile) {
          await plugin.app.workspace.getLeaf(false).openFile(file);
        }
      });
      break;
    }
    case "error": {
      const row = container.createDiv({ cls: "dsh-error" });
      row.createSpan({ text: `⚠️ ${block.message}` });
      break;
    }
  }
}

function renderTool(plugin: DshCopilotPlugin, container: HTMLElement, block: Extract<UiBlock, { kind: "tool" }>): void {
  const details = container.createEl("details", { cls: "dsh-tool" });
  if (block.status === "in_progress" || block.status === "pending") details.open = false;
  const summary = details.createEl("summary", { cls: "dsh-tool-summary" });
  const iconSpan = summary.createSpan({ cls: "dsh-tool-icon" });
  setIcon(iconSpan, TOOL_ICONS[block.toolKind] ?? DEFAULT_TOOL_ICON);
  summary.createSpan({ cls: "dsh-tool-kind", text: TOOL_KIND_LABEL[block.toolKind] ?? "工具" });
  summary.createSpan({ cls: "dsh-tool-title", text: block.title });
  const status = summary.createSpan({ cls: `dsh-tool-status dsh-tool-${block.status}` });
  status.setText(block.status === "in_progress" ? "运行中" : block.status === "pending" ? "等待" : block.status === "failed" ? "失败" : "完成");

  const body = details.createDiv({ cls: "dsh-tool-body" });
  if (block.rawInput !== undefined) {
    const pre = body.createEl("pre", { cls: "dsh-tool-json" });
    pre.setText(JSON.stringify(block.rawInput, null, 2).slice(0, 4000));
  }
  for (const content of block.content) {
    renderToolContent(plugin, body, content);
  }
}

function renderToolContent(plugin: DshCopilotPlugin, body: HTMLElement, content: ToolCallContent): void {
  switch (content.type) {
    case "content": {
      const block = content.content;
      if (block.type === "text") {
        const pre = body.createEl("pre", { cls: "dsh-tool-text" });
        pre.setText(block.text);
      }
      break;
    }
    case "diff": {
      const diff = body.createDiv({ cls: "dsh-diff" });
      diff.createEl("div", { cls: "dsh-diff-path", text: content.path });
      if (content.oldText !== undefined) {
        const oldEl = diff.createEl("pre", { cls: "dsh-diff-old" });
        oldEl.setText(content.oldText);
      }
      const newEl = diff.createEl("pre", { cls: "dsh-diff-new" });
      newEl.setText(content.newText);
      break;
    }
    case "terminal":
      break;
  }
}
