/**
 * acp-core Peer（客户端角色）测试：
 * 1) 与真实 dsh-acp-adapter 跑 initialize + session/new + session/load（不发起模型调用）
 * 2) 与 mock agent 进程验证通知分发与 server→client 请求处理
 */
import esbuild from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(__dirname, "..", "adapter", "dist", "dsh-acp-adapter.cjs");

// 打包 acp-core 源码为可导入的 CJS 测试模块
await esbuild.build({
  entryPoints: [join(__dirname, "..", "packages", "acp-core", "src", "index.ts")],
  outfile: join(tmpdir(), "acp-core-test.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "silent",
});
const { Peer, StdioStream } = await import(`file://${join(tmpdir(), "acp-core-test.cjs")}`);

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const fail = (name, detail) => {
  failures++;
  console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
};

console.log("acp-core Peer 客户端测试");

// ---------------------------------------------------------------------------
// 1) 真实适配器
// ---------------------------------------------------------------------------
{
  const vault = mkdtempSync(join(tmpdir(), "dsh-peer-vault-"));
  const child = spawn(process.execPath, [ADAPTER, "--dsn", "http://127.0.0.1:3080", "--auto-start-dsh", "false"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => undefined);
  const stream = new StdioStream(child.stdout, child.stdin);
  const peer = new Peer(stream, { requestTimeoutMs: 30_000 });
  peer.setRequestHandler((method) => {
    if (method === "session/request_permission") return { outcome: { outcome: "selected", optionId: "allow-once" } };
    if (method === "fs/read_text_file") return { content: "mock" };
    if (method === "fs/write_text_file") return null;
    throw new Error(`unexpected: ${method}`);
  });
  const notifications = [];
  peer.setNotificationHandler((method, params) => notifications.push({ method, params }));
  peer.start();

  try {
    const init = await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "acp-core-test", title: "ACP Core Test", version: "0.0.1" },
    });
    if (init.protocolVersion === 1 && init.agentCapabilities?.loadSession === true) ok("initialize（Peer 客户端 → 真实适配器）");
    else fail("initialize", JSON.stringify(init));

    const created = await peer.request("session/new", { cwd: vault, mcpServers: [] });
    if (typeof created.sessionId === "string") ok(`session/new → ${created.sessionId}`);
    else fail("session/new");

    await peer.request("session/load", { sessionId: created.sessionId, cwd: vault, mcpServers: [] });
    ok("session/load（空会话）");

    // 未知方法 → JSON-RPC 错误
    let errCode = 0;
    try {
      await peer.request("no/such_method", {});
    } catch (error) {
      errCode = error.code ?? 0;
    }
    if (errCode === -32601) ok("未知方法返回 -32601");
    else fail("未知方法", `code=${errCode}`);
  } catch (error) {
    fail("适配器流程异常", error.message);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// 2) mock agent：通知分发 + server→client 请求
// ---------------------------------------------------------------------------
{
  const mock = spawn(
    "node",
    [
      "-e",
      `
      process.stdin.setEncoding("utf8");
      let buf = "";
      process.stdin.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
            // 初始化后立即：发通知 + 发 server→client 请求
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }) + "\\n");
            setTimeout(() => {
              process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "fs/read_text_file", params: { sessionId: "s1", path: "/tmp/x" } }) + "\\n");
            }, 100);
          } else if (msg.id === 99 && msg.method === undefined) {
            // server 收到 client 的应答 → 转发回父进程标记
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "mock/report", params: { responded: true } }) + "\\n");
          }
        }
      });
    `,
    ],
    { stdio: ["pipe", "pipe", "inherit"] }
  );
  const stream = new StdioStream(mock.stdout, mock.stdin);
  const peer = new Peer(stream, { requestTimeoutMs: 10_000 });
  const notifications = [];
  const serverCalls = [];
  peer.setNotificationHandler((method, params) => notifications.push({ method, params }));
  peer.setRequestHandler((method, params) => {
    serverCalls.push({ method, params });
    if (method === "fs/read_text_file") return { content: "mock-content" };
    return null;
  });
  peer.start();

  try {
    await peer.request("initialize", { protocolVersion: 1 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (notifications.some((n) => n.method === "session/update" && n.params.update.sessionUpdate === "agent_message_chunk")) {
      ok("通知分发（收到 mock 的 session/update）");
    } else {
      fail("通知分发", JSON.stringify(notifications));
    }
    if (serverCalls.some((c) => c.method === "fs/read_text_file")) {
      ok("server→client 请求处理（fs/read_text_file 应答）");
    } else {
      fail("server→client 请求", JSON.stringify(serverCalls));
    }
    if (notifications.some((n) => n.method === "mock/report" && n.params.responded === true)) {
      ok("请求应答正确送达 mock agent");
    } else {
      fail("请求应答送达");
    }
  } catch (error) {
    fail("mock 流程异常", error.message);
  } finally {
    mock.stdin.end();
    mock.kill();
  }
}

console.log(failures === 0 ? "\nacp-core Peer 测试通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
