// Tests for the BASHT memory-flush owner-identity patch and the read-only doctor.
//   node --test patches/*.test.mjs
// Integration block (real OpenClaw 2026.10.9 dist) runs only when OPENCLAW_PACKAGE_ROOT points at an installed
// openclaw package, e.g. OPENCLAW_PACKAGE_ROOT=$RUNNER_TEMP/oc/node_modules/openclaw. It writes a throwaway copy of
// the patched module next to the original (removed afterwards) and never touches /data, Railway or WhatsApp.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ORIGINAL_SHA256,
  OPENCLAW_VERSION,
  PATCH_MARKER,
  TARGET_FILE,
  applyToPackage,
  patchSource,
  readOriginalFromPatched,
  sha256,
} from "./openclaw-memory-flush-owner.mjs";
import { classifyWhatsAppId, maskId, normalizeOwnerCandidates, verdict } from "./memory-flush-doctor.mjs";

// Minimal stand-in that contains every anchor exactly once, in upstream order.
const FIXTURE = [
  `import { t as createSessionMaintenanceFollowup } from "./run-C50ZeOtw.mjs";`,
  `const memoryFlushLog = { debug() {} };`,
  `async function runMemoryFlushIfNeeded(params) {`,
  `	const maintenanceRun = createSessionMaintenanceFollowup({`,
  `		auth: params.followupRun.run`,
  `	}).run;`,
  `	const runBaseParams = await buildEmbeddedRunExecutionParams({`,
  `					sessionCtx: {},`,
  `	});`,
  `}`,
  `export { runSessionCompactionIfNeeded as n, runMemoryFlushIfNeeded as t };`,
  ``,
].join("\n");

/**
 * Evaluate the injected helper in isolation. `env` stubs the three OpenClaw functions it imports:
 *   authorities: Map(run -> {isCurrent}) for getCommandOwnerAuthority
 *   owners():    the live commands.ownerAllowFrom (E.164) for isConfiguredCommandOwner
 *   configThrows: simulate a config read failure
 */
function loadHelper(env = {}) {
  const patched = patchSource(FIXTURE);
  const start = patched.indexOf(`//#region ${PATCH_MARKER}`);
  const end = patched.indexOf("//#endregion", start);
  const body = patched.slice(start, end);
  const getCommandOwnerAuthority = (run) => env.authorities?.get(run);
  const getRuntimeConfig = () => {
    if (env.configThrows) throw new Error("config unavailable");
    return { owners: env.owners ? env.owners() : [] };
  };
  const isConfiguredCommandOwner = (cfg, requester) => requester.channel === "whatsapp" && cfg.owners.includes(requester.senderId);
  // eslint-disable-next-line no-new-func
  return new Function("getCommandOwnerAuthority", "isConfiguredCommandOwner", "getRuntimeConfig", `${body}\nreturn resolveBashtOwnerMemoryFlushIdentity;`)(
    getCommandOwnerAuthority, isConfiguredCommandOwner, getRuntimeConfig);
}

const OWNER = "+15550001234";
const IMPOSTOR = "+19990001111";
const OWNER_RUN = Object.freeze({ senderIsOwner: true, senderId: OWNER, senderE164: OWNER, senderName: "Owner", messageProvider: "whatsapp", agentAccountId: "default" });
const WRITE_PATH = "memory/2026-11-21.md";
const flush = (sourceRun, extra = {}) => ({ sourceRun, memoryFlushWritePath: WRITE_PATH, sourceTurnTainted: false, ...extra });

test("patchSource: applies four exact edits and is reversible byte-for-byte", () => {
  const patched = patchSource(FIXTURE);
  assert.ok(patched.includes(PATCH_MARKER));
  assert.ok(patched.includes(`import { d as getCommandOwnerAuthority, t as isConfiguredCommandOwner } from "./command-auth-BHrKDij6.mjs";`));
  assert.ok(patched.includes(`import { r as getRuntimeConfig } from "./io.runtime-B134MOMz.mjs";`));
  assert.ok(patched.includes("maintenanceRun.senderIsOwner = true;"));
  assert.ok(patched.includes("sessionCtx: bashtOwnerFlushIdentity ? bashtOwnerFlushIdentity.currentSessionCtx() : {},"));
  assert.ok(!patched.includes("\t\t\t\t\tsessionCtx: {},\n"));
  assert.equal(readOriginalFromPatched(patched), FIXTURE);
});

test("patchSource: refuses drift (missing anchor, duplicated anchor, double application)", () => {
  assert.throws(() => patchSource(FIXTURE.replace("sessionCtx: {},", "sessionCtx: ctx,")), /anchor not found \(flush sessionCtx\)/);
  assert.throws(() => patchSource(FIXTURE.replace("\t\t\t\t\tsessionCtx: {},\n", "\t\t\t\t\tsessionCtx: {},\n\t\t\t\t\tsessionCtx: {},\n")), /anchor not unique/);
  assert.throws(() => patchSource(patchSource(FIXTURE)), /already applied/);
});

test("SECURITY: senderIsOwner=true + sender present + NO command-owner authority + NOT a configured owner => fail closed", () => {
  const resolve = loadHelper({ owners: () => [] });
  assert.equal(resolve(flush(OWNER_RUN)), undefined, "the propagated owner flag alone never grants owner identity");
  const resolveOther = loadHelper({ owners: () => ["+14440000000"] });
  assert.equal(resolveOther(flush(OWNER_RUN)), undefined, "a different configured owner does not help");
});

test("SECURITY: no command-owner authority, sender IS the configured owner => owner identity (configured-owner basis)", () => {
  const resolve = loadHelper({ owners: () => [OWNER] });
  const identity = resolve(flush(OWNER_RUN));
  assert.ok(identity);
  assert.equal(identity.ownerBasis, "configured-owner");
  assert.deepEqual(identity.currentSessionCtx(), { SenderId: OWNER, SenderE164: OWNER, SenderName: "Owner" });
  const copy = identity.currentSessionCtx();
  copy.SenderE164 = IMPOSTOR;
  assert.equal(identity.currentSessionCtx().SenderE164, OWNER, "callers get a copy, not the frozen source");
});

test("SECURITY: owner removed from live config after resolve => next attempt aborts", () => {
  let owners = [OWNER];
  const resolve = loadHelper({ owners: () => owners });
  const identity = resolve(flush(OWNER_RUN));
  assert.ok(identity.currentSessionCtx());
  owners = [];
  assert.throws(() => identity.currentSessionCtx(), /no longer current/);
});

test("SECURITY: bound command-owner authority current => owner (authority basis); revoked/expired => denied with NO config fallback", () => {
  let current = true;
  const authorities = new Map([[OWNER_RUN, { isCurrent: () => current }]]);
  const resolve = loadHelper({ authorities, owners: () => [OWNER] });
  const identity = resolve(flush(OWNER_RUN));
  assert.equal(identity.ownerBasis, "command-owner-authority");
  assert.ok(identity.currentSessionCtx());
  current = false;
  assert.throws(() => identity.currentSessionCtx(), /no longer current/, "revocation after resolve aborts the attempt");
  assert.equal(resolve(flush(OWNER_RUN)), undefined, "revoked authority is not rescued by the configured-owner list");
  const throwing = new Map([[OWNER_RUN, { isCurrent: () => { throw new Error("expired"); } }]]);
  assert.equal(loadHelper({ authorities: throwing, owners: () => [OWNER] })(flush(OWNER_RUN)), undefined, "an authority check that throws is a denial");
});

test("SECURITY: impersonation — owner flag with a non-owner number, or mixed identifiers", () => {
  const resolve = loadHelper({ owners: () => [OWNER] });
  assert.equal(resolve(flush({ ...OWNER_RUN, senderId: IMPOSTOR, senderE164: IMPOSTOR })), undefined, "spoofed owner flag with another number");
  const mixed = resolve(flush({ ...OWNER_RUN, senderId: IMPOSTOR }));
  assert.deepEqual(mixed.currentSessionCtx(), { SenderE164: OWNER, SenderName: "Owner" }, "only identifiers that prove ownership are propagated");
  assert.equal(resolve(flush({ ...OWNER_RUN, messageProvider: "telegram" })), undefined, "owner number on another channel is not the configured WhatsApp owner");
  assert.equal(resolve(flush({ ...OWNER_RUN, messageProvider: undefined })), undefined, "no channel, no proof");
});

test("SECURITY: non-owner, tainted, tools-arm, identity-less and config-failure runs keep upstream anonymous behaviour", () => {
  const resolve = loadHelper({ owners: () => [OWNER] });
  const cases = {
    "non-owner sender (owner number but flag false)": flush({ ...OWNER_RUN, senderIsOwner: false }),
    "owner flag missing": flush({ senderId: OWNER, senderE164: OWNER, messageProvider: "whatsapp" }),
    "truthy but not true owner flag": flush({ ...OWNER_RUN, senderIsOwner: "true" }),
    "tainted source turn": flush(OWNER_RUN, { sourceTurnTainted: true }),
    "tools-arm flush (no write path)": flush(OWNER_RUN, { memoryFlushWritePath: undefined }),
    "blank write path": flush(OWNER_RUN, { memoryFlushWritePath: "  " }),
    "owner flag without sender identity": flush({ senderIsOwner: true, senderName: "Owner", messageProvider: "whatsapp" }),
    "no source run": flush(undefined),
  };
  for (const [name, input] of Object.entries(cases)) assert.equal(resolve(input), undefined, name);
  assert.equal(loadHelper({ owners: () => [OWNER], configThrows: true })(flush(OWNER_RUN)), undefined, "config read failure is a denial");
});

test("applyToPackage: refuses another OpenClaw version and an unexpected file hash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basht-patch-"));
  try {
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "2026.11.1" }));
    fs.writeFileSync(path.join(dir, TARGET_FILE), FIXTURE);
    assert.throws(() => applyToPackage(dir, { log: {} }), /expected openclaw 2026\.10\.9, found 2026\.11\.1/);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: OPENCLAW_VERSION }));
    assert.throws(() => applyToPackage(dir, { log: {} }), /hash .* != expected/);
    assert.equal(fs.readFileSync(path.join(dir, TARGET_FILE), "utf8"), FIXTURE, "nothing written on refusal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor helpers: PN/LID classification and masking", () => {
  assert.equal(classifyWhatsAppId("+966500000000"), "PN");
  assert.equal(classifyWhatsAppId("966500000000@s.whatsapp.net"), "PN");
  assert.equal(classifyWhatsAppId("whatsapp:+966500000000"), "PN");
  assert.equal(classifyWhatsAppId("123456789012345@lid"), "LID");
  assert.equal(classifyWhatsAppId(undefined), "none");
  assert.equal(maskId("agent:main:whatsapp:direct:+966500001234"), "agent:main:whatsapp:direct:+••••••••1234");
});

test("doctor: simulation applies the patch's owner gate (channel allowFrom is not ownership)", () => {
  const onlyChannel = normalizeOwnerCandidates({}, { allowFrom: ["+15550001234"] });
  assert.deepEqual(onlyChannel.configuredOwners, [], "channels.whatsapp.allowFrom alone never proves ownership");
  assert.deepEqual(onlyChannel.channelOnly, ["+15550001234"]);
  const both = normalizeOwnerCandidates({ ownerAllowFrom: ["whatsapp:+15550001234", "*", "telegram:123", "+15550009999"] }, { allowFrom: ["+15550001234", "+14440000000"] });
  assert.deepEqual(both.configuredOwners, ["+15550001234", "+15550009999"], "wildcard and other-channel entries ignored");
  assert.deepEqual(both.channelOnly, ["+14440000000"]);
  const sim = { owner_turn: { write: true }, flush_upstream: { write: false }, flush_patched: { write: true }, flush_impostor: { write: false } };
  assert.match(verdict(sim, false), /OWNER UNVERIFIED/, "no configured owner => never a 'patch restores' verdict");
  assert.match(verdict(sim, true), /identity propagation is the cause/);
  assert.match(verdict({ ...sim, flush_impostor: { write: true } }, true), /UNSAFE/);
});

// ---------------------------------------------------------------- integration with the real OpenClaw dist
const PKG = process.env.OPENCLAW_PACKAGE_ROOT;
const integration = { skip: !PKG ? "set OPENCLAW_PACKAGE_ROOT to an installed openclaw@2026.10.9 to run" : false };

test("integration: installed target matches the pinned upstream hash (or the verified patched content)", integration, () => {
  const text = fs.readFileSync(path.join(PKG, TARGET_FILE), "utf8");
  if (text.includes(PATCH_MARKER)) assert.equal(sha256(readOriginalFromPatched(text)), ORIGINAL_SHA256);
  else assert.equal(sha256(text), ORIGINAL_SHA256);
});

test("integration: patched module links against the real OpenClaw chunks", integration, async () => {
  const original = fs.readFileSync(path.join(PKG, TARGET_FILE), "utf8");
  const source = original.includes(PATCH_MARKER) ? original : patchSource(original);
  const tmp = path.join(PKG, "dist", `.basht-flush-patch-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(tmp, source);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    assert.equal(typeof mod.t, "function", "runMemoryFlushIfNeeded export intact");
    assert.equal(typeof mod.n, "function", "runSessionCompactionIfNeeded export intact");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("integration: real tool policy — owner identity restores the append-only flush writer, impostors gain nothing", integration, async () => {
  const { i: createTools } = await import(pathToFileURL(path.join(PKG, "dist/agent-tools-Bpi7xWYy.mjs")).href);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "basht-flush-ws-"));
  const OWNER = "+15550001234";
  const config = {
    tools: { profile: "coding", toolsBySender: { [`e164:${OWNER}`]: { allow: ["*"] }, "*": { deny: ["write", "edit", "exec", "apply_patch"] } } },
    agents: { entries: { main: { tools: { alsoAllow: ["message", "browser"] } } } },
  };
  const base = { config, agentId: "main", sessionKey: `agent:main:whatsapp:direct:${OWNER}`, workspaceDir: ws, messageProvider: "whatsapp", messageChannel: "whatsapp" };
  const flush = { trigger: "memory", memoryFlushWritePath: "memory/2026-11-21.md" };
  const names = async (opts) => (await createTools(opts)).map((t) => t.name).sort();
  try {
    const ownerTurn = await names({ ...base, senderIsOwner: true, senderE164: OWNER, senderId: OWNER });
    assert.ok(ownerTurn.includes("write") && ownerTurn.includes("exec"), "owner's own turn keeps its tools");
    assert.deepEqual(await names({ ...base, ...flush, senderIsOwner: false }), ["read"], "upstream anonymous flush loses write (the production bug)");
    assert.deepEqual(await names({ ...base, ...flush, senderIsOwner: true, senderE164: OWNER, senderId: OWNER }), ["read", "write"], "patched flush: exactly read + append-only write");
    assert.deepEqual(await names({ ...base, ...flush, senderIsOwner: true, senderE164: "+19990001111", senderId: "+19990001111" }), ["read"], "spoofed owner flag with another number does not get write");
    assert.deepEqual(await names({ ...base, ...flush, senderIsOwner: false, senderE164: "+19990001111" }), ["read"], "non-owner flush stays read-only");
    const strict = { ...config, agents: { entries: { main: { tools: { alsoAllow: ["message", "browser"], deny: ["write"] } } } } };
    assert.deepEqual(await names({ ...base, config: strict, ...flush, senderIsOwner: true, senderE164: OWNER, senderId: OWNER }), ["read"], "an operator deny on write is still honoured");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("integration: helper with REAL OpenClaw owner functions — fail closed without configured owner, wildcard never counts", integration, async () => {
  const auth = await import(pathToFileURL(path.join(PKG, "dist/command-auth-BHrKDij6.mjs")).href);
  const original = fs.readFileSync(path.join(PKG, TARGET_FILE), "utf8");
  const patched = original.includes(PATCH_MARKER) ? original : patchSource(original);
  const start = patched.indexOf(`//#region ${PATCH_MARKER}`);
  const body = patched.slice(start, patched.indexOf("//#endregion", start));
  let cfg;
  // eslint-disable-next-line no-new-func
  const resolve = new Function("getCommandOwnerAuthority", "isConfiguredCommandOwner", "getRuntimeConfig", `${body}\nreturn resolveBashtOwnerMemoryFlushIdentity;`)(
    auth.d, auth.t, () => cfg);
  const run = { senderIsOwner: true, senderId: "+15550001234", senderE164: "+15550001234", messageProvider: "whatsapp", agentAccountId: "default" };
  const args = (sourceRun) => ({ sourceRun, memoryFlushWritePath: "memory/2026-11-21.md", sourceTurnTainted: false });
  const resolve0 = (r) => resolve(args(r));
  // Without the WhatsApp channel plugin registered (this test process), OpenClaw cannot resolve the "whatsapp:"
  // prefix, so a prefixed entry must FAIL CLOSED; the unprefixed E.164 form resolves without a plugin. The E2E runs
  // with the real @openclaw/whatsapp plugin installed and proves the prefixed production form.
  cfg = { commands: { ownerAllowFrom: ["whatsapp:+15550001234"] } };
  const runPrefixed = { senderIsOwner: true, senderId: "+15550001234", senderE164: "+15550001234", messageProvider: "whatsapp", agentAccountId: "default" };
  assert.equal(resolve0(runPrefixed), undefined, "unresolvable owner entry => fail closed");
  cfg = { commands: { ownerAllowFrom: ["+15550001234"] } };

  const ok = resolve(args(run));
  assert.equal(ok?.ownerBasis, "configured-owner", "configured WhatsApp owner proves ownership via real isConfiguredCommandOwner");
  assert.equal(resolve(args({ ...run, senderId: "+19990001111", senderE164: "+19990001111" })), undefined, "impostor number");
  cfg = { commands: { ownerAllowFrom: ["*"] } };
  assert.equal(resolve(args(run)), undefined, "wildcard ownerAllowFrom never proves ownership");
  assert.throws(() => ok.currentSessionCtx(), /no longer current/, "owner removed from live config aborts the next attempt");
  cfg = {};
  assert.equal(resolve(args(run)), undefined, "no ownerAllowFrom at all => no owner identity (senderIsOwner flag alone is not enough)");

  // Real command-owner capability bound on the run: current => authority basis; revoked => denied even if configured.
  cfg = { commands: { ownerAllowFrom: ["+15550001234"] } };
  let current = true;
  const bound = { ...run };
  auth.l(bound, { isCurrent: () => current });
  assert.equal(resolve(args(bound))?.ownerBasis, "command-owner-authority");
  current = false;
  assert.equal(resolve(args(bound)), undefined, "revoked/expired command-owner authority is a denial with no configured-owner fallback");
});

test("integration: the flush writer cannot leave memory/<date>.md, cannot overwrite, cannot replay", integration, async () => {
  const { i: createTools } = await import(pathToFileURL(path.join(PKG, "dist/agent-tools-Bpi7xWYy.mjs")).href);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "basht-flush-write-"));
  const OWNER = "+15550001234";
  const target = "memory/2026-11-21.md";
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    fs.writeFileSync(path.join(ws, target), "- existing fact\n");
    fs.writeFileSync(path.join(ws, "MEMORY.md"), "long-term\n");
    const tools = await createTools({
      config: { tools: { profile: "coding", toolsBySender: { [`e164:${OWNER}`]: { allow: ["*"] }, "*": { deny: ["write"] } } } },
      agentId: "main", sessionKey: `agent:main:whatsapp:direct:${OWNER}`, workspaceDir: ws, messageProvider: "whatsapp",
      senderIsOwner: true, senderE164: OWNER, senderId: OWNER, trigger: "memory", memoryFlushWritePath: target,
    });
    assert.deepEqual(tools.map((t) => t.name).sort(), ["read", "write"], "owner flush surface is exactly read + write");
    const write = tools.find((t) => t.name === "write");
    const call = (args) => write.execute(`call-${crypto.randomUUID()}`, args, new AbortController().signal);
    for (const p of ["MEMORY.md", "memory/2026-11-22.md", "../escape.md", "/etc/passwd", `@${target}`, "SOUL.md"]) {
      await assert.rejects(call({ path: p, content: "x\n" }), /restricted to memory\/2026-11-21\.md|outside|escape|not allowed|path/i, `rejects ${p}`);
    }
    await assert.rejects(call({ path: target, content: "- existing fact\n" }), undefined, "replaying existing content is rejected");
    await call({ path: target, content: "- new fact\n" });
    assert.equal(fs.readFileSync(path.join(ws, target), "utf8"), "- existing fact\n- new fact\n", "append-only: existing entries preserved");
    assert.equal(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8"), "long-term\n", "other memory files untouched");
    assert.ok(!fs.existsSync(path.join(ws, "memory/2026-11-22.md")));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
