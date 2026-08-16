/**
 * 会话 UI 状态模型：把 ACP session/update 通知折叠为可渲染的块序列。
 * 纯函数实现，便于测试与重放（session/load 重放与实时流共用同一套规则）。
 */
import type {
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
  ToolCallStatus,
} from "@dsh-obsidian/acp-core";

export interface RefChip {
  name: string;
  path: string;
}

export type UiBlock =
  | { kind: "user"; text: string; refs: RefChip[] }
  | { kind: "assistant"; text: string; done: boolean; feedback?: "up" | "down" }
  | { kind: "thought"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      content: ToolCallContent[];
      rawInput?: Record<string, unknown>;
    }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "file-change"; path: string }
  | { kind: "notice"; text: string }
  | { kind: "error"; message: string };

export interface ThreadBlocks {
  blocks: UiBlock[];
  /** 是否有未完成的助手消息（用于流式渲染） */
  streaming: boolean;
}

export function emptyThread(): ThreadBlocks {
  return { blocks: [], streaming: false };
}

function lastBlock(blocks: UiBlock[]): UiBlock | undefined {
  return blocks[blocks.length - 1];
}

function textOfContent(content: unknown): string {
  const c = content as { type?: string; text?: string } | undefined;
  if (c?.type === "text" && typeof c.text === "string") return c.text;
  return "";
}

/**
 * 应用一个 ACP update。opts.replaying 时（session/load 重放）每条
 * agent_message_chunk 都视为完整消息（新建块，不追加）。
 */
export function applyUpdate(
  state: ThreadBlocks,
  update: SessionUpdate,
  opts: { replaying?: boolean } = {}
): ThreadBlocks {
  const blocks = state.blocks;
  const push = (block: UiBlock): void => {
    blocks.push(block);
  };

  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      push({ kind: "user", text: textOfContent(update.content), refs: [] });
      break;
    }
    case "agent_message_chunk": {
      const text = textOfContent(update.content);
      if (text === "") break;
      const last = lastBlock(blocks);
      if (!opts.replaying && last?.kind === "assistant" && !last.done) {
        last.text += text;
      } else {
        push({ kind: "assistant", text, done: opts.replaying === true });
      }
      state.streaming = !opts.replaying;
      break;
    }
    case "agent_thought_chunk": {
      const text = textOfContent(update.content);
      if (text === "") break;
      const last = lastBlock(blocks);
      if (last?.kind === "thought") last.text += text;
      else push({ kind: "thought", text });
      break;
    }
    case "tool_call": {
      push({
        kind: "tool",
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: update.kind ?? "other",
        status: update.status ?? "pending",
        content: [],
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
      });
      break;
    }
    case "tool_call_update": {
      const tool = blocks.find((b): b is Extract<UiBlock, { kind: "tool" }> => b.kind === "tool" && b.toolCallId === update.toolCallId);
      if (tool) {
        if (update.status != null && update.status !== undefined) tool.status = update.status;
        if (update.title != null && update.title !== undefined) tool.title = update.title;
        if (update.kind != null && update.kind !== undefined) tool.toolKind = update.kind;
        if (update.content != null && update.content !== undefined) tool.content = update.content;
        if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
      }
      break;
    }
    case "plan": {
      const at = blocks.findIndex((b) => b.kind === "plan");
      if (at >= 0) blocks.splice(at, 1);
      if (update.entries.length > 0) push({ kind: "plan", entries: update.entries });
      break;
    }
    case "available_commands_update":
    case "current_mode_update":
      // v1 暂不渲染
      break;
  }
  return { blocks, streaming: state.streaming };
}

/** 流式结束：把未完成的助手块标记为完成。 */
export function finishStreaming(state: ThreadBlocks): ThreadBlocks {
  for (const block of state.blocks) {
    if (block.kind === "assistant" && !block.done) block.done = true;
  }
  return { blocks: state.blocks, streaming: false };
}
