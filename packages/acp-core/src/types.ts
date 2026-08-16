/**
 * ACP (Agent Client Protocol) v1 wire types.
 *
 * 依据 https://agentclientprotocol.com/protocol/overview 与官方 schema 包
 * `@zed-industries/agent-client-protocol@0.4.5` 整理。插件（Client）与
 * agent（Server）两侧共用，保证换后端时协议语义一致。
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 信封
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcOkResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcOkResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg;
}
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcOkResponse | JsonRpcErrorResponse {
  return "id" in msg && !("method" in msg);
}
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg);
}

// JSON-RPC 标准错误码
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
/** 适配器/agent 侧自定义错误：DSH 后端不可达 */
export const ERR_AGENT_UNAVAILABLE = -32001;
/** 会话不存在 */
export const ERR_SESSION_NOT_FOUND = -32002;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// initialize / authenticate
// ---------------------------------------------------------------------------

export interface ImplementationInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface FileSystemCapability {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface ClientCapabilities {
  fs?: FileSystemCapability;
  terminal?: boolean;
  _meta?: Record<string, unknown>;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  _meta?: Record<string, unknown>;
}

export interface AuthMethod {
  id: string;
  name?: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: ImplementationInfo;
  _meta?: Record<string, unknown>;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: ImplementationInfo;
  authMethods?: AuthMethod[];
  _meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export type SessionId = string;

export interface McpServer {
  name: string;
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http transport
  url?: string;
  headers?: Record<string, string>;
}

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
  _meta?: Record<string, unknown>;
}
export interface NewSessionResponse {
  sessionId: SessionId;
}

export interface LoadSessionRequest {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
  _meta?: Record<string, unknown>;
}
/** session/load 响应：null（历史经由 session/update 重放） */

// ---------------------------------------------------------------------------
// 内容块（与 MCP 兼容）
// ---------------------------------------------------------------------------

export interface ContentText {
  type: "text";
  text: string;
  annotations?: unknown;
}
export interface ContentImage {
  type: "image";
  data: string;
  mimeType: string;
  uri?: string;
  annotations?: unknown;
}
export interface ContentAudio {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: unknown;
}
export interface ContentResource {
  type: "resource";
  resource: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
    annotations?: unknown;
  };
}
export interface ContentResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  title?: string;
  description?: string;
  size?: number;
  annotations?: unknown;
}
export type ContentBlock =
  | ContentText
  | ContentImage
  | ContentAudio
  | ContentResource
  | ContentResourceLink;

// ---------------------------------------------------------------------------
// Prompt 轮次
// ---------------------------------------------------------------------------

export interface PromptRequest {
  sessionId: SessionId;
  prompt: ContentBlock[];
  _meta?: Record<string, unknown>;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface PromptResponse {
  stopReason: StopReason;
  _meta?: Record<string, unknown>;
}

export interface CancelNotification {
  sessionId: SessionId;
}

// ---------------------------------------------------------------------------
// session/update 通知
// ---------------------------------------------------------------------------

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; terminalId: string };

export interface ToolCallUpdate {
  toolCallId: string;
  status?: ToolCallStatus | null;
  title?: string | null;
  content?: ToolCallContent[] | null;
  kind?: ToolKind | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
  _meta?: Record<string, unknown>;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ({
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind?: ToolKind;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      locations?: ToolCallLocation[];
      rawInput?: Record<string, unknown>;
      rawOutput?: Record<string, unknown>;
    } & { _meta?: Record<string, unknown> })
  | ({ sessionUpdate: "tool_call_update" } & ToolCallUpdate)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface AvailableCommand {
  name: string;
  description: string;
  input?: unknown | null;
}

export interface SessionNotification {
  sessionId: SessionId;
  update: SessionUpdate;
}

// ---------------------------------------------------------------------------
// Client（插件）侧方法：权限 / 文件系统 / 终端
// ---------------------------------------------------------------------------

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  _meta?: Record<string, unknown>;
}

export type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome;
  _meta?: Record<string, unknown>;
}

export interface ReadTextFileRequest {
  sessionId: SessionId;
  path: string;
  line?: number | null;
  limit?: number | null;
  _meta?: Record<string, unknown>;
}
export interface ReadTextFileResponse {
  content: string;
}

export interface WriteTextFileRequest {
  sessionId: SessionId;
  path: string;
  content: string;
  _meta?: Record<string, unknown>;
}
/** fs/write_text_file 响应：null */

export interface CreateTerminalRequest {
  sessionId: SessionId;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface CreateTerminalResponse {
  terminalId: string;
}

// ---------------------------------------------------------------------------
// 方法名常量
// ---------------------------------------------------------------------------

export const METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSelectPlan: "session/select_plan",
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalRelease: "terminal/release",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
} as const;

export const NOTIFICATIONS = {
  sessionUpdate: "session/update",
  elicitationComplete: "elicitation/complete",
} as const;

export const ACP_PROTOCOL_VERSION = 1;
