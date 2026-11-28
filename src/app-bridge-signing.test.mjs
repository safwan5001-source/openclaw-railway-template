// BASHT app bridge: request signing "basht-bridge-v1" — the shared vectors byte for byte, the verifier's negative cases, the env rules,
// and the router wiring (modes, body hash on every parser, the shared failed-auth limiter, rotation, compatibility).
// Test-only secrets (the fixture's). The bridge runs against a fake fetch: nothing leaves this process.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { createAppBridge } from "./app-bridge.js";
import { BOOT_FENCE_SECONDS, MAX_SKEW_SECONDS, MIN_SECRET_LENGTH, NONCE_MAX_ENTRIES, NONCE_TTL_MS, SIGNING_HEADERS, canonicalString, createSigningVerifier, sha256Hex,
  signCanonical, signingConfigFromEnv } from "./app-bridge-signing.js";

const V = JSON.parse(fs.readFileSync(new URL("./fixtures/bridge-signing-vectors.json", import.meta.url), "utf8"));
const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const CURRENT = V.currentSecret;
const PREVIOUS = V.previousSecret;
const secretFor = (c) => (c.signedWith === "previous" ? PREVIOUS : CURRENT);
const bodyOf = (c) => Buffer.from(c.bodyBase64, "base64");
const hdr = (c, over = {}) => ({ "x-basht-timestamp": String(c.timestamp), "x-basht-nonce": c.nonce, "x-basht-content-sha256": c.contentSha256, "x-basht-signature": c.signature, ...over });
const req = (c, over = {}) => ({ method: c.method, originalUrl: c.target, headers: hdr(c), ...over });
const clockAt = (c) => () => c.timestamp * 1000;

// ---------------------------------------------------------------- the shared vectors ----------------------------------------------------

test("fixture sanity: the spec name and the test-only secrets are long enough", () => {
  assert.equal(V.spec, "basht-bridge-v1");
  assert.ok(CURRENT.length >= MIN_SECRET_LENGTH && PREVIOUS.length >= MIN_SECRET_LENGTH);
  assert.equal(V.cases.length, 5);
  assert.ok(V.cases.some((c) => c.signedWith === "previous"));
});

test("vectors: canonical string, body hash and signature match byte for byte", () => {
  for (const c of V.cases) {
    assert.equal(sha256Hex(bodyOf(c)), c.contentSha256, `${c.name}: body hash`);
    const canonical = canonicalString({ method: c.method, target: c.target, timestamp: c.timestamp, nonce: c.nonce, contentSha256: c.contentSha256 });
    assert.equal(canonical, c.canonical, `${c.name}: canonical`);
    assert.equal(signCanonical(secretFor(c), canonical), c.signature, `${c.name}: signature`);
    // and by the spec text alone, with no helper of ours
    const byHand = `v1=${crypto.createHmac("sha256", secretFor(c)).update(["basht-bridge-v1", c.method.toUpperCase(), c.target, String(c.timestamp), c.nonce, crypto.createHash("sha256").update(bodyOf(c)).digest("hex")].join("\n")).digest("hex")}`;
    assert.equal(byHand, c.signature, `${c.name}: by hand`);
  }
  assert.equal(sha256Hex(Buffer.alloc(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(undefined), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("vectors: the verifier accepts every one (current and previous secret), with an injectable clock", () => {
  for (const c of V.cases) {
    const v = createSigningVerifier({ secret: CURRENT, previousSecret: PREVIOUS, mode: "required", now: clockAt(c) });
    const r = v.checkHeaders(req(c));
    assert.deepEqual(r, { ok: true, signed: true, contentSha256: c.contentSha256 }, c.name);
    assert.equal(v.checkBody(r.contentSha256, bodyOf(c)), true, `${c.name}: body`);
  }
});

test("vectors: the previous-secret vector needs the previous secret; the others need the current one", () => {
  const prev = V.cases.find((c) => c.signedWith === "previous");
  const cur = V.cases.find((c) => c.signedWith === "current");
  assert.equal(createSigningVerifier({ secret: CURRENT, mode: "required", now: clockAt(prev) }).checkHeaders(req(prev)).reason, "signature", "no previous secret configured");
  assert.equal(createSigningVerifier({ secret: PREVIOUS, mode: "required", now: clockAt(cur) }).checkHeaders(req(cur)).reason, "signature", "rotated the other way round");
  assert.equal(createSigningVerifier({ secret: CURRENT, previousSecret: PREVIOUS, mode: "required", now: clockAt(cur) }).checkHeaders(req(cur)).ok, true);
});

// ---------------------------------------------------------------- verifier: negative cases ---------------------------------------------

const post = V.cases.find((c) => c.name === "post-json");
const fresh = (over = {}, c = post) => createSigningVerifier({ secret: CURRENT, previousSecret: PREVIOUS, mode: "required", now: clockAt(c), ...over });

test("verifier: a wrong signature, a wrong secret, a flipped bit or another version tag is refused", () => {
  const flip = (s) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
  for (const sig of [flip(post.signature), `v1=${"0".repeat(64)}`, post.signature.replace("v1=", "v2=")]) {
    const r = fresh().checkHeaders(req(post, { headers: hdr(post, { "x-basht-signature": sig }) }));
    assert.equal(r.ok, false);
    assert.ok(["signature", "malformed"].includes(r.reason), sig.slice(0, 6));
  }
  assert.equal(createSigningVerifier({ secret: "another-secret-another-secret-another-secret", mode: "required", now: clockAt(post) }).checkHeaders(req(post)).reason, "signature");
});

test("verifier: what is signed is bound — method, request target (path and query), timestamp, nonce, body hash", () => {
  const get = V.cases[0];
  const cases = [
    [get, { method: "POST" }], [get, { method: "get " }], [post, { method: "PUT" }],
    [get, { originalUrl: "/app/v1/history?key=agent%3Amain%3Aapp%3Aowner&limit=51" }],
    [get, { originalUrl: "/app/v1/history?key=agent:main:app:owner&limit=50" }], // the same query decoded: not the bytes that were signed
    [get, { originalUrl: "/app/v1/history" }], [get, { originalUrl: "/app/v1/sessions?key=agent%3Amain%3Aapp%3Aowner&limit=50" }],
    [post, { originalUrl: "/app/v1/speak" }], [post, { originalUrl: "/app/v1/send/" }], [post, { originalUrl: "/app/v1/send?x=1" }],
  ];
  for (const [c, over] of cases) assert.equal(fresh({}, c).checkHeaders(req(c, over)).reason, "signature", JSON.stringify(over));
  assert.equal(fresh().checkHeaders(req(post, { headers: hdr(post, { "x-basht-timestamp": String(post.timestamp + 1) }) })).reason, "signature");
  assert.equal(fresh().checkHeaders(req(post, { headers: hdr(post, { "x-basht-nonce": "n-post-000000003" }) })).reason, "signature");
  assert.equal(fresh().checkHeaders(req(post, { headers: hdr(post, { "x-basht-content-sha256": V.cases[0].contentSha256 }) })).reason, "signature");
  // the method is compared as Node reports it (uppercase)
  assert.equal(fresh().checkHeaders(req(post, { method: "POST" })).ok, true);
});

test("verifier: the body is checked against the signed hash (tamper, truncation, extension, none)", () => {
  const v = fresh();
  const r = v.checkHeaders(req(post));
  assert.equal(v.checkBody(r.contentSha256, bodyOf(post)), true);
  const b = bodyOf(post);
  for (const tampered of [Buffer.from(b.toString("utf8").replace("مرحبا", "وداعا")), b.subarray(0, b.length - 1), Buffer.concat([b, Buffer.from(" ")]), Buffer.alloc(0), undefined]) {
    assert.equal(v.checkBody(r.contentSha256, tampered), false);
  }
  const empty = V.cases.find((c) => c.name === "post-empty-body");
  assert.equal(v.checkBody(empty.contentSha256, undefined), true, "no body = sha256 of the empty string");
  assert.equal(v.checkBody(empty.contentSha256, Buffer.alloc(0)), true);
  assert.equal(v.checkBody(empty.contentSha256, Buffer.from("x")), false);
});

test("verifier: the timestamp window is +-60 s, both ways; the edge is inside", () => {
  const at = (deltaSeconds) => createSigningVerifier({ secret: CURRENT, mode: "required", bootEpoch: post.timestamp - 10_000, now: () => (post.timestamp + deltaSeconds) * 1000 }).checkHeaders(req(post));
  assert.equal(MAX_SKEW_SECONDS, 60);
  assert.equal(at(0).ok, true);
  assert.equal(at(60).ok, true);
  assert.equal(at(-60).ok, true);
  assert.deepEqual(at(61), { ok: false, reason: "skew" });
  assert.deepEqual(at(-61), { ok: false, reason: "skew" });
  assert.deepEqual(at(3600), { ok: false, reason: "skew" });
  const v = createSigningVerifier({ secret: CURRENT, mode: "required", bootEpoch: 0, now: () => (post.timestamp + 60) * 1000 + 999 });
  assert.equal(v.checkHeaders(req(post)).ok, true, "sub-second part of the clock is ignored (floor)");
});

test("verifier: a nonce works once; garbage cannot burn real nonces; the cache is bounded and expires", () => {
  let t = post.timestamp * 1000;
  const v = createSigningVerifier({ secret: CURRENT, mode: "required", now: () => t });
  assert.equal(v.checkHeaders(req(post)).ok, true);
  assert.deepEqual(v.checkHeaders(req(post)), { ok: false, reason: "replay" });
  assert.deepEqual(v.checkHeaders(req(post)), { ok: false, reason: "replay" });
  // an invalid signature carrying a fresh nonce does not spend it
  const other = V.cases[0];
  t = other.timestamp * 1000;
  assert.equal(v.checkHeaders(req(other, { headers: hdr(other, { "x-basht-signature": `v1=${"a".repeat(64)}` }) })).reason, "signature");
  assert.equal(v.checkHeaders(req(other)).ok, true, "the real request with that nonce still works");
  // the TTL: the entry is gone after 180 s (the request itself is long outside the 60 s window by then)
  assert.equal(NONCE_TTL_MS, 180_000);
  const sign = (n, ts) => {
    const sha = sha256Hex(Buffer.alloc(0));
    return { method: "GET", originalUrl: "/app/v1/status", headers: { "x-basht-timestamp": String(ts), "x-basht-nonce": n, "x-basht-content-sha256": sha,
      "x-basht-signature": signCanonical(CURRENT, canonicalString({ method: "GET", target: "/app/v1/status", timestamp: ts, nonce: n, contentSha256: sha })) } };
  };
  t = 5_000_000_000;
  const w = createSigningVerifier({ secret: CURRENT, mode: "required", now: () => t });
  assert.equal(w.checkHeaders(sign("a".repeat(20), Math.floor(t / 1000))).ok, true);
  assert.equal(w.nonceCount, 1);
  t += NONCE_TTL_MS - 1;
  assert.equal(w.checkHeaders(sign("a".repeat(20), Math.floor(t / 1000))).reason, "replay", "still remembered just before the TTL");
  t += 2;
  assert.equal(w.checkHeaders(sign("b".repeat(20), Math.floor(t / 1000))).ok, true);
  assert.equal(w.nonceCount, 1, "the expired entry was purged");
  // bounded: the oldest are evicted first
  const b = createSigningVerifier({ secret: CURRENT, mode: "required", now: () => t });
  assert.equal(NONCE_MAX_ENTRIES, 10_000);
  for (let i = 0; i < NONCE_MAX_ENTRIES + 50; i++) assert.equal(b.checkHeaders(sign(`n${String(i).padStart(18, "0")}`, Math.floor(t / 1000))).ok, true);
  assert.equal(b.nonceCount, NONCE_MAX_ENTRIES);
  assert.equal(b.checkHeaders(sign(`n${String(0).padStart(18, "0")}`, Math.floor(t / 1000))).ok, true, "the oldest was evicted (bounded memory), so it is accepted again");
  assert.equal(b.checkHeaders(sign(`n${String(NONCE_MAX_ENTRIES + 49).padStart(18, "0")}`, Math.floor(t / 1000))).reason, "replay", "the newest is still remembered");
});

test("verifier: malformed headers are refused before any crypto", () => {
  const spy = { hmac: 0 };
  const realHmac = crypto.createHmac;
  crypto.createHmac = (...a) => { spy.hmac++; return realHmac(...a); };
  try {
    const bad = [
      { "x-basht-timestamp": "17958000O1" }, { "x-basht-timestamp": "-1795800001" }, { "x-basht-timestamp": "1795800001.5" }, { "x-basht-timestamp": "" }, { "x-basht-timestamp": "1".repeat(13) },
      { "x-basht-timestamp": `${post.timestamp}, ${post.timestamp}` }, { "x-basht-timestamp": ` ${post.timestamp}` },
      { "x-basht-nonce": "short" }, { "x-basht-nonce": "n".repeat(15) }, { "x-basht-nonce": "n".repeat(65) }, { "x-basht-nonce": "n-post-000000002!" }, { "x-basht-nonce": "n-post 000000002" },
      { "x-basht-nonce": `${post.nonce}, ${post.nonce}` },
      { "x-basht-content-sha256": post.contentSha256.toUpperCase() }, { "x-basht-content-sha256": post.contentSha256.slice(1) }, { "x-basht-content-sha256": `${post.contentSha256}0` },
      { "x-basht-content-sha256": "z".repeat(64) },
      { "x-basht-signature": post.signature.slice(3) }, { "x-basht-signature": post.signature.toUpperCase() }, { "x-basht-signature": `${post.signature}00` }, { "x-basht-signature": "v1=" },
      { "x-basht-signature": `${post.signature}, ${post.signature}` }, { "x-basht-signature": "v1=zz" },
    ];
    for (const over of bad) assert.deepEqual(fresh().checkHeaders(req(post, { headers: hdr(post, over) })), { ok: false, reason: "malformed" }, JSON.stringify(over).slice(0, 70));
    // one header missing out of four
    for (const name of Object.values(SIGNING_HEADERS)) {
      const h = hdr(post); delete h[name];
      assert.deepEqual(fresh().checkHeaders(req(post, { headers: h })), { ok: false, reason: "malformed" }, name);
    }
    // an array (some servers give repeated headers that way) is not a string
    assert.equal(fresh().checkHeaders(req(post, { headers: hdr(post, { "x-basht-nonce": [post.nonce, post.nonce] }) })).reason, "malformed");
    assert.equal(spy.hmac, 0, "no HMAC was computed for any malformed request");
  } finally { crypto.createHmac = realHmac; }
});

test("verifier: modes — off ignores everything; optional accepts unsigned and verifies any signed; required refuses unsigned", () => {
  const unsigned = { method: "GET", originalUrl: "/app/v1/status", headers: {} };
  const garbage = { method: "GET", originalUrl: "/app/v1/status", headers: { "x-basht-signature": "garbage" } };
  const only = (name) => ({ method: "GET", originalUrl: "/app/v1/status", headers: { [name]: "x" } });
  const off = createSigningVerifier({ secret: CURRENT, mode: "off", now: clockAt(post) });
  assert.equal(off.mode, "off");
  assert.deepEqual(off.checkHeaders(unsigned), { ok: true, signed: false });
  assert.deepEqual(off.checkHeaders(garbage), { ok: true, signed: false });
  assert.deepEqual(off.checkHeaders(req(post, { headers: hdr(post, { "x-basht-signature": `v1=${"0".repeat(64)}` }) })), { ok: true, signed: false });
  const optional = fresh({ mode: "optional" });
  assert.equal(optional.mode, "optional");
  assert.deepEqual(optional.checkHeaders(unsigned), { ok: true, signed: false });
  for (const name of Object.values(SIGNING_HEADERS)) assert.equal(optional.checkHeaders(only(name)).ok, false, `${name} alone must verify fully`);
  assert.equal(optional.checkHeaders(garbage).ok, false);
  assert.equal(optional.checkHeaders(req(post)).signed, true);
  assert.deepEqual(optional.checkHeaders({ method: "GET", originalUrl: "/x", headers: { "x-basht-other": "1", "x-request-id": "2" } }), { ok: true, signed: false }, "unknown headers are ignored");
  const required = fresh({ mode: "required" });
  assert.deepEqual(required.checkHeaders(unsigned), { ok: false, reason: "missing" });
  assert.deepEqual(required.checkHeaders({ method: "GET", originalUrl: "/x", headers: { "x-basht-other": "1" } }), { ok: false, reason: "missing" });
  assert.equal(required.checkHeaders(req(post)).ok, true);
  // no valid secret: "required" is NEVER degraded (it fails closed in the router); "optional" has nothing to verify and accepts unsigned
  for (const secret of [undefined, null, "", "too-short"]) {
    const r = createSigningVerifier({ secret, mode: "required" });
    assert.deepEqual([r.mode, r.active, r.failClosed], ["required", false, true], String(secret));
    const o = createSigningVerifier({ secret, mode: "optional" });
    assert.deepEqual([o.mode, o.active, o.failClosed], ["optional", false, false]);
    assert.deepEqual(o.checkHeaders(garbage), { ok: true, signed: false }, "nothing to verify with: accepted as unsigned");
  }
  assert.equal(createSigningVerifier({ secret: CURRENT, mode: "bogus" }).mode, "optional", "an unknown mode is never off and never required");
  assert.deepEqual(createSigningVerifier({ secret: CURRENT, mode: "bogus" }).status().warnings, ["mode_invalid"]);
  assert.deepEqual([createSigningVerifier().mode, createSigningVerifier().active], ["off", false]);
});

// ---------------------------------------------------------------- environment ------------------------------------------------------------

test("env: off is explicit only; an unset or unknown mode is optional; required is never degraded; the 32-character floor", () => {
  const run = (env) => { const w = []; return { ...signingConfigFromEnv(env, (m) => w.push(m)), log: w }; };
  const base = (r) => [r.secret, r.previousSecret, r.mode, r.secretError, r.warnings];
  assert.deepEqual(base(run({})), [null, null, "optional", "secret_missing", []], "nothing set: optional with nothing to verify (not off)");
  assert.equal(run({}).log.length, 0, "silent");
  assert.deepEqual(base(run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT })), [CURRENT, null, "optional", null, []]);
  assert.equal(run({ BASHT_BRIDGE_SIGNING_SECRET: `  ${CURRENT}\n` }).secret, CURRENT, "trimmed, like the app token");
  const both = run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: PREVIOUS });
  assert.deepEqual([both.previousSecret, both.mode], [PREVIOUS, "optional"]);
  for (const mode of ["off", "optional", "required", " Required "]) assert.equal(run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_MODE: mode }).mode, mode.trim().toLowerCase());
  assert.equal(run({ BASHT_BRIDGE_SIGNING_MODE: "off" }).mode, "off", "off is possible, but only when asked for");
  // too short: not a secret (a warning, never the value)
  const short = run({ BASHT_BRIDGE_SIGNING_SECRET: "x".repeat(31) });
  assert.deepEqual([short.secret, short.mode, short.secretError, short.log.length], [null, "optional", "secret_invalid", 1]);
  assert.ok(!short.log.join().includes("xxx"));
  assert.equal(run({ BASHT_BRIDGE_SIGNING_SECRET: "x".repeat(32) }).secret, "x".repeat(32));
  const shortPrev = run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: "short" });
  assert.deepEqual([shortPrev.previousSecret, shortPrev.mode, shortPrev.log.length], [null, "optional", 1]);
  // required is NEVER turned into anything else: it is reported as required with the reason it cannot work, and a loud log line
  for (const [env, why] of [[{}, "secret_missing"], [{ BASHT_BRIDGE_SIGNING_SECRET: "short" }, "secret_invalid"],
    [{ BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: PREVIOUS }, "previous_only"], [{ BASHT_BRIDGE_SIGNING_SECRET: "short", BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: PREVIOUS }, "secret_invalid"]]) {
    const r = run({ ...env, BASHT_BRIDGE_SIGNING_MODE: "required" });
    assert.deepEqual([r.mode, r.secretError, r.secret], ["required", why, null], why);
    assert.ok(r.log.some((l) => l.includes("503 signing_unavailable") && l.includes(why)), `loud: ${r.log}`);
  }
  assert.deepEqual(run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_MODE: "required" }).log, [], "a usable secret: nothing to shout about");
  // an unknown mode value is optional with a warning: never required by typo, never silently off
  for (const typo of ["requierd", "on", "true", "enforce", "strict", "0"]) {
    const t = run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_MODE: typo });
    assert.deepEqual([t.mode, t.warnings, t.log.length], ["optional", ["mode_invalid"], 1], typo);
  }
  assert.deepEqual(base(run({ BASHT_BRIDGE_SIGNING_MODE: "requierd" })).slice(2, 5), ["optional", "secret_missing", ["mode_invalid"]]);
  const none = signingConfigFromEnv(undefined);
  assert.deepEqual([none.secret, none.mode, none.secretError], [null, "optional", "secret_missing"]);
});

// ---------------------------------------------------------------- the router -------------------------------------------------------------

let dir, configPath, gateway;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-signing-"));
  configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, "{}");
  gateway = async (url) => {
    // sessions_history / chat for the vectors that reach the engine
    if (String(url).endsWith("/v1/chat/completions")) return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ ok: true, result: { details: { sessionKey: "agent:main:app:owner", messages: [], hasMore: false } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A bridge mounted exactly like the wrapper does (/app/v1), with a controllable clock. */
async function mount({ signing, token = APP_TOKEN, clock = { t: V.cases[0].timestamp * 1000 }, transcribe = async () => "نص" } = {}) {
  const app = express();
  app.use("/app/v1", createAppBridge({ token, gatewayUrl: "http://127.0.0.1:9", gatewayToken: GW_TOKEN, configPath, fetchImpl: gateway, now: () => clock.t, transcribe,
    gatewayCall: async () => ({ ok: true }), ...(signing ? { signing: { bootEpoch: V.cases[0].timestamp - 100, ...signing } } : {}) })); // boot long before the vectors, unless a test says otherwise
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const send = async (c, { token: tk = APP_TOKEN, headers = {}, drop = [], body = bodyOf(c), target = c.target, method = c.method, type } = {}) => {
    const h = { ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...hdr(c), ...headers };
    for (const n of drop) delete h[n];
    const ct = type ?? (c.name === "post-binary-audio" ? "audio/ogg" : body.length ? "application/json" : undefined);
    if (ct) h["content-type"] = ct;
    const r = await fetch(origin + target, { method, headers: h, body: method === "GET" ? undefined : body });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const plain = (p, { headers = {}, token: tk = APP_TOKEN } = {}) => fetch(`${origin}/app/v1${p}`, { headers: { ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  return { origin, send, plain, clock, close: () => srv.close() };
}
/** The `signing` object of GET /status for a mode that is verifying, or not. */
const shape = (mode, active, extra = {}) => ({ mode, active, warnings: [], replayProtection: "memory+boot_fence", ...extra });
const CONF = { secret: CURRENT, previousSecret: PREVIOUS, mode: "optional" };
const passed = (r) => r.status !== 401 && r.status !== 429;

test("router: every vector, over HTTP, is accepted by its own method, target, body and secret — JSON, big JSON, raw audio, empty POST, GET with a query", async () => {
  for (const c of V.cases) {
    const m = await mount({ signing: { ...CONF, mode: "required" }, clock: { t: c.timestamp * 1000 } });
    try {
      const r = await m.send(c);
      assert.ok(passed(r), `${c.name}: ${r.status} ${JSON.stringify(r.json)}`);
      // the exact request again is a replay
      const again = await m.send(c);
      assert.deepEqual([again.status, again.json], [401, { ok: false, error: "bad_signature" }], `${c.name}: replay`);
    } finally { m.close(); }
  }
});

test("router: the body hash is enforced on every parser (json, the larger /send parser, raw audio); GET and empty bodies hash as empty", async () => {
  const [get, jsonPost, empty, audio] = V.cases;
  const m = await mount({ signing: { ...CONF, mode: "required" }, clock: { t: jsonPost.timestamp * 1000 } });
  const sha = (b) => sha256Hex(b);
  const signed = (c, over) => ({ ...hdr(c), ...over });
  try {
    // a tampered body: the headers were made for the original
    for (const [c, tampered] of [[jsonPost, Buffer.from('{"message":"مرحبا!"}')], [audio, Buffer.from([9, 9, 9])]]) {
      const r = await m.send(c, { body: tampered });
      assert.deepEqual([r.status, r.json], [401, { ok: false, error: "bad_signature" }], c.name);
    }
    // the same bytes with the header claiming another hash: the signature no longer matches
    assert.equal((await m.send(jsonPost, { headers: { "x-basht-content-sha256": sha(Buffer.from("other")) } })).status, 401);
    // a body on a request signed as empty
    const withBody = await m.send(empty, { body: Buffer.from("{}"), type: "application/json" });
    assert.equal(withBody.status, 401);
    // a GET that signed the empty hash passes; the vector proves the opposite direction (non-empty hash, no body) fails
    assert.ok(passed(await m.send(get)));
    const noBodyButHashed = await m.send(jsonPost, { body: Buffer.alloc(0), type: "application/json" });
    assert.equal(noBodyButHashed.status, 401);
    assert.ok(signed(get, {})["x-basht-nonce"]);
  } finally { m.close(); }
  // a /send body over the 64 kB default (the larger parser) hashes the same way
  const big = Buffer.from(JSON.stringify({ message: "x".repeat(2000), images: [], pad: "p".repeat(70_000) }));
  const mk = (body, nonce) => {
    const c = { method: "POST", target: "/app/v1/send", timestamp: jsonPost.timestamp, nonce, contentSha256: sha(body) };
    return { ...c, name: "big", signature: signCanonical(CURRENT, canonicalString(c)), bodyBase64: body.toString("base64") };
  };
  const m2 = await mount({ signing: { ...CONF, mode: "required" }, clock: { t: jsonPost.timestamp * 1000 } });
  try {
    const good = await m2.send(mk(big, "big-nonce-0000001"));
    assert.ok(passed(good), `${good.status} ${JSON.stringify(good.json)}`);
    const c2 = mk(big, "big-nonce-0000002");
    const bad = await m2.send(c2, { body: Buffer.from(big.toString("utf8").replace("pppp", "pppq")) }); // still valid JSON, one byte different
    assert.equal(bad.status, 401);
  } finally { m2.close(); }
});

test("router: modes over HTTP — off ignores signatures; optional: unsigned passes, any signing header must verify; required: unsigned is 401", async () => {
  const c = V.cases[0];
  const clock = { t: c.timestamp * 1000 };
  const off = await mount({ clock });
  const optional = await mount({ signing: CONF, clock });
  const required = await mount({ signing: { ...CONF, mode: "required" }, clock });
  const explicitOff = await mount({ signing: { ...CONF, mode: "off" }, clock });
  try {
    for (const [m, label] of [[off, "no config"], [explicitOff, "mode off"]]) {
      assert.equal((await m.plain("/status")).status, 200, `${label}: unsigned`);
      assert.equal((await m.plain("/status", { headers: { "x-basht-signature": "garbage", "x-basht-nonce": "x" } })).status, 200, `${label}: garbage headers are ignored`);
      assert.deepEqual((await m.plain("/status")).json.signing, shape("off", false));
    }
    // optional: never locks anyone out. A signature that is present but not valid is processed as an UNSIGNED request (the bearer
    // token still applies) and the reason is remembered for /status
    assert.equal((await optional.plain("/status")).status, 200, "an old app (no headers) keeps working");
    assert.deepEqual((await optional.plain("/status")).json.signing, shape("optional", true), "nothing rejected so far");
    const garbage = await optional.plain("/status", { headers: { "x-basht-signature": "garbage" } });
    assert.equal(garbage.status, 200, "a wrong signature does not lock the owner out");
    assert.deepEqual(garbage.json.signing.mode, "optional");
    assert.deepEqual((await optional.plain("/status")).json.signing, shape("optional", true, { lastRejected: { reason: "malformed", at: clock.t } }));
    assert.equal((await optional.plain("/status", { headers: { "x-basht-nonce": "a".repeat(20) } })).status, 200, "one header alone: unsigned");
    const g = V.cases[0];
    assert.equal((await optional.send(g)).status, 200, "a valid signed GET passes");
    assert.equal((await optional.send({ ...g, nonce: "n-get-0000000009" })).status, 200, "a header set that does not match: accepted as unsigned");
    assert.equal((await optional.plain("/status")).json.signing.lastRejected.reason, "signature");
    assert.equal((await optional.plain("/status", { token: "wrong" })).status, 401, "the bearer token check still applies");
    // required
    assert.deepEqual((await required.plain("/status")).json, { ok: false, error: "bad_signature" });
    assert.equal((await required.plain("/status")).status, 401);
    assert.equal((await required.send(g)).status, 200);
    assert.deepEqual((await required.plain("/status", { headers: { "x-basht-other": "1" } })).json, { ok: false, error: "bad_signature" });
  } finally { off.close(); optional.close(); required.close(); explicitOff.close(); }
});

test("router: the bearer token check always runs first and stays as it is (a signature alone is not enough, nor is a bad token with a good signature)", async () => {
  const c = V.cases[0];
  const m = await mount({ signing: { ...CONF, mode: "required" }, clock: { t: c.timestamp * 1000 } });
  try {
    assert.deepEqual((await m.send(c, { token: null })).json, { ok: false, error: "unauthorized" });
    assert.deepEqual((await m.send(c, { token: GW_TOKEN })).json, { ok: false, error: "unauthorized" });
    assert.deepEqual((await m.send(c, { token: `${APP_TOKEN}x` })).json, { ok: false, error: "unauthorized" });
    assert.equal((await m.send(c, { token: APP_TOKEN })).status, 200, "the nonce was not spent by the refused attempts");
  } finally { m.close(); }
});

test("router: failed signatures count in the SAME limiter as bad tokens (429 after 20 a minute); a valid signed request still passes", async () => {
  const c = V.cases[0];
  const clock = { t: c.timestamp * 1000 };
  const m = await mount({ signing: { ...CONF, mode: "required" }, clock });
  try {
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await m.plain("/status", { token: `wrong-token-${i}` })).status); // bad tokens ...
    for (let i = 0; i < 12; i++) statuses.push((await m.plain("/status")).status); // ... and unsigned requests with the right token
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(401));
    assert.deepEqual(statuses.slice(20), Array(4).fill(429), "the 21st failure of either kind is 429 rate_limited");
    assert.deepEqual((await m.plain("/status")).json, { ok: false, error: "rate_limited" });
    assert.equal((await m.send(c)).status, 200, "the owner's valid signed request is never locked out");
    // the window resets after a minute
    clock.t += 61_000;
    assert.equal((await m.plain("/status")).status, 401);
  } finally { m.close(); }
  // and a body-hash failure counts too
  const j = V.cases[1];
  const m2 = await mount({ signing: { ...CONF, mode: "required" }, clock: { t: j.timestamp * 1000 } });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await m2.send(j, { body: Buffer.from(`{"message":"${i}"}`) })).status, 401);
    assert.equal((await m2.send(j, { body: Buffer.from('{"message":"x"}') })).status, 429);
  } finally { m2.close(); }
});

test("router: rotation — the previous secret keeps working next to the new one; dropping it ends it", async () => {
  const prev = V.cases.find((c) => c.signedWith === "previous");
  const cur = V.cases[0];
  const clock = { t: prev.timestamp * 1000 };
  const both = await mount({ signing: { ...CONF, mode: "required" }, clock });
  const onlyNew = await mount({ signing: { secret: CURRENT, mode: "required" }, clock });
  try {
    assert.ok(passed(await both.send(prev)), "signed with the previous secret");
    assert.ok(passed(await both.send(cur)), "signed with the current secret");
    assert.equal((await onlyNew.send(prev)).status, 401, "after the previous secret is removed");
    assert.ok(passed(await onlyNew.send(cur)));
  } finally { both.close(); onlyNew.close(); }
});

test("router: clock skew and replay over HTTP", async () => {
  const c = V.cases[0];
  const clock = { t: c.timestamp * 1000 };
  const m = await mount({ signing: { ...CONF, mode: "required" }, clock });
  try {
    clock.t = (c.timestamp + 61) * 1000;
    assert.equal((await m.send(c)).status, 401, "61 s late");
    clock.t = (c.timestamp - 61) * 1000;
    assert.equal((await m.send(c)).status, 401, "61 s early");
    clock.t = c.timestamp * 1000;
    assert.equal((await m.send(c)).status, 200);
    assert.equal((await m.send(c)).status, 401, "replay");
  } finally { m.close(); }
});

test("router: the request target is signed as received — a query change, a path change or another method is refused", async () => {
  const c = V.cases[0];
  const m = await mount({ signing: { ...CONF, mode: "required" }, clock: { t: c.timestamp * 1000 } });
  try {
    assert.equal((await m.send(c, { target: "/app/v1/history?key=agent%3Amain%3Aapp%3Aowner&limit=51" })).status, 401);
    assert.equal((await m.send({ ...c, nonce: "n-get-0000000010" }, { target: c.target })).status, 401);
    assert.equal((await m.send(c, { target: "/app/v1/sessions" })).status, 401);
    assert.equal((await m.send(c, { method: "POST", body: Buffer.alloc(0) })).status, 401);
    assert.equal((await m.send(c)).status, 200, "the untouched request still works (nothing above spent its nonce)");
  } finally { m.close(); }
});

test("router: status reports the mode and never a secret", async () => {
  const m = await mount({ signing: { ...CONF, mode: "required" }, clock: { t: V.cases[0].timestamp * 1000 } });
  try {
    const r = await m.send(V.cases[0], { target: "/app/v1/status", headers: {} }).catch(() => null);
    assert.ok(r === null || r.status === 401, "a signature for another target is refused");
    const c = { method: "GET", target: "/app/v1/status", timestamp: V.cases[0].timestamp, nonce: "n-status-0000001", contentSha256: sha256Hex(Buffer.alloc(0)) };
    c.signature = signCanonical(CURRENT, canonicalString(c));
    c.bodyBase64 = "";
    const ok = await m.send(c);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.signing, shape("required", true, { lastRejected: { reason: "signature", at: V.cases[0].timestamp * 1000 } }), "the refused attempt above is what /status remembers");
    const blob = JSON.stringify(ok.json);
    assert.ok(!blob.includes(CURRENT) && !blob.includes(PREVIOUS));
  } finally { m.close(); }
});

test("compatibility: no signing configured = exactly the old behaviour; an unsigned client works in optional; unknown headers are ignored by an engine without signing", async () => {
  const clock = { t: V.cases[0].timestamp * 1000 };
  const old = await mount({ clock }); // the engine as before this feature (new app + old engine: its headers are just unknown headers)
  try {
    const c = V.cases[0];
    assert.equal((await old.send(c)).status, 200, "new app, engine without signing configured");
    assert.equal((await old.send(c)).status, 200, "even the same nonce twice: nothing is checked");
    assert.equal((await old.send({ ...c, signature: "v1=bad" })).status, 200);
    assert.equal((await old.plain("/status")).json.signing.mode, "off");
  } finally { old.close(); }
  // a bridge built without any signing option and one built with an empty/short secret behave the same
  for (const signing of [undefined, {}, { secret: "", mode: "required" }, { secret: "short", mode: "required" }, { secret: null, previousSecret: PREVIOUS, mode: "required" }]) {
    const m = await mount({ signing, clock });
    try { assert.equal((await m.plain("/status")).status, 200, JSON.stringify(signing)); } finally { m.close(); }
  }
});

test("a bridge refuses to exist without the app token, signing or not", () => {
  assert.equal(createAppBridge({ token: "short", gatewayUrl: "x", gatewayToken: "y", configPath: "z", signing: { secret: CURRENT, mode: "required" } }), null);
});

test("a previous secret without a current one is NOT a way in: required fails closed (previous_only), optional has nothing to verify", () => {
  const r = createSigningVerifier({ secret: null, previousSecret: PREVIOUS, mode: "required" });
  assert.deepEqual([r.mode, r.active, r.failClosed], ["required", false, true]);
  assert.deepEqual(r.status(), { mode: "required", active: false, error: "previous_only", warnings: [], replayProtection: "memory+boot_fence" });
  assert.deepEqual(createSigningVerifier({ secret: "short", previousSecret: PREVIOUS, mode: "required" }).status().error, "secret_invalid");
  assert.deepEqual(createSigningVerifier({ mode: "required" }).status().error, "secret_missing");
  assert.deepEqual(createSigningVerifier({ secret: null, previousSecret: PREVIOUS, mode: "optional" }).status(), { mode: "optional", active: false, reason: "previous_only", warnings: [], replayProtection: "memory+boot_fence" });
  // the retired key never verifies anything on its own
  const prev = V.cases.find((c) => c.signedWith === "previous");
  assert.deepEqual(createSigningVerifier({ secret: null, previousSecret: PREVIOUS, mode: "optional", now: clockAt(prev) }).checkHeaders(req(prev)), { ok: true, signed: false });
  // a too-short previous secret next to a good current one is simply not a second key
  assert.equal(createSigningVerifier({ secret: CURRENT, previousSecret: "short", mode: "required", now: clockAt(prev) }).checkHeaders(req(prev)).reason, "signature");
});

test("server.js reads the signing variables once, passes them to the bridge and removes both secrets from process.env like the app token", () => {
  const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const read = src.indexOf("signingConfigFromEnv(process.env");
  const bridge = src.indexOf("createAppBridge({");
  const delToken = src.indexOf("delete process.env.BASHT_APP_TOKEN;");
  const delSecret = src.indexOf("delete process.env.BASHT_BRIDGE_SIGNING_SECRET;");
  const delPrev = src.indexOf("delete process.env.BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS;");
  assert.ok(bridge > 0 && read > bridge, "read while the bridge is being created");
  assert.ok(delToken > read && delSecret > read && delPrev > read, "removed only after it was read");
  assert.equal([...src.matchAll(/BASHT_BRIDGE_SIGNING_SECRET\b(?!_PREVIOUS)/g)].length, 1, "the secret's name appears once in server.js (the delete)");
});

test("router (I3): in optional a present-but-invalid signature is processed as UNSIGNED, never as verified — skew, replay, wrong secret, tampered body, wrong target", async () => {
  const [get, jsonPost] = V.cases;
  const clock = { t: get.timestamp * 1000 };
  const m = await mount({ signing: { ...CONF, mode: "optional" }, clock });
  const last = async () => (await m.plain("/status")).json.signing.lastRejected;
  try {
    // skew
    clock.t = (get.timestamp + 120) * 1000;
    assert.equal((await m.send(get)).status, 200);
    assert.equal((await last()).reason, "skew");
    // replay: the first is verified (no new rejection), the second is a replay and still accepted as unsigned
    clock.t = get.timestamp * 1000;
    assert.equal((await m.send(get)).status, 200);
    assert.equal((await last()).reason, "skew", "a valid signed request is not a rejection");
    assert.equal((await m.send(get)).status, 200);
    assert.equal((await last()).reason, "replay");
    // a wrong secret (a typo on one side)
    const typo = await mount({ signing: { secret: "another-secret-another-secret-another-secret", mode: "optional" }, clock });
    try {
      assert.equal((await typo.send(get)).status, 200, "the owner is not locked out by a mistyped secret");
      assert.equal((await typo.plain("/status")).json.signing.lastRejected.reason, "signature");
    } finally { typo.close(); }
    // a tampered body with valid-looking headers: accepted as an unsigned request, but NOT trusted as signed (reason "body")
    const tampered = await m.send(jsonPost, { body: Buffer.from('{"message":"another message"}') });
    assert.equal(tampered.status, 202, "processed like an unsigned request (the turn starts)");
    assert.equal((await last()).reason, "body");
    // the original body of that very request was not spent as verified: it still verifies once (its nonce is the one the tamper used)
    const target = await m.send(get, { target: "/app/v1/sessions" });
    assert.equal(target.status, 200);
    // no rejection ever shows a header value or a secret
    const blob = JSON.stringify((await m.plain("/status")).json);
    assert.ok(!blob.includes(CURRENT) && !blob.includes(get.nonce) && !blob.includes(get.signature));
  } finally { m.close(); }
});

test("router (I3): only required counts signature failures in the limiter; optional failures never reach 429", async () => {
  const c = V.cases[0];
  const m = await mount({ signing: { ...CONF, mode: "optional" }, clock: { t: c.timestamp * 1000 } });
  try {
    for (let i = 0; i < 30; i++) assert.equal((await m.plain("/status", { headers: { "x-basht-signature": "garbage" } })).status, 200, `attempt ${i}`);
    assert.equal((await m.plain("/status", { token: "wrong" })).status, 401, "bad TOKENS still count and still answer 401 first");
  } finally { m.close(); }
});

test("router (I3): the rejection reason is logged once a minute per reason, without any header value", async () => {
  const c = V.cases[0];
  const clock = { t: c.timestamp * 1000 };
  const lines = [];
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:9", gatewayToken: GW_TOKEN, configPath, fetchImpl: gateway, now: () => clock.t,
    log: { warn: (_t, m) => lines.push(m), info() {} }, signing: { ...CONF, mode: "optional" } }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const hit = (headers) => fetch(`http://127.0.0.1:${srv.address().port}/app/v1/status`, { headers: { authorization: `Bearer ${APP_TOKEN}`, ...headers } });
  try {
    for (let i = 0; i < 5; i++) await hit({ "x-basht-signature": "garbage-value-xyz" });
    assert.deepEqual(lines, ["signature rejected: malformed (mode optional)"]);
    clock.t += 30_000;
    await hit({ "x-basht-signature": "garbage-value-xyz" });
    assert.equal(lines.length, 1, "still within the minute");
    clock.t += 31_000;
    await hit({ "x-basht-signature": "garbage-value-xyz" });
    assert.equal(lines.length, 2);
    assert.ok(!lines.join().includes("garbage-value-xyz"));
  } finally { srv.close(); }
});

test("router (A): 'required' without a usable secret FAILS CLOSED — 503 signing_unavailable on everything but GET /status, never unsigned acceptance", async () => {
  const clock = { t: V.cases[0].timestamp * 1000 };
  const lines = [];
  for (const [env, error] of [[{}, "secret_missing"], [{ BASHT_BRIDGE_SIGNING_SECRET: "short" }, "secret_invalid"], [{ BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: PREVIOUS }, "previous_only"]]) {
    const signing = signingConfigFromEnv({ ...env, BASHT_BRIDGE_SIGNING_MODE: "required" }, () => {});
    const app = express();
    app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:9", gatewayToken: GW_TOKEN, configPath, fetchImpl: gateway, now: () => clock.t,
      transcribe: async () => "x", gatewayCall: async () => ({ ok: true }), log: { warn: (_t, m) => lines.push(m), info() {} }, signing }));
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const o = `http://127.0.0.1:${srv.address().port}/app/v1`;
    const h = { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" };
    try {
      for (const [method, p, body] of [["GET", "/sessions"], ["GET", "/history"], ["POST", "/send", '{"message":"x"}'], ["POST", "/speak", '{"text":"x"}'], ["POST", "/new"],
        ["GET", "/events"], ["GET", "/approvals"], ["GET", "/media"], ["GET", "/nope"], ["DELETE", "/status"], ["POST", "/status"], ["GET", "/status/x"], ["HEAD", "/status"]]) {
        const r = await fetch(o + p, { method, headers: h, body });
        if (method === "HEAD") { assert.equal(r.status, 503, `${method} ${p}`); continue; }
        assert.equal(r.status, 503, `${error} ${method} ${p}`);
        assert.deepEqual(await r.json(), { ok: false, error: "signing_unavailable" });
      }
      // a valid-looking signature does not help: there is no secret to verify it with
      const c = V.cases[0];
      const signed = await fetch(o + "/sessions", { headers: { ...h, ...hdr(c) } });
      assert.equal(signed.status, 503);
      // the bearer check still comes first
      assert.deepEqual(await (await fetch(o + "/sessions")).json(), { ok: false, error: "unauthorized" });
      assert.equal((await fetch(o + "/sessions", { headers: { authorization: "Bearer wrong" } })).status, 401);
      // GET /status stays reachable with the bearer and says why
      const st = await fetch(o + "/status", { headers: h });
      assert.equal(st.status, 200);
      assert.deepEqual((await st.json()).signing, shape("required", false, { error }));
      assert.deepEqual((await (await fetch(o + "/status")).json()), { ok: false, error: "unauthorized" }, "not without the bearer");
    } finally { srv.close(); }
  }
  assert.ok(lines.length >= 3 && lines.every((l) => /signing is required but its secret is unusable \((secret_missing|secret_invalid|previous_only)\)/.test(l)), JSON.stringify(lines));
});

test("router (A): the 503 refusals are logged loudly but throttled, and never carry a secret", async () => {
  const clock = { t: V.cases[0].timestamp * 1000 };
  const lines = [];
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:9", gatewayToken: GW_TOKEN, configPath, fetchImpl: gateway, now: () => clock.t,
    log: { warn: (_t, m) => lines.push(m), info() {} }, signing: signingConfigFromEnv({ BASHT_BRIDGE_SIGNING_SECRET: "tiny-secret-value", BASHT_BRIDGE_SIGNING_MODE: "required" }, () => {}) }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try {
    for (let i = 0; i < 6; i++) await fetch(`http://127.0.0.1:${srv.address().port}/app/v1/sessions`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });
    assert.equal(lines.length, 1);
    clock.t += 61_000;
    await fetch(`http://127.0.0.1:${srv.address().port}/app/v1/sessions`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });
    assert.equal(lines.length, 2);
    assert.ok(!lines.join().includes("tiny-secret-value"));
  } finally { srv.close(); }
});

test("router (A): optional without a usable secret accepts unsigned requests and says why; an unknown mode is optional + mode_invalid; off is explicit", async () => {
  const clock = { t: V.cases[0].timestamp * 1000 };
  const opt = await mount({ signing: signingConfigFromEnv({}, () => {}), clock });
  const typo = await mount({ signing: signingConfigFromEnv({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_MODE: "requierd" }, () => {}), clock });
  const off = await mount({ signing: signingConfigFromEnv({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_MODE: "off" }, () => {}), clock });
  try {
    const a = await opt.plain("/status");
    assert.equal(a.status, 200);
    assert.deepEqual(a.json.signing, shape("optional", false, { reason: "secret_missing" }));
    assert.equal((await opt.plain("/sessions")).status, 200, "requests are accepted unsigned");
    assert.equal((await opt.plain("/status", { headers: { "x-basht-signature": "garbage" } })).status, 200);
    const t = await typo.plain("/status");
    assert.deepEqual(t.json.signing, { mode: "optional", active: true, warnings: ["mode_invalid"], replayProtection: "memory+boot_fence" });
    assert.equal((await typo.plain("/sessions")).status, 200, "an unsigned request is not refused by a mistyped mode");
    assert.deepEqual((await off.plain("/status")).json.signing, shape("off", false));
  } finally { opt.close(); typo.close(); off.close(); }
});

/** A signed GET of `target` as `send()` expects it (a vector-shaped case). */
function signedGet(target, timestamp, nonce) {
  const contentSha256 = sha256Hex(Buffer.alloc(0));
  const c = { method: "GET", target, timestamp, nonce, contentSha256 };
  return { ...c, name: "signed-get", bodyBase64: "", signature: signCanonical(CURRENT, canonicalString(c)) };
}

// ---------------------------------------------------------------- (B) the restart fence ----------------------------------------------------

test("restart fence: a signed request stamped before the process started is refused (before_boot); one stamped after passes", () => {
  const boot = post.timestamp + 30; // the capture is 30 s older than this process, and still inside the 60 s clock window
  const at = (c, over = {}) => createSigningVerifier({ secret: CURRENT, previousSecret: PREVIOUS, mode: "required", bootEpoch: boot, now: () => (boot + 5) * 1000, ...over }).checkHeaders(req(c));
  assert.deepEqual(at(post), { ok: false, reason: "before_boot" }, "a pre-restart capture, even with a genuine signature, inside the clock window");
  // a genuine request stamped after the start passes; the two-second tolerance covers clock rounding
  const stamp = (ts, nonce) => {
    const sha = sha256Hex(Buffer.alloc(0));
    const c = { method: "GET", target: "/app/v1/status", timestamp: ts, nonce, contentSha256: sha };
    return { method: "GET", originalUrl: c.target, headers: { "x-basht-timestamp": String(ts), "x-basht-nonce": nonce, "x-basht-content-sha256": sha, "x-basht-signature": signCanonical(CURRENT, canonicalString(c)) } };
  };
  const v = (over) => createSigningVerifier({ secret: CURRENT, mode: "required", bootEpoch: boot, now: () => (boot + 5) * 1000, ...over });
  assert.equal(v().checkHeaders(stamp(boot + 1, "post-boot-nonce-0001")).ok, true);
  assert.equal(v().checkHeaders(stamp(boot, "at-boot-nonce-000001")).ok, true);
  assert.equal(v().checkHeaders(stamp(boot - 2, "edge-nonce-0000000001")).ok, true, "boot - 2 s is the tolerance");
  assert.deepEqual(v().checkHeaders(stamp(boot - 3, "before-nonce-00000001")), { ok: false, reason: "before_boot" });
  assert.equal(BOOT_FENCE_SECONDS, 2);
  // the default boot epoch is the moment the verifier is made (the process start)
  let t = 5_000_000_000;
  const started = createSigningVerifier({ secret: CURRENT, mode: "required", now: () => t });
  assert.equal(started.bootEpoch, 5_000_000);
  t += 10_000;
  assert.deepEqual(started.checkHeaders(stamp(5_000_000 - 3, "captured-nonce-000001")), { ok: false, reason: "before_boot" });
  assert.equal(started.checkHeaders(stamp(5_000_000 + 8, "fresh-nonce-00000001")).ok, true);
});

test("restart fence: the shared vectors still verify with a boot epoch earlier than their timestamps; and a 'restart' makes the same captured request fail", () => {
  for (const c of V.cases) {
    const v = createSigningVerifier({ secret: CURRENT, previousSecret: PREVIOUS, mode: "required", now: clockAt(c), bootEpoch: c.timestamp - 3600 });
    assert.deepEqual(v.checkHeaders(req(c)), { ok: true, signed: true, contentSha256: c.contentSha256 }, c.name);
  }
  // before a restart the request verifies once, replay is refused; after a restart (new process: empty nonce memory, later boot) the SAME capture is refused
  const c = V.cases[1];
  const before = createSigningVerifier({ secret: CURRENT, mode: "required", now: clockAt(c), bootEpoch: c.timestamp - 10 });
  assert.equal(before.checkHeaders(req(c)).ok, true);
  assert.equal(before.checkHeaders(req(c)).reason, "replay");
  const after = createSigningVerifier({ secret: CURRENT, mode: "required", now: () => (c.timestamp + 30) * 1000, bootEpoch: c.timestamp + 20 });
  assert.deepEqual(after.checkHeaders(req(c)), { ok: false, reason: "before_boot" }, "the nonce memory is gone, the fence is not");
});

test("restart fence over HTTP: required => 401 bad_signature; optional => accepted as unsigned with lastRejected before_boot", async () => {
  const c = V.cases[0];
  const clock = { t: (c.timestamp + 100) * 1000 };
  const req_ = await mount({ signing: { ...CONF, mode: "required", bootEpoch: c.timestamp + 90 }, clock });
  const opt = await mount({ signing: { ...CONF, mode: "optional", bootEpoch: c.timestamp + 90 }, clock });
  try {
    clock.t = (c.timestamp + 50) * 1000; // the captured request is still inside the 60 s window ...
    const a = await req_.send(c);
    assert.deepEqual([a.status, a.json], [401, { ok: false, error: "bad_signature" }]);
    const b = await opt.send(c);
    assert.equal(b.status, 200, "optional never locks out");
    assert.equal((await opt.plain("/status")).json.signing.lastRejected.reason, "before_boot");
    // "required" needs a signed request even to read /status: a fresh one (stamped after the boot) works and shows the same reason
    clock.t = (c.timestamp + 95) * 1000;
    const st = await req_.send(signedGet("/app/v1/status", c.timestamp + 95, "status-after-boot-0001"));
    assert.equal(st.status, 200);
    assert.equal(st.json.signing.lastRejected.reason, "before_boot");
  } finally { req_.close(); opt.close(); }
});

test("status: signing.replayProtection says memory+boot_fence in every mode (and the docs say it is not durable)", async () => {
  for (const signing of [undefined, { ...CONF, mode: "optional" }, { ...CONF, mode: "required" }, { ...CONF, mode: "off" }]) {
    const m = await mount({ signing });
    try {
      const r = signing?.mode === "required" ? await m.send(signedGet("/app/v1/status", V.cases[0].timestamp, "replay-status-0000001")) : await m.plain("/status");
      assert.equal(r.json.signing.replayProtection, "memory+boot_fence");
    } finally { m.close(); }
  }
  const docs = fs.readFileSync(new URL("../docs/BASHT_APP_BRIDGE.md", import.meta.url), "utf8");
  assert.match(docs, /NOT durable/);
  assert.match(docs, /single replica/);
  const src = fs.readFileSync(new URL("./app-bridge-signing.js", import.meta.url), "utf8");
  assert.match(src, /NOT DURABLE/);
});
