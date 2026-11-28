// D-B4-9: the standalone resume-guard plugin (src/plugins/basht-resume-guard.mjs). Hook facts from the P2-B4-1 lab (guard.jsonl):
// a resumed run's before_agent_run has ctx.trigger "event" and its prompt starts with the resume note; user turns are "user";
// before_tool_call has ctx.runId, ctx.sessionKey, event.toolName/params, but no trigger.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import plugin, { DEFAULT_CONFIG, PLUGIN_ID, SENSITIVE_CATALOG, createGuard, daftraCallsAreReadOnly, idempotencyKeyFor, isSensitive, resolveConfig } from "./plugins/basht-resume-guard.mjs";

const NOTE = "Note: The previous agent run was interrupted. Review the transcript and current state, then continue the unfinished work in light of the latest user message. The Gateway restarted while you were working. Resume your work: …";
const KEY = "agent:main:app:owner:0123456789abcdef0123456789abcdef";
const K = "9a9f4cbf-3890-428f-ba8d-b5b33713034c";
const WRITE = { calls: [{ name: "create_invoice", arguments: { client_id: 1 } }] };
const READ = { calls: [{ name: "list_invoices", arguments: {} }, { name: "daftra_get_invoice", arguments: { id: 2 } }] };

function harness(rawConfig) {
  const hooks = {};
  plugin.register({ pluginConfig: rawConfig, on: (name, fn) => { hooks[name] = fn; }, logger: { info() {}, warn() {} } });
  return hooks;
}
const resume = (h, runId = "r2", trigger = "event", prompt = NOTE) => h.before_agent_run({ prompt, messages: [{ role: "user", idempotencyKey: `${K}:user` }] }, { runId, trigger, sessionKey: KEY });
const call = (h, toolName, params, runId = "r2") => h.before_tool_call({ toolName, params, toolCallId: "c1" }, { runId, sessionKey: KEY });

test("a resumed run (trigger 'event' + the resume note) gets a FRESH critical owner approval for a sensitive tool; nothing else changes", () => {
  const h = harness(undefined);
  resume(h);
  const r = call(h, "daftra-mcp__execute_tools", WRITE);
  assert.equal(r.requireApproval.severity, "critical");
  assert.deepEqual(r.requireApproval.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(r.requireApproval.title, "تشغيل مستأنف بعد إعادة التشغيل");
  assert.equal(r.params, undefined, "no key injected by default");
  assert.equal(call(h, "daftra-mcp__execute_tools", READ), undefined, "a Daftra read is not gated");
  assert.equal(call(h, "exec", { command: "ls" }), undefined, "not on the closed list");
  assert.ok(call(h, "message", { to: "x", text: "y" }).requireApproval, "outbound message is sensitive");
});

test("normal user turns are never gated; a resume note under trigger 'user' (the owner pasting it) is not a resumed run", () => {
  const h = harness(undefined);
  h.before_agent_run({ prompt: "make an invoice", messages: [] }, { runId: K, trigger: "user", sessionKey: KEY });
  assert.equal(call(h, "execute_tools", WRITE, K), undefined);
  resume(h, "r3", "user");
  assert.equal(call(h, "execute_tools", WRITE, "r3"), undefined);
  resume(h, "r4", "event", "a heartbeat event"); // an event run that is not a restart resume
  assert.equal(call(h, "execute_tools", WRITE, "r4"), undefined);
  assert.equal(call(h, "execute_tools", WRITE, "unknown-run"), undefined);
});

test("Daftra inspector: a call is a read ONLY when every inner name is a read verb; malformed params are sensitive (fail closed)", () => {
  assert.equal(daftraCallsAreReadOnly(READ), true);
  for (const p of [WRITE, { calls: [...READ.calls, ...WRITE.calls] }, { calls: [{ name: "update_client" }] }, { calls: [{ name: "delete_invoice" }] },
    { calls: [{ name: "send_invoice_email" }] }, { calls: [{ name: "record_payment" }] }, { calls: [] }, { calls: "x" }, {}, null, undefined, { calls: [{}] },
    { calls: [{ name: 5 }] }, { calls: [{ name: "listing_hack_create" }] }, { calls: [{ name: "list_and_delete_invoices" }] }, { calls: [{ name: "get_or_create_client" }] }]) {
    assert.equal(daftraCallsAreReadOnly(p), false, JSON.stringify(p));
  }
  const cfg = resolveConfig(undefined);
  for (const n of ["execute_tools", "daftra__execute_tools", "daftra-mcp__execute_tools", "mcp_daftra_execute_tools"]) assert.equal(isSensitive(cfg, n, WRITE), true, n);
  for (const n of ["execute_toolsx", "daftra_search_tools", "my_execute_tools_wrapper2"]) assert.equal(isSensitive(cfg, n, WRITE), false, n);
});

test("config is CLOSED: only catalog ids and the listed modes; anything unknown falls back to the defaults", () => {
  assert.deepEqual(Object.keys(SENSITIVE_CATALOG).sort(), ["daftra.execute_tools", "message.send"]);
  assert.equal(resolveConfig(undefined).source, "default");
  assert.equal(resolveConfig({}).source, "default");
  const c = resolveConfig({ mode: "approve_sensitive", sensitive: ["daftra.execute_tools"], injectIdempotencyKey: true });
  assert.deepEqual(c, { mode: "approve_sensitive", sensitive: ["daftra.execute_tools"], injectIdempotencyKey: true, source: "config" });
  for (const bad of [{ mode: "off" }, { sensitive: ["exec"] }, { sensitive: [] }, { extra: 1 }, { injectIdempotencyKey: "yes" }, [], "x", 5]) {
    const r = resolveConfig(bad);
    assert.equal(r.source, "invalid", JSON.stringify(bad));
    assert.deepEqual([r.mode, r.sensitive], [DEFAULT_CONFIG.mode, [...DEFAULT_CONFIG.sensitive]]);
  }
});

test("modes: approve_sensitive asks outside resumed runs too; block_on_resume refuses in resumed runs; idempotency key is stable", () => {
  const always = harness({ mode: "approve_sensitive" });
  assert.ok(call(always, "execute_tools", WRITE, "plain").requireApproval);
  const block = harness({ mode: "block_on_resume" });
  resume(block);
  assert.equal(call(block, "execute_tools", WRITE).block, true);
  assert.equal(call(block, "execute_tools", WRITE, "plain"), undefined);
  const inject = harness({ injectIdempotencyKey: true });
  inject.before_agent_run({ prompt: "x", messages: [] }, { runId: K, trigger: "user", sessionKey: KEY });
  resume(inject, "r2");
  const first = call(inject, "execute_tools", WRITE, K).params.idempotency_key;
  const again = call(inject, "execute_tools", WRITE, "r2").params.idempotency_key; // the resumed run anchors on "<K>:user"
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(first, again, "same call in the resumed run -> same key");
  assert.equal(first, idempotencyKeyFor(KEY, K, "execute_tools", WRITE));
  assert.notEqual(first, idempotencyKeyFor(KEY, K, "execute_tools", { calls: [{ name: "create_invoice", arguments: { client_id: 2 } }] }));
});

test("the run marks are bounded (a long-lived gateway does not grow them without limit)", () => {
  const g = createGuard(resolveConfig(undefined));
  for (let i = 0; i < 2000; i++) g.before_agent_run({ prompt: NOTE }, { runId: `r${i}`, trigger: "event" });
  assert.ok(g.resumed.size <= 500);
  assert.ok(g.resumed.has("r1999") && !g.resumed.has("r0"));
});

test("shipped disabled: nothing in the wrapper loads it; it registers only the two hooks; its id is fixed", () => {
  assert.equal(plugin.id, PLUGIN_ID);
  const names = Object.keys(harness(undefined)).sort();
  assert.deepEqual(names, ["before_agent_run", "before_tool_call"]);
  // no auto-load: no wrapper file writes plugins.load.paths or names the plugin
  for (const f of ["src/server.js", "entrypoint.sh", "Dockerfile", "src/app-bridge.js", "src/gateway-link.js", "src/gateway-write-link.js"]) {
    const s = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!s.includes(PLUGIN_ID) && !/plugins\.load\.paths|plugins\.entries/.test(s), `${f} must not load the guard`);
  }
});

test("fail closed: an inspection that throws makes the hook throw (the engine then blocks the call), never 'not sensitive'", () => {
  const h = harness(undefined);
  resume(h);
  const params = { get calls() { throw new Error("hostile params"); } };
  assert.throws(() => call(h, "execute_tools", params));
});

test("m9: before_agent_run never throws (the engine treats that hook as fail-closed for EVERY run)", () => {
  const h = harness(undefined);
  const hostile = { get prompt() { throw new Error("boom"); }, get messages() { throw new Error("boom"); } };
  assert.equal(h.before_agent_run(hostile, { runId: "r9", trigger: "event" }), undefined);
  assert.equal(h.before_agent_run({ prompt: NOTE }, null), undefined);
});
