// 原始字节级调试：捕获适配器 stdout 全部输出，与 stderr 日志对照
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(__dirname, "..", "adapter", "dist", "dsh-acp-adapter.cjs");
const vault = mkdtempSync(join(tmpdir(), "dsh-raw-probe-"));
const rawFile = `/tmp/raw-${Date.now()}.log`;
writeFileSync(rawFile, "");

const child = spawn(process.execPath, [ADAPTER, "--dsn", "http://127.0.0.1:3080", "--auto-start-dsh", "false", "--debug"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let id = 0;
function req(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
  console.log(`>>> ${msg}`);
  child.stdin.write(msg + "\n");
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  appendFileSync(rawFile, `[OUT ${Date.now()}] ${chunk}`);
  process.stdout.write(`<<< ${chunk}`);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  appendFileSync(rawFile, `[ERR ${Date.now()}] ${chunk}`);
  process.stdout.write(`(err) ${chunk}`);
});

child.on("exit", (code) => {
  console.log(`adapter exited ${code}, raw: ${rawFile}`);
  process.exit(0);
});

setTimeout(() => {
  req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, clientInfo: { name: "raw-probe" } });
  setTimeout(() => {
    req("session/new", { cwd: vault, mcpServers: [] });
  }, 500);
}, 800);

// session/new 响应到达后（大约 1s），发 prompt
setTimeout(() => {
  // 需要知道 sessionId；直接从 stdout 解析太麻烦，改为在收到响应后处理
}, 2000);

let gotSession = false;
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  if (gotSession) return;
  for (const line of text.split("\n")) {
    if (!line.includes('"sessionId"')) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result?.sessionId) {
        gotSession = true;
        console.log(`>>> sessionId = ${msg.result.sessionId}`);
        req("session/prompt", { sessionId: msg.result.sessionId, prompt: [{ type: "text", text: "回复两个字：好的" }] });
      }
    } catch {}
  }
});

setTimeout(() => {
  console.log("done watching");
  child.kill();
}, 240000);
