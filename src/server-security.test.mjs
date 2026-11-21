// End-to-end security tests of the real wrapper (src/server.js) in front of a FAKE gateway
// (scripts/fixtures/fake-openclaw.mjs) that echoes what it receives. Loopback only, temp dirs, synthetic secrets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "scripts", "fixtures", "fake-openclaw.mjs");
const PASSWORD = "synthetic-setup-password-for-tests";
const GATEWAY_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const BASIC = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
const WRONG = `Basic ${Buffer.from("admin:wrong-password").toString("base64")}`;

let wrapper;
let base;
let port;
let stateDir;
let output = "";

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

async function request(method, url, { headers = {}, body } = {}) {
  const res = await fetch(base + url, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

function upgrade(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/ws",
      headers: { Connection: "Upgrade", Upgrade: "websocket", ...headers },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, seen: res.headers["x-seen-authorization"] });
    });
    req.on("response", (res) => resolve({ status: res.statusCode, seen: null }));
    req.on("error", (err) => (err.code === "ECONNRESET" ? resolve({ status: 0, seen: null }) : reject(err)));
    req.end();
  });
}

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-sec-"));
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  port = await freePort();
  const gatewayPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("RAILWAY_") || k.startsWith("OPENCLAW_")) delete env[k];
  wrapper = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: {
      ...env,
      PORT: String(port),
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
      OPENCLAW_ENTRY: FAKE,
      OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
      OPENCLAW_PERSONA_SEED: "0",
      SETUP_PASSWORD: PASSWORD,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group: teardown also reaps the gateway child if the wrapper died
  });
  wrapper.stdout.on("data", (d) => (output += d));
  wrapper.stderr.on("data", (d) => (output += d));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", "/setup/healthz");
      if (r.json?.gatewayReachable) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("wrapper/fake gateway did not become ready:\n" + output);
});

after(async () => {
  if (wrapper && wrapper.exitCode === null) {
    const exited = new Promise((r) => wrapper.once("exit", r));
    wrapper.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  try {
    process.kill(-wrapper.pid, "SIGKILL");
  } catch {}
  wrapper?.stdout?.destroy();
  wrapper?.stderr?.destroy();
  fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("anonymous proxied requests do NOT get the gateway token (was: full operator access for anyone)", async () => {
  const r = await request("POST", "/tools/invoke", { headers: { "content-type": "text/plain" }, body: '{"tool":"memory_get"}' });
  assert.equal(r.status, 200);
  assert.equal(r.json.fake, true);
  assert.equal(r.json.authorization, null);
});

test("a caller's own bearer token is forwarded unchanged; the setup login gets the gateway token", async () => {
  const own = await request("GET", "/v1/models", { headers: { authorization: "Bearer callers-own-token" } });
  assert.equal(own.json.authorization, "Bearer callers-own-token");
  const op = await request("GET", "/v1/models", { headers: { authorization: BASIC } });
  assert.equal(op.json.authorization, `Bearer ${GATEWAY_TOKEN}`);
});

test("/hooks/* never gets the gateway token and never receives the setup password; JSON bodies arrive intact", async () => {
  const body = JSON.stringify({ event: "synthetic", n: 1 });
  const anon = await request("POST", "/hooks/agent", { headers: { "content-type": "application/json", authorization: "Bearer hook-token" }, body });
  assert.equal(anon.json.authorization, "Bearer hook-token");
  assert.equal(anon.json.body, body, "body must not be swallowed by a global JSON parser");
  const op = await request("POST", "/hooks/agent", { headers: { "content-type": "application/json", authorization: BASIC }, body });
  assert.equal(op.json.authorization, null);
  assert.equal(op.json.body, body);
});

test("the token-bearing /openclaw link is only handed out after the setup login", async () => {
  const anon = await request("GET", "/openclaw");
  assert.equal(anon.status, 401);
  assert.ok(!anon.text.includes(GATEWAY_TOKEN) && !String(anon.headers.get("location")).includes(GATEWAY_TOKEN));
  const op = await request("GET", "/openclaw", { headers: { authorization: BASIC } });
  assert.equal(op.status, 302);
  assert.equal(op.headers.get("location"), `/openclaw?token=${GATEWAY_TOKEN}`);
  assert.equal(op.headers.get("cache-control"), "no-store");
});

test("websocket upgrades: token only for the setup login", async () => {
  const anon = await upgrade();
  assert.equal(anon.status, 101);
  assert.equal(anon.seen, "none");
  const op = await upgrade({ authorization: BASIC });
  assert.equal(op.seen, `Bearer ${GATEWAY_TOKEN}`);
});

test("the gateway process does not inherit SETUP_PASSWORD", async () => {
  const r = await request("GET", "/anything");
  assert.equal(r.json.envHasSetupPassword, false);
});

test("CSRF: cross-site state-changing requests to /setup are refused before they run", async () => {
  for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }]) {
    const r = await request("POST", "/setup/api/reset", { headers: { authorization: BASIC, ...headers } });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.ok(fs.existsSync(path.join(stateDir, "openclaw.json")), "config was not deleted");
  const same = await request("POST", "/setup/api/pairing/approve", {
    headers: { authorization: BASIC, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(same.status, 400, "same-origin UI requests still reach the handler");
});

test("encrypted backup stays off (503) until BASHT_BACKUP_PUBLIC_KEY is set, and pauses nothing", async () => {
  const r = await request("POST", "/setup/api/backup", { headers: { authorization: BASIC, origin: base } });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /BASHT_BACKUP_PUBLIC_KEY/);
  assert.ok(!/gateway paused/.test(output));
});

test("admin pages: anti-framing and no-store headers", async () => {
  const r = await request("GET", "/setup/api/logs?lines=abc", { headers: { authorization: BASIC } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(Array.isArray(r.json.lines) && r.json.lines.length <= 500, "invalid ?lines falls back to 500");
});

test("throttling counts failures only: normal use never locks the operator out", async () => {
  for (let i = 0; i < 60; i++) {
    const r = await request("GET", "/setup/api/logs?lines=1", { headers: { authorization: BASIC } });
    assert.equal(r.status, 200, `request ${i}`);
  }
  for (let i = 0; i < 20; i++) assert.equal((await request("GET", "/setup")).status, 401, "no credentials is not a failure");
});

test("abrupt client resets during WebSocket/HTTP handshakes never crash the wrapper (was: unauthenticated DoS)", async () => {
  const reset = (raw, delay) =>
    new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(raw);
        setTimeout(() => {
          s.resetAndDestroy();
          resolve();
        }, delay);
      });
      s.on("error", resolve);
    });
  const ws = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
  const post = "POST /tools/invoke HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000\r\n\r\n{";
  const jobs = [];
  for (const delay of [0, 0, 1, 2, 5, 10, 20, 50]) for (let i = 0; i < 4; i++) jobs.push(reset(ws, delay), reset(post, delay));
  await Promise.all(jobs);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(wrapper.exitCode, null, "wrapper process must still be running:\n" + output.slice(-800));
  assert.equal((await request("GET", "/setup/healthz")).status, 200);
  assert.equal((await upgrade()).status, 101, "websocket proxying still works afterwards");
});

// Must run last: it locks the test client out.
test("wrong passwords are throttled on /setup AND on the proxy path; then even the right one waits", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await request("GET", "/setup/api/status", { headers: { authorization: WRONG } })).status, 401);
  for (let i = 0; i < 5; i++) {
    const r = await request("POST", "/tools/invoke", { headers: { authorization: WRONG }, body: "{}" });
    assert.equal(r.status, 401, "guessing through the proxy is not a free oracle");
  }
  const locked = await request("GET", "/setup/api/status", { headers: { authorization: BASIC } });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.equal((await request("GET", "/v1/models", { headers: { authorization: WRONG } })).status, 429);
  assert.equal((await upgrade({ authorization: WRONG })).status, 429);
});
