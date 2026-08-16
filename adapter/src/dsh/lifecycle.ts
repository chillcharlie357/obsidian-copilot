/**
 * DSH web 服务生命周期：探测 + 按需自动启动。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { RpcError, ERR_AGENT_UNAVAILABLE } from "@dsh-obsidian/acp-core";
import { DshClient } from "./rpc.js";

export interface LifecycleConfig {
  /** 是否在 DSH 未运行时自动启动 dsh web */
  autoStart: boolean;
  /** dsh 可执行文件（默认从 PATH 解析 "dsh"） */
  dshBin: string;
  /** dsh web 端口（默认与目标一致） */
  port: number;
  /** 适配器退出时是否杀掉由它启动的 DSH 进程 */
  killOnExit: boolean;
}

export class DshServerManager {
  private child: ChildProcess | null = null;
  private spawned = false;

  constructor(
    private readonly client: DshClient,
    private readonly config: LifecycleConfig,
    private readonly log: (message: string) => void
  ) {}

  /** 确保 DSH web 可达；不可达时按配置自动启动并等待就绪。 */
  async ensure(cwd: string): Promise<{ url: string; spawned: boolean }> {
    if (await this.client.ping()) return { url: this.client.url, spawned: false };
    if (!this.config.autoStart) {
      throw new RpcError(
        ERR_AGENT_UNAVAILABLE,
        `DSH web 服务不可达（${this.client.url}）。请运行 \`dsh web --port ${this.config.port}\`，或在插件设置中开启自动启动。`
      );
    }
    await this.startServer(cwd);
    return { url: this.client.url, spawned: true };
  }

  private async startServer(cwd: string): Promise<void> {
    if (this.child) {
      // 已在启动中/运行中：等待就绪
      await this.waitHealthy();
      return;
    }
    this.log(`[lifecycle] 启动 dsh web：${this.config.dshBin} web --port ${this.config.port}（cwd=${cwd}）`);
    const child = spawn(this.config.dshBin, ["web", "--port", String(this.config.port)], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;
    this.spawned = true;
    child.stdout?.on("data", (chunk: Buffer) => this.log(`[dsh] ${chunk.toString().trimEnd()}`));
    child.stderr?.on("data", (chunk: Buffer) => this.log(`[dsh] ${chunk.toString().trimEnd()}`));
    child.on("exit", (code) => {
      this.log(`[lifecycle] dsh web 退出：code=${String(code)}`);
      this.child = null;
    });
    try {
      await this.waitHealthy();
    } catch (error) {
      this.log(`[lifecycle] dsh web 启动失败：${error instanceof Error ? error.message : String(error)}`);
      child.kill();
      this.child = null;
      throw error;
    }
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + 40_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) {
        throw new RpcError(
          ERR_AGENT_UNAVAILABLE,
          `dsh web 进程提前退出（exit=${String(this.child.exitCode)}）。请检查 dsh 是否已安装且可运行。`
        );
      }
      try {
        if (await this.client.ping(1500)) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new RpcError(
      ERR_AGENT_UNAVAILABLE,
      `等待 DSH web 就绪超时（40s）：${lastError instanceof Error ? lastError.message : "未就绪"}`
    );
  }

  /** 退出时清理：仅杀掉由本适配器启动的进程。 */
  dispose(): void {
    if (this.spawned && this.child) {
      if (this.config.killOnExit) {
        this.log("[lifecycle] 关闭由适配器启动的 dsh web");
        this.child.kill();
      } else {
        this.log("[lifecycle] 保留 dsh web 进程（killOnExit=false）");
      }
    }
    this.child = null;
  }
}
