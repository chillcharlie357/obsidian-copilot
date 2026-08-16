/**
 * DSH 会话事件 → ACP session/update 的映射层。
 */
import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolKind,
} from "@dsh-obsidian/acp-core";
import type { DshSessionEvent } from "./mux.js";

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

export function truncate(text: string, max = 8000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截断 ${text.length - max} 字符]`;
}

interface DshBlock {
  type?: string;
  text?: unknown;
}

/** 从 DSH 消息 content 数组中提取纯文本。 */
export function textOfMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const b = block as DshBlock;
        if (!b || typeof b !== "object") return "";
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .join("");
  }
  return "";
}

/** 提取消息事件（user/message 或 assistant/message）的文本。 */
export function textOfMessageEvent(event: DshSessionEvent): string {
  const data = event.data as { message?: { content?: unknown }; content?: unknown };
  const content = data.message?.content ?? data.content;
  return textOfMessageContent(content);
}

export function isUserMessageEvent(event: DshSessionEvent): boolean {
  const source = (event.data as { source?: { kind?: string } } | undefined)?.source;
  return source?.kind === "user";
}

// ---------------------------------------------------------------------------
// 工具元数据
// ---------------------------------------------------------------------------

const TOOL_KIND_MAP: Record<string, ToolKind> = {
  bash: "execute",
  str_replace_editor: "edit",
  write: "edit",
  edit: "edit",
  read: "read",
  glob: "read",
  grep: "read",
  web_search: "search",
  web_fetch: "fetch",
  skill: "other",
  todo_write: "other",
  ask_user_question: "other",
};

export function mapToolKind(toolName: string): ToolKind {
  return TOOL_KIND_MAP[toolName] ?? "other";
}

/** 提取工具名中的主参数，用于展示标题。 */
export function titleOfTool(toolName: string, args: Record<string, unknown> | undefined): string {
  const primaryKey: Record<string, string> = {
    bash: "command",
    str_replace_editor: "command",
    write: "file_path",
    edit: "file_path",
    read: "file_path",
    web_search: "query",
    web_fetch: "url",
    glob: "pattern",
    grep: "pattern",
    todo_write: "",
  };
  const key = primaryKey[toolName];
  if (!key || !args) return toolName;
  const value = args[key];
  if (typeof value !== "string" || value === "") return toolName;
  return `${toolName}: ${truncate(value, 80)}`;
}

// ---------------------------------------------------------------------------
// DSH 事件 → ACP 更新
// ---------------------------------------------------------------------------

/** assistant/chunk → agent_message_chunk / agent_thought_chunk（或 null） */
export function chunkToUpdate(event: DshSessionEvent): SessionUpdate | null {
  if (event.type !== "assistant/chunk") return null;
  const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
  if (!chunk) return null;
  if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") {
    return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk.text } };
  }
  if (chunk.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text !== "") {
    return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk.text } };
  }
  return null;
}

/** tool/call → tool_call */
export function toolCallToUpdate(event: DshSessionEvent): SessionUpdate | null {
  if (event.type !== "tool/call") return null;
  const data = event.data as { name?: string; arguments?: string; callId?: string };
  const name = typeof data.name === "string" ? data.name : "tool";
  const callId = typeof data.callId === "string" ? data.callId : `tool-${event.seq}`;
  let rawInput: Record<string, unknown> | undefined;
  if (typeof data.arguments === "string" && data.arguments !== "") {
    try {
      rawInput = JSON.parse(data.arguments) as Record<string, unknown>;
    } catch {
      rawInput = { arguments: data.arguments };
    }
  }
  return {
    sessionUpdate: "tool_call",
    toolCallId: callId,
    title: titleOfTool(name, rawInput),
    kind: mapToolKind(name),
    status: "pending",
    ...(rawInput !== undefined ? { rawInput } : {}),
    _meta: { toolName: name },
  };
}

/** tool/result → tool_call_update（一条结果消息可能包含多个并行工具调用块） */
export function toolResultToUpdates(event: DshSessionEvent): SessionUpdate[] {
  if (event.type !== "tool/result") return [];
  const message = (event.data as { message?: { content?: unknown } }).message;
  const blocks = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const updates: SessionUpdate[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    if (block.type !== "tool-result") continue;
    const toolCallId = typeof block.toolCallId === "string" ? block.toolCallId : `tool-${event.seq}`;
    const isError = block.isError === true;
    const rawContent = block.content;
    let content: ToolCallContent[] | undefined;
    if (rawContent !== undefined && rawContent !== null) {
      const text = textOfMessageContent(rawContent);
      content = [{ type: "content", content: { type: "text", text: truncate(text) } }];
    }
    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: isError ? "failed" : "completed",
      ...(content !== undefined ? { content } : {}),
    });
  }
  return updates;
}

/** turn/end reason → ACP StopReason */
export function turnEndToStopReason(kind: unknown): StopReason {
  switch (kind) {
    case "completed":
    case "blocked":
      return "end_turn";
    case "aborted":
    case "interrupted":
      return "cancelled";
    case "max-tokens":
      return "max_tokens";
    case "error":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** ACP prompt 内容块 → DSH prompt content 部件（只支持文本语义）。 */
export function promptBlockToDsh(block: ContentBlock): { type: "text"; text: string } {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "resource": {
      const text = block.resource.text ?? "";
      const header = `<embedded-resource uri="${block.resource.uri}">`;
      return { type: "text", text: `${header}\n${text}\n</embedded-resource>` };
    }
    case "resource_link": {
      return {
        type: "text",
        text: `<referenced-resource uri="${block.uri}" name="${block.name}"/>`,
      };
    }
    case "image":
    case "audio":
    default:
      throw new Error(`不支持的提示内容类型: ${String((block as ContentBlock).type)}`);
  }
}
