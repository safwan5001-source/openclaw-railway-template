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
import { classifyWhatsAppId, maskId } from "./memory-flush-doctor.mjs";

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

/** Evaluate the injected helper in isolation with a stub command-owner capability. */
function loadHelper(captureCommandOwnerAssertion) {
  const patched = patchSource(FIXTURE);
  const start = patched.indexOf(`//#region ${PATCH_MARKER}`);
  const end = patched.indexOf("//#endregion", start);
  const body = patched.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function("captureCommandOwnerAssertion", `${body}\nreturn resolveBashtOwnerMemoryFlushIdentity;`)(captureCommandOwnerAssertion);
}

const OWNER_RUN = { senderIsOwner: true, senderId: "+15550001234", senderE164: "+15550001234", senderName: "Owner" };
const WRITE_PATH = "memory/2026-11-21.md";

test("patchSource: applies four exact edits and is reversible byte-for-byte", () => {
  const patched = patchSource(FIXTURE);
  assert.ok(patched.includes(PATCH_MARKER));
  assert.ok(patched.includes(`import { u as captureCommandOwnerAssertion } from "./command-auth-BHrKDij6.mjs";`));
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

test("helper: verified owner on a file-arm flush keeps the owner identity", () => {
  const resolve = loadHelper(() => undefined);
  const identity = resolve({ sourceRun: OWNER_RUN, memoryFlushWritePath: WRITE_PATH, sourceTurnTainted: false });
  assert.ok(identity);
  assert.equal(identity.hasCommandOwnerAuthority, false);
  assert.deepEqual(identity.currentSessionCtx(), { SenderId: "+15550001234", SenderE164: "+15550001234", SenderName: "Owner" });
  const a = identity.currentSessionCtx();
  a.SenderE164 = "+19999999999";
  assert.equal(identity.currentSessionCtx().SenderE164, "+15550001234", "callers get a copy, not the frozen source");
});

test("helper: everything that is not a verified, untainted, file-arm owner turn keeps upstream behaviour", () => {
  const resolve = loadHelper(() => undefined);
  const cases = {
    "non-owner sender": { sourceRun: { ...OWNER_RUN, senderIsOwner: false }, memoryFlushWritePath: WRITE_PATH },
    "owner flag missing": { sourceRun: { senderId: "+15550001234" }, memoryFlushWritePath: WRITE_PATH },
    "truthy but not true owner flag": { sourceRun: { ...OWNER_RUN, senderIsOwner: "true" }, memoryFlushWritePath: WRITE_PATH },
    "tainted source turn": { sourceRun: OWNER_RUN, memoryFlushWritePath: WRITE_PATH, sourceTurnTainted: true },
    "tools-arm flush (no write path)": { sourceRun: OWNER_RUN, memoryFlushWritePath: undefined },
    "blank write path": { sourceRun: OWNER_RUN, memoryFlushWritePath: "  " },
    "owner without sender identity": { sourceRun: { senderIsOwner: true, senderName: "Owner" }, memoryFlushWritePath: WRITE_PATH },
    "no source run": { sourceRun: undefined, memoryFlushWritePath: WRITE_PATH },
  };
  for (const [name, input] of Object.entries(cases)) assert.equal(resolve(input), undefined, name);
});

test("helper: command-owner authority is enforced at resolve time and before every attempt", () => {
  let current = true;
  const assertion = () => {
    if (!current) throw new Error("Channel operator authority changed; send a new request.");
  };
  const resolve = loadHelper((run) => (run === OWNER_RUN ? assertion : undefined));
  const identity = resolve({ sourceRun: OWNER_RUN, memoryFlushWritePath: WRITE_PATH });
  assert.equal(identity.hasCommandOwnerAuthority, true);
  assert.ok(identity.currentSessionCtx());
  current = false;
  assert.throws(() => identity.currentSessionCtx(), /authority changed/, "revocation after resolve aborts the flush attempt");
  assert.equal(resolve({ sourceRun: OWNER_RUN, memoryFlushWritePath: WRITE_PATH }), undefined, "revoked owner falls back to anonymous upstream identity");
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
