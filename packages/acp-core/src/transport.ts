/**
 * ACP stdio 传输：JSON-RPC 消息以换行符分隔，单行 JSON，禁止消息内嵌换行。
 * 见 https://agentclientprotocol.com/protocol/v1/transports
 */
import type { JsonRpcMessage } from "./types.js";

/** 增量行切分器：跨 chunk 缓冲，按 "\n" 切出完整行。 */
export class LineSplitter {
  private buffer = "";

  /** 喂入一段文本，返回切出的完整行（不含换行符）。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      lines.push(line);
    }
    return lines;
  }
}

export interface StreamLike {
  write(msg: JsonRpcMessage): void;
}

/**
 * 基于 Node 流实现的新行分隔 JSON 消息流。
 * - `send()`：序列化为单行 JSON 写入 output
 * - `messages()`：异步迭代来自 input 的已解析消息
 */
export class StdioStream {
  private splitter = new LineSplitter();
  private queue: JsonRpcMessage[] = [];
  private waiters: Array<(msg: JsonRpcMessage | "closed") => void> = [];
  private ended = false;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream
  ) {}

  start(): void {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => this.onData(chunk));
    this.input.on("end", () => this.onEnd());
    this.input.on("error", () => this.onEnd());
  }

  private onData(chunk: string): void {
    for (const line of this.splitter.push(chunk)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        // 单条损坏消息不应毁掉整个连接；忽略并继续
        continue;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    }
  }

  private onEnd(): void {
    this.ended = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter("closed");
      waiter = this.waiters.shift();
    }
  }

  send(msg: JsonRpcMessage): void {
    // 单行 JSON：把可能出现的换行转义（JSON.stringify 天然转义 \n）
    this.output.write(JSON.stringify(msg) + "\n");
  }

  /** 取下一条消息；连接关闭时 resolve "closed"。 */
  nextMessage(): Promise<JsonRpcMessage | "closed"> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve("closed");
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *messages(): AsyncGenerator<JsonRpcMessage> {
    while (true) {
      const msg = await this.nextMessage();
      if (msg === "closed") return;
      yield msg;
    }
  }
}
