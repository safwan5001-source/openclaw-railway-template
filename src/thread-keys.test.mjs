// B4 (P2-B4-1): thread ids and keys are REJECTED, never normalised; the command filter; the engine flag; the wrapper-level key check.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { DEFINITE_REFUSALS, THREAD_FEATURES, QUALIFIED_THREAD_KEY_RE, UNQUALIFIED_THREAD_KEY_RE, commandRefusal, isClientMsgId, parseTid, threadKeys, threadOfKey, threadsEnabled } from "./thread-keys.js";
import { validateSessionRpc } from "./session-rpc-guard.js";
import { BAD_TIDS } from "./fixtures/thread-key-negatives.mjs";

const HEX = "0123456789abcdef0123456789abcdef";

test("parseTid / threadKeys: exactly 'legacy' or 32 lowercase hex; every negative from the lab is refused, nothing is repaired", () => {
  assert.equal(parseTid("legacy"), "legacy");
  assert.equal(parseTid(HEX), HEX);
  assert.deepEqual(threadKeys(HEX), { tid: HEX, unqualified: `app:owner:${HEX}`, qualified: `agent:main:app:owner:${HEX}` });
  assert.deepEqual(threadKeys("legacy"), { tid: "legacy", unqualified: "app:owner", qualified: "agent:main:app:owner" });
  for (const t of BAD_TIDS) {
    assert.equal(parseTid(t), null, JSON.stringify(t));
    assert.equal(threadKeys(t), null, JSON.stringify(t));
  }
});

test("threadOfKey: only the exact qualified app keys the engine reports; uppercase or any other prefix/suffix is not a thread", () => {
  assert.equal(threadOfKey("agent:main:app:owner"), "legacy");
  assert.equal(threadOfKey(`agent:main:app:owner:${HEX}`), HEX);
  for (const k of [`agent:main:app:owner:${HEX.toUpperCase()}`, `AGENT:MAIN:APP:OWNER:${HEX}`, `app:owner:${HEX}`, "app:owner", `agent:main:app:owner:${HEX}:extra`,
    `agent:main:app:owner:${HEX}\n`, `agent:other:app:owner:${HEX}`, `agent:main:app:owner::${HEX}`, `agent:main:app:owner:${HEX.slice(1)}`, "agent:main:main",
    "agent:main:whatsapp:direct:+966500000001", "agent:main:app:owner ", "", null, undefined, 7]) {
    assert.equal(threadOfKey(k), null, JSON.stringify(k));
  }
  assert.ok(UNQUALIFIED_THREAD_KEY_RE.test(`app:owner:${HEX}`) && !UNQUALIFIED_THREAD_KEY_RE.test(`app:owner:${HEX}\n`));
  assert.ok(QUALIFIED_THREAD_KEY_RE.test(`agent:main:app:owner:${HEX}`) && !QUALIFIED_THREAD_KEY_RE.test(`agent:main:app:owner:${HEX}x`));
});

test("clientMsgId: a lowercase UUID only (braces, URN, uppercase, no dashes are refused before anything else)", () => {
  assert.ok(isClientMsgId("9a9f4cbf-3890-428f-ba8d-b5b33713034c"));
  for (const v of ["9A9F4CBF-3890-428F-BA8D-B5B33713034C", "{9a9f4cbf-3890-428f-ba8d-b5b33713034c}", "urn:uuid:9a9f4cbf-3890-428f-ba8d-b5b33713034c",
    "9a9f4cbf3890428fba8db5b33713034c", "9a9f4cbf-3890-428f-ba8d-b5b33713034c\n", " 9a9f4cbf-3890-428f-ba8d-b5b33713034c", "9a9f4cbf-3890-428f-ba8d-b5b33713034", "", null, 1]) {
    assert.equal(isClientMsgId(v), false, JSON.stringify(v));
  }
});

test("command filter: '/' after whitespace or ANY format/bidi mark, and '!' followed by anything, are refused (lab L1(g))", () => {
  const refused = ["/status", " /status", "\t/status", "\n/status", " /status", "﻿/status", "﻿ /x", "‏/config", "‎/model x",
    "؜/compact", "‍/reset", "‌/new", "​/status", "⁠/status", "‏ ‏/status", "‏‏‎/x", "/", "/notacommand",
    "! ls", "!ls", "!", "!مهم", "!important", " ! echo X", "‏! echo", " !x"];
  for (const t of refused) assert.equal(commandRefusal(t), "command_not_allowed", JSON.stringify(t));
  const allowed = ["hello", "مرحبا", "status /x", "hi\n/status", "a!", "؟!", "／status", "،/status", "x /status", "1/2", "", "   "];
  for (const t of allowed) assert.equal(commandRefusal(t), null, JSON.stringify(t));
});

test("engine flag: ON only for exactly BASHT_THREADS=on; capability ids and the closed refusal list are fixed", () => {
  assert.equal(threadsEnabled({ BASHT_THREADS: "on" }), true);
  for (const v of [undefined, "", "1", "true", "ON", "On", "on ", " on", "yes", "off", "0"]) assert.equal(threadsEnabled(v === undefined ? {} : { BASHT_THREADS: v }), false, JSON.stringify(v));
  assert.equal(threadsEnabled(undefined), false);
  assert.deepEqual([...THREAD_FEATURES], ["sessions.multi.v1", "send.ws.v1", "events.thread.v1"]);
  assert.deepEqual([...DEFINITE_REFUSALS].sort(), ["archived", "bad_request", "busy", "busy_unknown", "cold", "command_not_allowed", "conflict", "not_written", "too_large"]);
  for (const c of DEFINITE_REFUSALS) assert.match(c, /^[a-z][a-z0-9_]{0,31}$/, "fits the API's refusal column");
  assert.ok(!DEFINITE_REFUSALS.includes("outcome_unknown") && !DEFINITE_REFUSALS.includes("engine_unavailable"));
});

// ---------------------------------------------------------------- wrapper-level key check (server.js appBridgeGatewayCall) -------------
const APP = "agent:main:app:owner";
const T = `agent:main:app:owner:${HEX}`;
const WA = "agent:main:whatsapp:direct:+966500000001";

test("validateSessionRpc: the keys and params the bridge really sends are accepted (legacy traffic unchanged)", () => {
  const ok = [
    ["sessions.describe", { key: APP }], ["sessions.describe", { key: T }],
    ["sessions.patch", { key: APP, thinkingLevel: "low" }], ["sessions.patch", { key: APP, thinkingLevel: null }], ["sessions.patch", { key: APP, fastMode: true }],
    ["sessions.patch", { key: APP, fastMode: null }], ["sessions.patch", { key: T, model: "mock/echo" }], ["sessions.patch", { key: T, model: null }],
    ["sessions.patch", { key: T, archived: false, expectedSessionId: "0c2ad305-aaaa" }],
    ["sessions.reset", { key: APP, reason: "new" }],
    ["chat.history", { sessionKey: APP, messageId: "abcdef12", limit: 81 }], ["chat.history", { sessionKey: WA, messageId: "abcdef12", limit: 1 }],
    ["chat.history", { sessionKey: "agent:main:main", limit: 1 }], ["chat.history", { sessionKey: T, limit: 5 }],
    ["sessions.search", { query: "x", sessionKeys: [APP, "agent:main:main", WA, T], limit: 20 }],
    ["artifacts.download", { sessionKey: APP, artifactId: "a1" }], ["artifacts.download", { sessionKey: T, artifactId: "a1" }],
    ["models.list", { agentId: "main", sessionKey: APP, view: "default", includeDetails: true }], ["models.list", { agentId: "main", sessionKey: T, view: "default", includeDetails: true }],
    ["sessions.usage", { key: APP, range: "30d" }], ["tools.effective", { agentId: "main", sessionKey: APP }],
    ["cron.list", { includeDisabled: true }], ["usage.cost", {}], ["memory.status", {}],
  ];
  for (const [m, p] of ok) assert.equal(validateSessionRpc(m, p), true, `${m} ${JSON.stringify(p)}`);
});

test("validateSessionRpc: any other key shape (the lab's negatives, uppercase, unqualified, suffixes) and any other session write are refused", () => {
  const badKeys = [`${T.toUpperCase()}`, `agent:main:app:owner:${HEX.toUpperCase()}`, `app:owner:${HEX}`, "app:owner", `${T}:extra`, `${T}\n`, `${T} `, `agent:main:app:owner:${HEX.slice(1)}`,
    `agent:main:app:owner:${HEX}0`, "agent:main:subagent:x", "agent:main:cron:job", "agent:other:main", "AGENT:MAIN:MAIN", "", null, 5];
  for (const k of badKeys) {
    for (const [m, p] of [["sessions.describe", { key: k }], ["sessions.patch", { key: k, thinkingLevel: "low" }], ["chat.history", { sessionKey: k, limit: 1 }],
      ["artifacts.download", { sessionKey: k, artifactId: "a" }], ["models.list", { sessionKey: k }], ["sessions.search", { query: "x", sessionKeys: [APP, k] }]]) {
      assert.equal(validateSessionRpc(m, p), false, `${m} ${JSON.stringify(k)}`);
    }
  }
  // writes: main/WhatsApp keys are never written; resets only the legacy key with reason "new"; patches are one closed change
  for (const [m, p] of [["sessions.patch", { key: WA, thinkingLevel: "low" }], ["sessions.patch", { key: "agent:main:main", model: "x/y" }],
    ["sessions.describe", { key: WA }], ["sessions.reset", { key: T, reason: "new" }], ["sessions.reset", { key: APP, reason: "reset" }], ["sessions.reset", { key: APP }],
    ["sessions.reset", { key: APP, reason: "new", extra: 1 }], ["sessions.patch", { key: T, archived: true, expectedSessionId: "x" }],
    ["sessions.patch", { key: T, archived: false }], ["sessions.patch", { key: T, pinned: true }], ["sessions.patch", { key: T, label: "x" }],
    ["sessions.patch", { key: T, model: "a/b", thinkingLevel: "low" }], ["sessions.patch", { key: T }], ["sessions.patch", { key: T, model: "a b" }],
    ["sessions.describe", { key: APP, extra: 1 }], ["sessions.search", { query: "x", sessionKeys: [] }], ["sessions.search", { query: "x" }],
    ["sessions.describe", null], ["sessions.describe", [APP]], ["sessions.describe", "x"]]) {
    assert.equal(validateSessionRpc(m, p), false, `${m} ${JSON.stringify(p)}`);
  }
  // an accessor cannot show one key to the check and another to the serializer
  let n = 0;
  const sneaky = Object.defineProperty({}, "key", { enumerable: true, get: () => (n++ ? WA : APP) });
  assert.equal(validateSessionRpc("sessions.describe", sneaky), false);
});

test("server.js runs validateSessionRpc on EVERY bridge gateway call, before the link or the CLI", () => {
  const s = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const fn = s.slice(s.indexOf("function appBridgeGatewayCall("), s.indexOf("function appBridgeCliCall("));
  const guard = fn.indexOf("validateSessionRpc(method, params)");
  assert.ok(guard > 0, "guard present");
  assert.ok(guard < fn.indexOf("gatewayLink.request(") && guard < fn.indexOf("appBridgeCliCall(method, params)"), "guard runs first");
});
