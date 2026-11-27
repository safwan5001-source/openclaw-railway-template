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
import { MAX_SKEW_SECONDS, MIN_SECRET_LENGTH, NONCE_MAX_ENTRIES, NONCE_TTL_MS, SIGNING_HEADERS, canonicalString, createSigningVerifier, sha256Hex,
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
  const at = (deltaSeconds) => createSigningVerifier({ secret: CURRENT, mode: "required", now: () => (post.timestamp + deltaSeconds) * 1000 }).checkHeaders(req(post));
  assert.equal(MAX_SKEW_SECONDS, 60);
  assert.equal(at(0).ok, true);
  assert.equal(at(60).ok, true);
  assert.equal(at(-60).ok, true);
  assert.deepEqual(at(61), { ok: false, reason: "skew" });
  assert.deepEqual(at(-61), { ok: false, reason: "skew" });
  assert.deepEqual(at(3600), { ok: false, reason: "skew" });
  const v = createSigningVerifier({ secret: CURRENT, mode: "required", now: () => (post.timestamp + 60) * 1000 + 999 });
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
  // no valid secret: the verifier is off whatever the mode says (it could never verify anything)
  for (const secret of [undefined, null, "", "too-short"]) assert.equal(createSigningVerifier({ secret, mode: "required" }).mode, "off");
  assert.equal(createSigningVerifier({ secret: CURRENT, mode: "bogus" }).mode, "off");
  assert.equal(createSigningVerifier().mode, "off");
});

// ---------------------------------------------------------------- environment ------------------------------------------------------------

test("env: defaults, the 32-character floor, the mode switch, and required never enforced without a secret", () => {
  const run = (env) => { const w = []; return { ...signingConfigFromEnv(env, (m) => w.push(m)), warnings: w }; };
  assert.deepEqual(run({}), { secret: null, previousSecret: null, mode: "off", warnings: [] }, "nothing set: off, silent");
  assert.deepEqual(run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT }), { secret: CURRENT, previousSecret: null, mode: "optional", warnings: [] });
  assert.equal(run({ BASHT_BRIDGE_SIGNING_SECRET: `  ${CURRENT}\n` }).secret, CURRENT, "trimmed, like the app token");
  const both = run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: PREVIOUS });
  assert.equal(both.previousSecret, PREVIOUS);
  assert.equal(both.mode, "optional");
  for (const mode of ["off", "optional", "required", " Required "]) assert.equal(run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_MODE: mode }).mode, mode.trim().toLowerCase());
  // too short: ignored with one warning each
  const short = run({ BASHT_BRIDGE_SIGNING_SECRET: "x".repeat(31) });
  assert.deepEqual([short.secret, short.mode, short.warnings.length], [null, "off", 1]);
  assert.ok(!short.warnings.join().includes("xxx"), "the warning never carries the value");
  assert.equal(run({ BASHT_BRIDGE_SIGNING_SECRET: "x".repeat(32) }).secret, "x".repeat(32));
  const shortPrev = run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: "short" });
  assert.deepEqual([shortPrev.previousSecret, shortPrev.mode, shortPrev.warnings.length], [null, "optional", 1]);
  // a previous secret alone is meaningless
  const prevOnly = run({ BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS: PREVIOUS });
  assert.deepEqual([prevOnly.secret, prevOnly.previousSecret, prevOnly.mode, prevOnly.warnings.length], [null, null, "off", 1]);
  // "required" without a valid secret never enables (a typo cannot lock the owner out); so does "optional"
  for (const mode of ["required", "optional"]) {
    const r = run({ BASHT_BRIDGE_SIGNING_MODE: mode });
    assert.deepEqual([r.mode, r.warnings.length], ["off", 1], mode);
    assert.equal(run({ BASHT_BRIDGE_SIGNING_SECRET: "short", BASHT_BRIDGE_SIGNING_MODE: mode }).mode, "off");
  }
  assert.deepEqual(run({ BASHT_BRIDGE_SIGNING_MODE: "off" }), { secret: null, previousSecret: null, mode: "off", warnings: [] });
  // an unknown mode falls back to the default and says so
  const typo = run({ BASHT_BRIDGE_SIGNING_SECRET: CURRENT, BASHT_BRIDGE_SIGNING_MODE: "requierd" });
  assert.deepEqual([typo.mode, typo.warnings.length], ["optional", 1]);
  assert.equal(run({ BASHT_BRIDGE_SIGNING_MODE: "requierd" }).mode, "off");
  assert.deepEqual(signingConfigFromEnv(undefined), { secret: null, previousSecret: null, mode: "off" });
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
    gatewayCall: async () => ({ ok: true }), ...(signing ? { signing } : {}) }));
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
      assert.deepEqual((await m.plain("/status")).json.signing, { mode: "off" });
    }
    // optional
    assert.equal((await optional.plain("/status")).status, 200, "an old app (no headers) keeps working");
    assert.deepEqual((await optional.plain("/status")).json.signing, { mode: "optional" });
    assert.equal((await optional.plain("/status", { headers: { "x-basht-signature": "garbage" } })).status, 401);
    assert.equal((await optional.plain("/status", { headers: { "x-basht-nonce": "a".repeat(20) } })).status, 401, "one header alone must verify fully");
    const g = V.cases[0];
    assert.equal((await optional.send(g)).status, 200, "a valid signed GET passes");
    assert.equal((await optional.send({ ...g, nonce: "n-get-0000000009" })).status, 401, "a header set that does not match is refused, not ignored");
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
  const both = await mount({ signing: CONF, clock });
  const onlyNew = await mount({ signing: { secret: CURRENT, mode: "optional" }, clock });
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
  const m = await mount({ signing: CONF, clock });
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
  const m = await mount({ signing: CONF, clock: { t: c.timestamp * 1000 } });
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
    assert.deepEqual(ok.json.signing, { mode: "required" });
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

test("a previous secret without a current one never enforces anything (a retired key must not lock the owner out)", () => {
  assert.equal(createSigningVerifier({ secret: null, previousSecret: PREVIOUS, mode: "required" }).mode, "off");
  assert.equal(createSigningVerifier({ secret: "short", previousSecret: PREVIOUS, mode: "required" }).mode, "off");
  // a too-short previous secret next to a good current one is simply not a second key
  const prev = V.cases.find((c) => c.signedWith === "previous");
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
