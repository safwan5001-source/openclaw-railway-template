// BASHT app bridge, batch 3: the additive trusted-status fields of GET /app/v1/status (wrapper.commit, attachments, extra features).
// No gateway at all (link off, no gatewayCall): /status must stay cheap and never depend on the engine.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import express from "express";
import { createAppBridge } from "./app-bridge.js";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_TOTAL_BYTES, MAX_INLINE_BYTES, MAX_MEDIA_BYTES } from "./app-bridge-media.js";
import { EXTRA_FEATURES, attachmentLimits, wrapperCommit } from "./app-bridge-status.js";
import { FEATURES } from "./app-bridge-voice.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const SHA = "0123456789abcdef0123456789abcdef01234567"; // 40 hex, synthetic
const CONTRACT = JSON.parse(fs.readFileSync(new URL("./fixtures/voice-contract.json", import.meta.url), "utf8"));

async function withBridge(env) {
  const router = createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:1", gatewayToken: "synthetic-gateway-token-0123456789abcdef",
    configPath: "/nonexistent/openclaw.json", env });
  const app = express(); app.use("/app/v1", router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app/v1/status`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });
    return { status: res.status, json: await res.json() };
  } finally { await new Promise((r) => server.close(r)); }
}

test("wrapper.commit: first 12 hex characters of a valid RAILWAY_GIT_COMMIT_SHA", async () => {
  const r = await withBridge({ RAILWAY_GIT_COMMIT_SHA: SHA });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.wrapper, { commit: "0123456789ab" });
  assert.equal(wrapperCommit({ RAILWAY_GIT_COMMIT_SHA: "abcdef1" }), "abcdef1", "a short 7-char sha is kept as is");
  assert.equal(wrapperCommit({ RAILWAY_GIT_COMMIT_SHA: "a".repeat(12) }), "a".repeat(12));
});

test("wrapper.commit is null when the variable is missing or malformed", async () => {
  const bad = [undefined, "", " ", "abc123", "ABCDEF0123456789", `${SHA} `, ` ${SHA}`, "0123456 789ab", `${SHA}\n`, "main", "g".repeat(40),
    "a".repeat(41), "a".repeat(200), "0123456789abcdef0123456789abcdef0123456789", "../../etc/passwd", 12345678, {}, ["abcdef1"]];
  for (const v of bad) {
    const env = v === undefined ? {} : { RAILWAY_GIT_COMMIT_SHA: v };
    assert.equal(wrapperCommit(env), null, JSON.stringify(v));
  }
  const r = await withBridge({ RAILWAY_GIT_COMMIT_SHA: "a".repeat(41) });
  assert.deepEqual(r.json.wrapper, { commit: null });
  assert.deepEqual((await withBridge({})).json.wrapper, { commit: null });
});

test("no other environment value leaks into /status", async () => {
  const env = { RAILWAY_GIT_COMMIT_SHA: SHA, RAILWAY_GIT_BRANCH: "secret-branch-xyz", RAILWAY_GIT_REPO_NAME: "secret-repo-xyz",
    RAILWAY_GIT_COMMIT_MESSAGE: "secret message xyz", RAILWAY_GIT_AUTHOR: "secret-author-xyz", RAILWAY_PUBLIC_DOMAIN: "secret-host-xyz.example",
    RAILWAY_PROJECT_ID: "secret-project-xyz", SETUP_PASSWORD: "secret-password-xyz", OPENCLAW_GATEWAY_TOKEN: "secret-token-xyz" };
  const r = await withBridge(env);
  const text = JSON.stringify(r.json);
  assert.ok(!/xyz/.test(text), text);
  assert.ok(!text.includes(SHA), "only the first 12 characters, never the whole value");
  assert.deepEqual(Object.keys(r.json.wrapper), ["commit"]);
  assert.deepEqual(wrapperCommit({ RAILWAY_GIT_BRANCH: "abcdef1234567" }), null, "no other variable is ever read");
});

test("attachments: the numbers are the real constants of app-bridge-media.js", async () => {
  const r = await withBridge({});
  assert.deepEqual(r.json.attachments, { maxImages: MAX_IMAGES, maxImageBytes: MAX_IMAGE_BYTES, maxTotalImageBytes: MAX_IMAGES_TOTAL_BYTES,
    maxFileBytes: MAX_MEDIA_BYTES, maxInlineBytes: MAX_INLINE_BYTES });
  assert.deepEqual(attachmentLimits(), r.json.attachments);
  for (const v of Object.values(r.json.attachments)) assert.ok(Number.isInteger(v) && v > 0);
  // not copied anywhere else: the limits function has no numeric literal at all, only the imported constants
  const src = fs.readFileSync(new URL("./app-bridge-status.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function attachmentLimits")).replace(/\/\/.*$/gm, "");
  assert.ok(!/\d/.test(body), "no hard-coded number in attachmentLimits");
  assert.ok(body.includes("MAX_IMAGES,") && body.includes("MAX_INLINE_BYTES"), "built from the constants");
});

test("features: the voice contract ids first, in order, then the new ids; the fixture is untouched", async () => {
  const r = await withBridge({});
  assert.deepEqual(r.json.features, [...CONTRACT.features, ...EXTRA_FEATURES]);
  assert.deepEqual(r.json.features.slice(0, 4), ["voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1"]);
  assert.deepEqual([...EXTRA_FEATURES], ["history.images.v1", "media.inline.v1", "media.guard.v1", "runs.runId.v1", "errorCode.rate_limited.v1"]);
  assert.deepEqual([...FEATURES], CONTRACT.features, "the shared voice list is not changed by this batch");
  for (const id of EXTRA_FEATURES) assert.ok(!CONTRACT.features.includes(id), `${id} must not be in the voice fixture`);
  assert.equal(new Set(r.json.features).size, r.json.features.length);
});

test("/status works with the gateway link off and keeps every older field", async () => {
  const r = await withBridge({});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.link, { state: "off" });
  for (const k of ["appSession", "voice", "runs", "signing"]) assert.ok(k in r.json, k);
  assert.ok(!("engine" in r.json), "engine only when the version is known");
  assert.ok(!("models" in r.json), "no models in this batch");
});

test("without an env option the bridge reads the process environment (how server.js builds it)", async () => {
  const old = process.env.RAILWAY_GIT_COMMIT_SHA;
  try {
    process.env.RAILWAY_GIT_COMMIT_SHA = SHA;
    const router = createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:1", gatewayToken: "synthetic-gateway-token-0123456789abcdef", configPath: "/nonexistent/openclaw.json" });
    const app = express(); app.use("/app/v1", router);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const j = await (await fetch(`http://127.0.0.1:${server.address().port}/app/v1/status`, { headers: { authorization: `Bearer ${APP_TOKEN}` } })).json();
      assert.deepEqual(j.wrapper, { commit: "0123456789ab" });
    } finally { await new Promise((r) => server.close(r)); }
  } finally { if (old === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA; else process.env.RAILWAY_GIT_COMMIT_SHA = old; }
});
