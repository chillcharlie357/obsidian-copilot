/**
 * DSH web API 客户端（unary RPC over HTTP）。
 * 协议：POST /api/<method>，信封 {type:"client-request", rpcId, method, payload:{args}}
 * 响应：{type:"server-response", rpcId, result:{ok, value} | {ok:false, error:{code,message,details}}}
 */
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { RpcError, ERR_AGENT_UNAVAILABLE, ERR_INTERNAL } from "@dsh-obsidian/acp-core";

export interface DshRpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface DshTarget {
  host: string;
  port: number;
}

export function parseDsn(dsn: string): DshTarget {
  const url = new URL(dsn);
  const port = url.port ? Number(url.port) : 80;
  if (url.protocol !== "http:") throw new Error(`dsn 必须是 http:// URL: ${dsn}`);
  return { host: url.hostname || "127.0.0.1", port };
}

export class DshClient {
  constructor(private readonly target: DshTarget, private readonly timeoutMs = 30_000) {}

  get url(): string {
    return `http://${this.target.host}:${this.target.port}`;
  }

  /** 探测服务是否可用（host.describe）。 */
  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      await this.call("host.describe", {}, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** 执行 unary RPC；业务错误抛 RpcError（code 为 DSH 错误码）。 */
  async call<T = unknown>(
    method: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; rpcId?: string } = {}
  ): Promise<T> {
    const rpcId = opts.rpcId ?? randomUUID();
    const envelope = {
      type: "client-request",
      rpcId,
      method,
      // 注意：API-proxy 路由的 payload 是扁平的业务参数（无 args 包装），
      // 与 Typert 网关路由（{args}）不同。session.* 等均属前者。
      payload: args,
    };
    const raw = await this.post(`/api/${method}`, envelope, opts.timeoutMs ?? this.timeoutMs);
    let parsed: {
      rpcId?: string;
      result?: { ok?: boolean; value?: unknown; error?: DshRpcError };
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (error) {
      throw new RpcError(ERR_INTERNAL, `DSH 响应不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.rpcId !== rpcId) throw new RpcError(ERR_INTERNAL, `DSH rpcId 不匹配: ${String(parsed.rpcId)} != ${rpcId}`);
    const result = parsed.result;
    if (!result) throw new RpcError(ERR_INTERNAL, "DSH 响应缺少 result");
    if (result.ok !== true || result.error) {
      const err = result.error ?? { code: "internal", message: "DSH 未知错误" };
      throw new RpcError(ERR_INTERNAL, `${err.code}: ${err.message}`, err.details);
    }
    return result.value as T;
  }

  /** 应答 approval / question 请求（rpcId 必须回显服务端请求的 rpcId）。 */
  async respond(
    rpcId: string,
    value: Record<string, unknown>,
    opts: { cancel?: boolean } = {}
  ): Promise<void> {
    const envelope = {
      type: "client-response",
      rpcId,
      result: opts.cancel
        ? { ok: false, error: { code: "cancelled", message: "cancelled by adapter" } }
        : { ok: true, value },
    };
    const raw = await this.post("/api/respond", envelope, this.timeoutMs);
    const parsed = JSON.parse(raw) as { accepted?: boolean; reason?: string };
    if (parsed.accepted !== true) {
      throw new RpcError(ERR_INTERNAL, `DSH respond 被拒绝: ${parsed.reason ?? "unknown"}`);
    }
  }

  private post(path: string, body: unknown, timeoutMs: number): Promise<string> {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: this.target.host,
          port: this.target.port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": payload.byteLength,
            connection: "keep-alive",
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode && res.statusCode >= 400) {
              reject(new RpcError(ERR_INTERNAL, `DSH HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
              return;
            }
            resolve(text);
          });
        }
      );
      req.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const hint = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(message)
          ? "DSH web 服务不可达（请确认 dsh web 正在运行，或启用适配器自动启动）"
          : message;
        reject(new RpcError(ERR_AGENT_UNAVAILABLE, hint));
      });
      req.on("timeout", () => {
        req.destroy(new Error(`DSH 请求超时（${timeoutMs}ms）: ${path}`));
      });
      req.end(payload);
    });
  }
}
