// 直接验证 DSH mux 流：create → prompt → 观察 session/event 帧
import WebSocket from "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/ws/index.js";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = { host: "127.0.0.1", port: 3080 };
const vault = mkdtempSync(join(tmpdir(), "dsh-mux-probe-"));

function call(method, payload, rpcId = randomUUID()) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: "client-request", rpcId, method, payload });
    const req = httpRequest(
      { host: TARGET.host, port: TARGET.port, path: `/api/${method}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const parsed = JSON.parse(raw);
          if (parsed.result?.ok) resolve(parsed.result.value);
          else reject(new Error(`${method}: ${JSON.stringify(parsed.result?.error)}`));
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

const ws = new WebSocket(`ws://${TARGET.host}:${TARGET.port}/api/events.mux`);
const frames = [];
ws.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.payload?.type === "session/event") {
    frames.push(frame.payload.event.type);
    process.stdout.write(`[mux] ${frame.payload.event.type} #${frame.payload.event.seq}\n`);
  }
});

ws.on("open", async () => {
  const { sessionId } = await call("session.create", { cwd: vault });
  console.log("sessionId:", sessionId);
  await call("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: "只回复四个字：测试成功。" }] });
  console.log("prompt accepted, watching…");
});

setTimeout(async () => {
  console.log("frames seen:", frames.join(", "));
  process.exit(0);
}, 120_000);
