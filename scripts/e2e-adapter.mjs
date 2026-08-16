/**
 * 适配器 E2E 测试：以 ACP 客户端身份与 dsh-acp-adapter 对话。
 *
 * 前置条件：本机 127.0.0.1:3080 有 dsh web 在运行（或允许适配器自动启动）。
 * 用法：node scripts/e2e-adapter.mjs [--dsn http://127.0.0.1:3080] [--auto-start]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(__dirname, "..", "adapter", "dist", "dsh-acp-adapter.cjs");

const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const dsn = getFlag("--dsn", "http://127.0.0.1:3080");
const autoStart = args.includes("--auto-start");

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const fail = (name, detail) => {
  failures++;
  console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
};

class AcpClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(`[adapter] ${chunk}`));
    child.on("exit", (code) => {
      for (const w of this.waiters) w.resolve(null);
      this.waiters = [];
      console.log(`[test] adapter exited code=${code}`);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.method === undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(msg.error) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        if (!this.feedWaiters(msg)) this.notifications.push(msg);
      }
    }
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(new Error(`${method}: ${e.message}`)); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  nextNotification(method, timeoutMs = 300_000) {
    const at = this.notifications.findIndex((n) => n.method === method);
    if (at >= 0) return Promise.resolve(this.notifications.splice(at, 1)[0]);
    return new Promise((resolve) => {
      const entry = { method, resolve, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  /** 消费等待中的某个 method 通知（onData 里调用） */
  feedWaiters(msg) {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.method === msg.method) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(msg);
        return true;
      }
    }
    return false;
  }

  async waitForUpdates(kinds, withinMs = 240_000) {
    const found = new Set();
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline && found.size < kinds.length) {
      const msg = await this.nextNotification("session/update", deadline - Date.now());
      if (!msg) break;
      if (kinds.includes(msg.params.update.sessionUpdate)) found.add(msg.params.update.sessionUpdate);
    }
    return found;
  }

  shutdown() {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function main() {
  console.log(`DSH ACP 适配器 E2E 测试（dsn=${dsn}${autoStart ? ", auto-start" : ""}）`);
  const vault = mkdtempSync(join(tmpdir(), "dsh-e2e-vault-"));
  console.log(`工作目录: ${vault}`);

  const child = spawn(process.execPath, [
    ADAPTER, "--dsn", dsn, "--auto-start-dsh", autoStart ? "true" : "false", "--debug",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new AcpClient(child);

  try {
    // 1. initialize
    const init = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "e2e-test", title: "E2E", version: "0.0.1" },
    });
    if (init.protocolVersion === 1 && init.agentCapabilities?.loadSession === true) ok("initialize");
    else fail("initialize", JSON.stringify(init));

    // 2. session/new
    const created = await client.request("session/new", { cwd: vault, mcpServers: [] });
    const sessionId = created.sessionId;
    if (typeof sessionId === "string" && sessionId.startsWith("session-")) ok(`session/new → ${sessionId}`);
    else fail("session/new", JSON.stringify(created));

    // 3. session/prompt：真实模型调用
    console.log("  提交提示（等待模型响应，可能需要 1-3 分钟）…");
    const promptDone = client.request("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "只回复四个字：测试成功。不要调用任何工具。" },
        {
          type: "resource",
          resource: {
            uri: `file://${vault}/context.md`,
            mimeType: "text/markdown",
            text: "# 背景\n这是一个 E2E 测试的引用文件。",
          },
        },
      ],
    }, 300_000);
    const seenKinds = await client.waitForUpdates(["agent_message_chunk", "agent_thought_chunk"], 280_000);
    if (seenKinds.has("agent_message_chunk")) ok("收到 agent_message_chunk 流式文本");
    else fail("agent_message_chunk", "未见流式文本");
    if (seenKinds.has("agent_thought_chunk")) ok("收到 agent_thought_chunk 推理流");
    else console.log("  （无推理流，可能模型未产生 reasoning）");

    const result = await promptDone;
    if (result && ["end_turn", "cancelled", "max_tokens"].includes(result.stopReason)) ok(`session/prompt 完成 → ${result.stopReason}`);
    else fail("session/prompt", JSON.stringify(result));

    // 4. session/load 重放
    console.log("  加载会话历史…");
    const loadDone = client.request("session/load", { sessionId, cwd: vault, mcpServers: [] }, 60_000);
    const replayed = new Set();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const msg = await client.nextNotification("session/update", deadline - Date.now());
      if (!msg) break;
      replayed.add(msg.params.update.sessionUpdate);
    }
    await loadDone;
    if (replayed.has("user_message_chunk")) ok("session/load 重放 user_message_chunk");
    else fail("session/load 重放", "未见 user_message_chunk");
    if (replayed.has("agent_message_chunk")) ok("session/load 重放 agent_message_chunk");
    else fail("session/load 重放", "未见 agent_message_chunk");

    // 5. 第二轮：验证多轮会话（同一 session 继续）
    console.log("  第二轮提示…");
    const second = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "再回复四个字：多轮正常。" }],
    }, 300_000);
    const secondResult = await second;
    if (secondResult?.stopReason === "end_turn") ok(`第二轮完成 → ${secondResult.stopReason}`);
    else fail("第二轮", JSON.stringify(secondResult));

    // 6. 工具调用 + 文件修改：让 agent 在会话工作目录创建文件
    console.log("  第三轮：要求 agent 修改工作目录文件…");
    const filePrompt = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "请使用工具在工作目录创建 hello-e2e.md，内容为一行文本：e2e-ok" }],
    }, 300_000);
    const toolKinds = await client.waitForUpdates(["tool_call", "tool_call_update"], 280_000);
    if (toolKinds.has("tool_call")) ok("收到 tool_call 卡片流");
    else fail("tool_call", "未见工具调用");
    if (toolKinds.has("tool_call_update")) ok("收到 tool_call_update 完成状态");
    else fail("tool_call_update", "未见工具结果");
    const thirdResult = await filePrompt;
    if (thirdResult?.stopReason === "end_turn") ok(`第三轮完成 → ${thirdResult.stopReason}`);
    else fail("第三轮", JSON.stringify(thirdResult));
    const helloPath = join(vault, "hello-e2e.md");
    try {
      const content = await import("node:fs").then((fs) => fs.promises.readFile(helloPath, "utf8"));
      if (content.includes("e2e-ok")) ok(`agent 已写入文件 ${helloPath}`);
      else fail("文件内容", JSON.stringify(content.slice(0, 100)));
    } catch {
      fail("文件写入", `${helloPath} 不存在`);
    }
  } catch (error) {
    fail("流程异常", error.message);
    console.error(error);
  } finally {
    client.shutdown();
  }

  console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
