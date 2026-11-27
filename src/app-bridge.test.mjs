// BASHT app bridge: auth, the read allowlist, owner-only conversations, and one owner turn at a time in the app session.
// A FAKE gateway (in this file) stands in for OpenClaw; loopback only, synthetic tokens, temp config.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { APP_SESSION, APP_SESSION_KEY, createAppBridge, isReadable, messageText } from "./app-bridge.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const OWNER = "+966500000001";
const seen = []; // what the fake gateway received
let chatGate = null; // when set, the fake chat stream waits for it before finishing

const ROWS = [
  { key: APP_SESSION_KEY, channel: "unknown", updatedAt: 3 },
  { key: "agent:main:main", channel: "webchat", updatedAt: 2 },
  { key: `agent:main:whatsapp:direct:${OWNER}`, channel: "whatsapp", updatedAt: 5 },
  { key: "agent:main:whatsapp:direct:+966511111111", channel: "whatsapp", updatedAt: 9 }, // someone else
  { key: "agent:main:whatsapp:group:120363@g.us", channel: "whatsapp", updatedAt: 8 },
  { key: "agent:main:subagent:abc", channel: "unknown", updatedAt: 7 },
];

let gateway, gwUrl, server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-"));
  fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({ commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] } }));
  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      seen.push({ url: req.url, auth: req.headers.authorization, session: req.headers["x-openclaw-session-key"] ?? null, body });
      if (req.headers.authorization !== `Bearer ${GW_TOKEN}`) { res.writeHead(401); return res.end(); }
      if (req.url === "/tools/invoke") {
        const { tool, args } = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        if (tool === "sessions_list") return res.end(JSON.stringify({ ok: true, result: { details: { sessions: ROWS } } }));
        if (tool === "sessions_history") {
          return res.end(JSON.stringify({ ok: true, result: { details: { sessionKey: args.sessionKey, hasMore: false, messages: [
            { role: "user", content: "مرحبا", timestamp: 1 },
            { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "أهلًا" }, { type: "toolCall", name: "x" }], timestamp: 2 },
            { role: "toolResult", content: "tool output", timestamp: 3 },
          ] } } }));
        }
        return res.end(JSON.stringify({ ok: false }));
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (d) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`);
        send({ role: "assistant" });
        send({ content: "تم " });
        if (chatGate) await chatGate;
        send({ content: "التنفيذ" });
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  gwUrl = `http://127.0.0.1:${gateway.address().port}`;
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: gwUrl, gatewayToken: GW_TOKEN, configPath: path.join(dir, "openclaw.json") }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/app/v1`;
});

after(() => {
  server?.close();
  gateway?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (p, { method = "GET", token = APP_TOKEN, body } = {}) =>
  fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const waitRun = async (id) => {
  for (let i = 0; i < 100; i++) {
    const r = await call(`/runs/${id}`);
    if (r.json.status !== "running") return r.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not finish");
};

test("off without a long enough token", () => {
  assert.equal(createAppBridge({ token: "", gatewayUrl: "x", gatewayToken: "y", configPath: "z" }), null);
  assert.equal(createAppBridge({ token: "short", gatewayUrl: "x", gatewayToken: "y", configPath: "z" }), null);
});

test("requires the app token; the gateway token is not accepted from outside", async () => {
  assert.equal((await call("/status", { token: null })).status, 401);
  assert.equal((await call("/status", { token: GW_TOKEN })).status, 401);
  assert.equal((await call("/status", { token: APP_TOKEN + "x" })).status, 401);
  const ok = await call("/status");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.appSession, APP_SESSION_KEY);
});

test("lists only the owner's own conversations; never groups, other people or subagents", async () => {
  const r = await call("/sessions");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions.map((s) => s.key), [`agent:main:whatsapp:direct:${OWNER}`, APP_SESSION_KEY, "agent:main:main"]);
  assert.deepEqual(r.json.sessions.map((s) => s.writable), [false, true, false]);
  assert.ok(!JSON.stringify(r.json).includes("+966511111111"));
  // the bridge used the gateway token itself
  assert.equal(seen.at(-1).auth, `Bearer ${GW_TOKEN}`);
});

test("history: text only (no thinking, tool calls or tool results), and refuses chats outside the allowlist", async () => {
  const r = await call(`/history?key=${encodeURIComponent(`agent:main:whatsapp:direct:${OWNER}`)}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.messages.map((m) => [m.role, m.text]), [["user", "مرحبا"], ["assistant", "أهلًا"]]);
  for (const key of ["agent:main:whatsapp:direct:+966511111111", "agent:main:whatsapp:group:120363@g.us", "agent:main:subagent:abc", "agent:main:unknown"]) {
    assert.equal((await call(`/history?key=${encodeURIComponent(key)}`)).status, 404, key);
  }
});

test("send: one owner turn in the app session only, streamed text, one at a time", async () => {
  let open;
  chatGate = new Promise((r) => (open = r));
  const started = await call("/send", { method: "POST", body: { message: "أرسل التقرير", sessionKey: "agent:main:whatsapp:direct:+966500000001" } });
  assert.equal(started.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  const live = await call(`/runs/${started.json.runId}`);
  assert.equal(live.json.status, "running");
  assert.equal(live.json.text, "تم ");
  assert.equal((await call("/send", { method: "POST", body: { message: "ثانية" } })).status, 409);
  open();
  chatGate = null;
  const done = await waitRun(started.json.runId);
  assert.equal(done.status, "done");
  assert.equal(done.text, "تم التنفيذ");
  const chat = seen.find((s) => s.url === "/v1/chat/completions");
  assert.equal(chat.session, APP_SESSION, "always the app's own session, whatever the caller sends");
  assert.equal(chat.auth, `Bearer ${GW_TOKEN}`);
  assert.deepEqual(JSON.parse(chat.body).messages, [{ role: "user", content: "أرسل التقرير" }]);
});

test("send: rejects empty and oversized messages; stop ends a running turn", async () => {
  assert.equal((await call("/send", { method: "POST", body: { message: "  " } })).status, 400);
  assert.equal((await call("/send", { method: "POST", body: { message: "x".repeat(8001) } })).status, 400);
  chatGate = new Promise(() => {}); // never finishes by itself
  const s = await call("/send", { method: "POST", body: { message: "طويلة" } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await call(`/runs/${s.json.runId}/stop`, { method: "POST" })).status, 200);
  const r = await waitRun(s.json.runId);
  assert.equal(r.status, "stopped");
  chatGate = null;
  assert.equal((await call("/runs/nope")).status, 404);
});

test("allowlist and text helpers", () => {
  assert.equal(isReadable({ key: `agent:main:whatsapp:default:direct:${OWNER}` }, [OWNER]), true);
  assert.equal(isReadable({ key: `agent:main:whatsapp:direct:${OWNER}` }, []), false, "no configured owner: no WhatsApp chat is readable");
  assert.equal(isReadable({ key: "agent:other:main" }, [OWNER]), false);
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(messageText({ content: null }), "");
});
