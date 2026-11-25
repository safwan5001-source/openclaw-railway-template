#!/usr/bin/env node
// BASHT build-time patch for OpenClaw 2026.11.10: keep the verified owner's identity on the pre-compaction
// memory flush (file arm only).
//
// Upstream behaviour: runMemoryFlushIfNeeded() builds the flush turn with createSessionMaintenanceFollowup(),
// which hard-codes `senderIsOwner: false` and passes `sessionCtx: {}`. The flush therefore resolves tool policy
// as an anonymous non-owner (no SenderId/SenderE164), so any sender-scoped policy (tools.toolsBySender, group
// toolsBySender) that grants `write` only to the owner removes it, and the flush logs
// "memory flush cannot persist memory/<date>.md: no write tool survived this agent's tool policy".
// Writes that do survive are tagged with "untrusted" provenance because the run claims a non-owner sender.
//
// Patch (fail-closed): the flush keeps the owner identity only when ALL hold —
//   * the source turn was an owner turn (senderIsOwner === true) and its transcript is not tainted;
//   * the flush uses the file arm (tools projected to `read` + append-only `write` locked to memory/<date>.md);
//   * ownership is proven again at flush time by OpenClaw's own channel-owner rule (get-reply isCurrentChannelOwner):
//     a bound command-owner authority must be current (revoked => denied, no fallback), otherwise the sender must
//     match commands.ownerAllowFrom in the live config (wildcards never count);
//   * only the sender identifiers that individually prove ownership are propagated.
// The proof is repeated before every model attempt. WhatsApp (OpenClaw 2026.11.10) marks its sender identifier
// "asserted", not "verified", so it never yields a command-owner authority; its owner basis is the configured-owner
// match — the same basis OpenClaw already uses to grant that sender the owner's tools on the live turn.
// Everything else (non-owner sessions, tainted turns, tools-arm providers, owner-only tool deny list, append-only
// projection) is unchanged.
//
// The patch is exact-match and version-pinned: any drift (different OpenClaw version, different file hash, an
// anchor that matches zero or several times) fails the image build instead of shipping a half-patched runtime.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCLAW_VERSION = "2026.11.10";
export const TARGET_FILE = "dist/agent-runner-memory-Bmk5_PZf.mjs";
export const ORIGINAL_SHA256 = "8cf5d7d6637baa3df48ae2e17814a1f58416c5fb9c875e0c875c2403601f623e";
export const PATCH_MARKER = "basht-patch:memory-flush-owner-identity";
const CONTENT_INVENTORY = "dist/postinstall-content-inventory.json";

const IMPORT_ANCHOR = `const preflightCompactionLog=createSubsystemLogger(`;
const IMPORT_ADDITION = `import { h as getCommandOwnerAuthority, t as isConfiguredCommandOwner } from "./command-auth-Ch_q0NQN.mjs";\nimport { getRuntimeConfig } from "./io.runtime-euLviN5p.mjs";\n`;
const RUN_ANCHOR = `maintenanceRun:P,sourcePolicySessionKey:F}=E;`;
const RUN_ADDITION = `const bashtOwnerFlushIdentity=resolveBashtOwnerMemoryFlushIdentity({sourceRun:e.followupRun.run,memoryFlushWritePath:D,sourceTurnTainted:v?.turnTainted!==false});if(bashtOwnerFlushIdentity)P.senderIsOwner=true;`;
const CTX_ANCHOR = `run:{...P,thinkLevel:o},sessionCtx:{},`;
const CTX_REPLACEMENT = `run:{...P,thinkLevel:o},sessionCtx:bashtOwnerFlushIdentity?bashtOwnerFlushIdentity.currentSessionCtx():{},`;
const EXPORT_ANCHOR = `export{runSessionCompactionIfNeeded as n,runMemoryFlushIfNeeded as t};`;
const HELPER = `//#region ${PATCH_MARKER}
/**
* Owner identity for a file-arm memory flush, or undefined to keep upstream's anonymous maintenance identity.
* Fails closed. The propagated senderIsOwner flag alone is never sufficient: the sender must ALSO be proven to be the
* owner now, by the same rule OpenClaw uses for channel-owner cron authority (get-reply: isCurrentChannelOwner):
*   bound command-owner authority  -> authority.isCurrent()        (revoked/expired => denied, no fallback)
*   no bound authority             -> isConfiguredCommandOwner(live config, sender)  (commands.ownerAllowFrom,
*                                     wildcards never count)
* Only identifiers that individually prove ownership are propagated; the proof is repeated before every attempt.
*/
function resolveBashtOwnerMemoryFlushIdentity(params) {
	const run = params.sourceRun;
	if (!run || run.senderIsOwner !== true || params.sourceTurnTainted === true) return;
	if (typeof params.memoryFlushWritePath !== "string" || !params.memoryFlushWritePath.trim()) return;
	const text = (value) => typeof value === "string" && value.trim() ? value.trim() : void 0;
	const channel = text(run.messageProvider);
	if (!channel) return;
	const accountId = text(run.agentAccountId);
	const authority = getCommandOwnerAuthority(run);
	const candidates = { SenderId: text(run.senderId), SenderE164: text(run.senderE164) };
	const provesOwner = (senderId) => {
		try {
			if (authority) return authority.isCurrent() === true;
			return isConfiguredCommandOwner(getRuntimeConfig(), { channel, accountId, senderId });
		} catch {
			return false;
		}
	};
	const sender = {};
	for (const [key, value] of Object.entries(candidates)) if (value && provesOwner(value)) sender[key] = value;
	if (!sender.SenderId && !sender.SenderE164) return;
	const name = text(run.senderName);
	const username = text(run.senderUsername);
	if (name) sender.SenderName = name;
	if (username) sender.SenderUsername = username;
	Object.freeze(sender);
	const verifiedIds = [sender.SenderE164, sender.SenderId].filter(Boolean);
	return Object.freeze({
		ownerBasis: authority ? "command-owner-authority" : "configured-owner",
		currentSessionCtx: () => {
			if (!verifiedIds.every(provesOwner)) throw new Error("Memory flush owner identity is no longer current; the flush was not run as owner.");
			return { ...sender };
		}
	});
}
//#endregion
`;

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first === -1) throw new Error(`memory-flush patch: anchor not found (${label})`);
  if (source.indexOf(anchor, first + anchor.length) !== -1) throw new Error(`memory-flush patch: anchor not unique (${label})`);
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Pure transform of the original module text. Throws on any drift. */
export function patchSource(original) {
  if (original.includes(PATCH_MARKER)) throw new Error("memory-flush patch: already applied");
  let out = original;
  out = replaceOnce(out, IMPORT_ANCHOR, IMPORT_ADDITION + IMPORT_ANCHOR, "import");
  out = replaceOnce(out, RUN_ANCHOR, RUN_ANCHOR + RUN_ADDITION, "maintenance run");
  out = replaceOnce(out, CTX_ANCHOR, CTX_REPLACEMENT, "flush sessionCtx");
  out = replaceOnce(out, EXPORT_ANCHOR, "\n" + HELPER + EXPORT_ANCHOR, "export");
  return out;
}

function readPackageVersion(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

/** Keep OpenClaw's own dist content inventory consistent with the patched file (used by update/doctor checks). */
function updateContentInventory(packageRoot, relativePath, text, mode) {
  const inventoryPath = path.join(packageRoot, CONTENT_INVENTORY);
  if (!fs.existsSync(inventoryPath)) return false;
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const entry = Array.isArray(inventory) ? inventory.find((item) => item?.path === relativePath) : undefined;
  if (!entry) throw new Error(`memory-flush patch: ${relativePath} missing from ${CONTENT_INVENTORY}`);
  entry.sha256 = sha256(text);
  entry.size = Buffer.byteLength(text);
  entry.mode = mode & 0o777;
  fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return true;
}

/** Patch an installed OpenClaw package in place. Idempotent when the patched file is already present. */
export function applyToPackage(packageRoot, { log = console } = {}) {
  const version = readPackageVersion(packageRoot);
  if (version !== OPENCLAW_VERSION) {
    throw new Error(`memory-flush patch: expected openclaw ${OPENCLAW_VERSION}, found ${version}. Re-validate the patch before upgrading.`);
  }
  const target = path.join(packageRoot, TARGET_FILE);
  const stat = fs.statSync(target);
  const current = fs.readFileSync(target, "utf8");
  if (current.includes(PATCH_MARKER)) {
    const original = readOriginalFromPatched(current);
    if (sha256(original) !== ORIGINAL_SHA256 || patchSource(original) !== current) {
      throw new Error("memory-flush patch: target carries the marker but does not match the expected patched content");
    }
    log.info?.(`[memory-flush-patch] already applied to ${TARGET_FILE}`);
    return { applied: false, alreadyPatched: true };
  }
  if (sha256(current) !== ORIGINAL_SHA256) {
    throw new Error(`memory-flush patch: ${TARGET_FILE} hash ${sha256(current)} != expected ${ORIGINAL_SHA256}`);
  }
  const patched = patchSource(current);
  fs.writeFileSync(target, patched, { mode: stat.mode });
  const inventoryUpdated = updateContentInventory(packageRoot, TARGET_FILE, patched, stat.mode);
  log.info?.(`[memory-flush-patch] patched ${TARGET_FILE} (sha256 ${sha256(patched)}; inventory ${inventoryUpdated ? "updated" : "absent"})`);
  return { applied: true, alreadyPatched: false, sha256: sha256(patched) };
}

/** Reverse the four additive edits (used only to verify an already-patched file byte-for-byte). */
export function readOriginalFromPatched(patched) {
  let out = patched;
  out = replaceOnce(out, IMPORT_ADDITION + IMPORT_ANCHOR, IMPORT_ANCHOR, "unpatch import");
  out = replaceOnce(out, RUN_ANCHOR + RUN_ADDITION, RUN_ANCHOR, "unpatch maintenance run");
  out = replaceOnce(out, CTX_REPLACEMENT, CTX_ANCHOR, "unpatch flush sessionCtx");
  out = replaceOnce(out, "\n" + HELPER + EXPORT_ANCHOR, EXPORT_ANCHOR, "unpatch export");
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] || "/usr/local/lib/node_modules/openclaw";
  try {
    applyToPackage(root);
  } catch (err) {
    console.error(`[memory-flush-patch] ${err.message}`);
    process.exit(1);
  }
}
