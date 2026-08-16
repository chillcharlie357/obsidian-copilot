/**
 * dsh-acp-adapter 入口：ACP server over stdio ↔ DSH web API。
 *
 * 用法：
 *   node dsh-acp-adapter.cjs [--dsn http://127.0.0.1:3080] [--auto-start-dsh true]
 *                           [--dsh-bin dsh] [--kill-dsh-on-exit true]
 */
import { Peer, StdioStream } from "@dsh-obsidian/acp-core";
import { AcpServer, type AdapterConfig } from "./acp-server.js";

interface CliArgs {
  dsn: string;
  autoStartDsh: boolean;
  dshBin: string;
  killDshOnExit: boolean;
  debug: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dsn: "http://127.0.0.1:3080",
    autoStartDsh: true,
    dshBin: "dsh",
    killDshOnExit: true,
    debug: false,
  };
  const take = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    if (at >= 0 && at + 1 < argv.length) {
      const value = argv[at + 1] ?? "";
      argv.splice(at, 2);
      return value;
    }
    if (at >= 0) argv.splice(at, 1);
    return null;
  };
  while (argv.length > 0) {
    const flag = argv[0] ?? "";
    if (flag === "--dsn") {
      const value = take("--dsn");
      if (value) args.dsn = value;
    } else if (flag === "--auto-start-dsh") {
      const value = take("--auto-start-dsh");
      args.autoStartDsh = value !== "false";
    } else if (flag === "--dsh-bin") {
      const value = take("--dsh-bin");
      if (value) args.dshBin = value;
    } else if (flag === "--kill-dsh-on-exit") {
      const value = take("--kill-dsh-on-exit");
      args.killDshOnExit = value !== "false";
    } else if (flag === "--debug") {
      argv.splice(0, 1);
      args.debug = true;
    } else if (flag === "--help" || flag === "-h") {
      process.stderr.write(
        [
          "dsh-acp-adapter: DeepSeek Harness ACP adapter",
          "",
          "  --dsn <url>            DSH web API 地址（默认 http://127.0.0.1:3080）",
          "  --auto-start-dsh <b>   DSH 未运行时自动启动 dsh web（默认 true）",
          "  --dsh-bin <path>       dsh 可执行文件（默认 dsh）",
          "  --kill-dsh-on-exit <b> 退出时关闭由适配器启动的 dsh（默认 true）",
          "  --debug                打印调试日志到 stderr",
          "",
        ].join("\n")
      );
      process.exit(0);
    } else {
      process.stderr.write(`未知参数: ${flag}（--help 查看用法）\n`);
      process.exit(2);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const log = (message: string): void => {
    process.stderr.write(`[dsh-acp-adapter] ${message}\n`);
  };
  if (args.debug) log(`启动，dsn=${args.dsn}`);

  const stream = new StdioStream(process.stdin, process.stdout);
  const peer = new Peer(stream, { requestTimeoutMs: 0 });
  const config: AdapterConfig = {
    dsn: args.dsn,
    autoStartDsh: args.autoStartDsh,
    dshBin: args.dshBin,
    killDshOnExit: args.killDshOnExit,
    log,
    debug: args.debug,
  };
  const server = new AcpServer(peer, config);
  server.start();

  const shutdown = (): void => {
    server.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", () => {
    // 客户端关闭 stdin：结束
    server.dispose();
    process.exit(0);
  });
  process.on("uncaughtException", (error) => {
    log(`uncaught: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    log(`unhandledRejection: ${String(error)}`);
  });
}

main();
