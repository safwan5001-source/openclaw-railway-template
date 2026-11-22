#!/usr/bin/env node
// Read-only memory-flush diagnostic for the BASHT OpenClaw container.
//
//   gosu openclaw node /app/patches/memory-flush-doctor.mjs            # human report
//   gosu openclaw node /app/patches/memory-flush-doctor.mjs --json     # machine report
// (refuses to run as root; see main())
//
// STRICTLY READ-ONLY. It never runs the OpenClaw CLI (`openclaw sessions list` writes state/openclaw.sqlite and every
// CLI start fills the node compile cache in TMPDIR), never opens a database and never imports OpenClaw in-process
// (OpenClaw's file logger appends to the live gateway's /tmp/openclaw log). It:
//   * reads openclaw.json through an O_RDONLY|O_NOFOLLOW handle to report the owner entries and their forms;
//   * derives the owner with the SAME normaliser as owner-check.mjs (whatsapp-owner.mjs, a mirror of OpenClaw
//     2026.10.9's isConfiguredCommandOwner for WhatsApp), so the two tools cannot disagree about the owner;
//   * gets the tool-policy replay from owner-check.mjs, which runs it in a sandboxed child (throwaway HOME/TMPDIR/
//     state, only tool-policy fields, OpenClaw logging silenced) and returns one masked line;
//   * reads the patch marker and lists memory/<date>.md files (names + sizes only).
// The replay covers, per agent that holds the owner's WhatsApp DM:
//   owner_turn        the owner's normal WhatsApp turn
//   flush_upstream    the pre-compaction memory flush as stock OpenClaw 2026.10.9 builds it (anonymous non-owner)
//   flush_patched     the same flush with the BASHT owner-identity patch (verified owner identity kept)
//   flush_impostor    a flush whose source turn came from a non-owner number (must never gain `write`)
// Phone numbers and WhatsApp ids are masked in the output.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyOwnerEntry, normalizeWhatsAppSender } from "./whatsapp-owner.mjs";

const JSON_OUT = process.argv.includes("--json");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER_CHECK = path.join(HERE, "owner-check.mjs");
const PKG = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/local/lib/node_modules/openclaw"; // same resolution as owner-check.mjs
const PATCH_TARGET = "dist/agent-runner-memory-BkOUjtvi.mjs";
const PATCH_MARKER = "basht-patch:memory-flush-owner-identity";

export function maskId(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\d{5,}/g, (digits) => `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`);
}

/** PN = phone-number JID / E.164, LID = WhatsApp linked-identity id. */
export function classifyWhatsAppId(value) {
  if (typeof value !== "string" || !value) return "none";
  if (/@lid\b/i.test(value) || /^lid:/i.test(value)) return "LID";
  if (/@s\.whatsapp\.net\b/i.test(value) || /^\+?\d{7,15}$/.test(value) || /:\+?\d{7,15}$/.test(value)) return "PN";
  return "other";
}

/**
 * Mirrors the patch's fail-closed gate with OpenClaw's own owner rule: only commands.ownerAllowFrom proves ownership
 * (no command-owner authority exists for WhatsApp in 2026.10.9), in every form OpenClaw accepts ("whatsapp:+E164",
 * "whatsapp:<digits>" without "+", bare digits, user JIDs). channels.whatsapp.allowFrom admits a sender but does NOT
 * make it the owner; wildcards and other-channel entries never count.
 */
export function normalizeOwnerCandidates(commands, whatsapp) {
  const ownerAllowFrom = (Array.isArray(commands?.ownerAllowFrom) ? commands.ownerAllowFrom : []).map(String);
  const classified = ownerAllowFrom.map((v) => (v.includes("${") ? { kind: "unrecognised" } : classifyOwnerEntry(v)));
  const configuredOwners = [...new Set(classified.filter((c) => c.kind === "owner").map((c) => c.e164))];
  const channelAllowFrom = (Array.isArray(whatsapp?.allowFrom) ? whatsapp.allowFrom : []).map(String);
  const channelNumbers = [...new Set(channelAllowFrom.map(normalizeWhatsAppSender).filter(Boolean))];
  return {
    raw: [...ownerAllowFrom, ...channelAllowFrom],
    configuredOwners,
    ownerForms: [...new Set(classified.filter((c) => c.kind === "owner").map((c) => c.form))],
    unrecognised: classified.filter((c) => c.kind === "unrecognised").length,
    channelOnly: channelNumbers.filter((v) => !configuredOwners.includes(v)),
  };
}

export function verdict(sim, ownerVerified = true) {
  if (!sim || sim.error) return "simulation unavailable";
  const { owner_turn: o, flush_upstream: u, flush_patched: p, flush_impostor: i } = sim;
  if (i?.write && !u?.write) return "UNSAFE: a non-owner sender identity gains write in the flush — review tools.toolsBySender before deploying";
  if (u?.write) return "flush already keeps write without the patch; the patch is harmless here";
  if (!ownerVerified) return "OWNER UNVERIFIED: no WhatsApp owner in commands.ownerAllowFrom — the patch fails closed and the flush stays anonymous (add the owner to commands.ownerAllowFrom; config decision needed)";
  if (p?.write) return "identity propagation is the cause: the BASHT patch restores the append-only flush writer";
  if (o?.write === false) return "operator tool policy removes write for the owner too (config decision needed; the patch alone cannot fix it)";
  return "write is removed for the flush even with owner identity: see writeRemovedBy for the blocking policy step";
}

/** owner-check agent result -> the doctor's four named cases. */
export function simulationFromOwnerCheck(agent) {
  if (!agent) return undefined;
  const pick = (r) => (r ? { write: Boolean(r.write), read: Boolean(r.read), toolCount: r.tools, writeRemovedBy: r.removedBy?.write ?? [] } : undefined);
  const sim = { owner_turn: pick(agent.owner_live_turn), flush_upstream: pick(agent.flush_anonymous), flush_patched: pick(agent.flush_with_owner_identity), flush_impostor: pick(agent.flush_unknown_sender) };
  return Object.fromEntries(Object.entries(sim).filter(([, v]) => v));
}

/**
 * Final verdict. owner-check's VERDICT is authoritative for readiness; the doctor adds the cause analysis. If the two
 * tools ever derive a different owner count the report says so instead of picking one.
 */
export function combinedVerdict({ ownerCheck, owners, sim }) {
  if (!ownerCheck || typeof ownerCheck.VERDICT !== "string") return "BLOCKED: owner-check did not return a result";
  if (typeof ownerCheck.q1_explicit_whatsapp_owner_entries === "number" && ownerCheck.q1_explicit_whatsapp_owner_entries !== owners.configuredOwners.length) {
    return `INCONSISTENT: doctor derived ${owners.configuredOwners.length} owner(s), owner-check ${ownerCheck.q1_explicit_whatsapp_owner_entries}; do not act on either result`;
  }
  const cause = verdict(sim, owners.configuredOwners.length > 0);
  return ownerCheck.VERDICT.startsWith("READY") ? `${ownerCheck.VERDICT} | cause: ${cause}` : `${ownerCheck.VERDICT} | doctor: ${cause}`;
}

const readOnlyText = (file) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
};

function readConfig() {
  const state = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"));
  const file = path.resolve(process.env.OPENCLAW_CONFIG_PATH || path.join(state, "openclaw.json"));
  const text = readOnlyText(file);
  try { return JSON.parse(text); } catch { return createRequire(path.join(PKG, "package.json"))("json5").parse(text); }
}

function runOwnerCheck() {
  const r = spawnSync(process.execPath, [OWNER_CHECK], { env: process.env, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "ignore"] });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("BASHT_OWNER_CHECK "));
  if (!line) return { error: r.error ? r.error.name : `owner-check exit ${r.status ?? r.signal}` };
  return JSON.parse(line.slice("BASHT_OWNER_CHECK ".length));
}

async function main() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error("[memory-flush-doctor] refusing to run as root; use: gosu openclaw node /app/patches/memory-flush-doctor.mjs");
    process.exit(2);
  }
  const report = { generatedAt: new Date().toISOString(), readOnly: true, packageRoot: PKG };
  try {
    report.openclawVersion = JSON.parse(readOnlyText(path.join(PKG, "package.json"))).version;
    report.patchApplied = readOnlyText(path.join(PKG, PATCH_TARGET)).includes(PATCH_MARKER);
  } catch (err) {
    report.packageError = err.name;
  }

  let config = {};
  try {
    config = readConfig() ?? {};
  } catch (err) {
    report.configError = err.name;
  }
  const owners = normalizeOwnerCandidates(config.commands, config.channels?.whatsapp);
  report.ownerIdentity = {
    configuredOwnerEntries: owners.raw.map(maskId),
    configuredForms: [...new Set(owners.raw.map(classifyWhatsAppId))],
    verifiedOwners: owners.configuredOwners.map(maskId),
    verifiedOwnerForms: owners.ownerForms,
    unrecognisedOwnerEntries: owners.unrecognised,
    allowedButNotOwner: owners.channelOnly.map(maskId),
  };
  const agentMain = config.agents?.entries?.main ?? {};
  report.policy = {
    sandboxMode: agentMain.sandbox?.mode ?? config.agents?.defaults?.sandbox?.mode ?? null,
    memoryFlush: config.agents?.defaults?.compaction?.memoryFlush ?? null,
    whatsappDmPolicy: config.channels?.whatsapp?.dmPolicy ?? null,
    sessionDmScope: config.session?.dmScope ?? null,
  };

  report.ownerCheck = runOwnerCheck();
  const agents = Array.isArray(report.ownerCheck.agents) ? report.ownerCheck.agents : [];
  report.simulation = Object.fromEntries(agents.map((a) => [a.agent, simulationFromOwnerCheck(a)]));
  const mainSim = report.simulation.main ?? Object.values(report.simulation)[0] ?? { error: report.ownerCheck.simulation_error ?? report.ownerCheck.error ?? "no simulation" };

  const workspace = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
  try {
    const memDir = path.join(workspace, "memory");
    const files = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() : [];
    report.memoryFiles = { dir: memDir, count: files.length, latest: files.slice(-3).map((f) => ({ file: f, bytes: fs.statSync(path.join(memDir, f)).size })) };
  } catch (err) {
    report.memoryFiles = { error: err.name };
  }
  report.verdict = combinedVerdict({ ownerCheck: report.ownerCheck, owners, sim: mainSim });

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`BASHT memory-flush doctor (read-only) — OpenClaw ${report.openclawVersion ?? "?"}, patch ${report.patchApplied ? "APPLIED" : "not applied"}`);
    console.log(`Owner entries: ${report.ownerIdentity.configuredOwnerEntries.join(", ") || "none"} (forms: ${report.ownerIdentity.configuredForms.join(", ")})`);
    console.log(`Verified owners (commands.ownerAllowFrom): ${report.ownerIdentity.verifiedOwners.join(", ") || "NONE"} [${report.ownerIdentity.verifiedOwnerForms.join(", ")}]; unrecognised: ${report.ownerIdentity.unrecognisedOwnerEntries}; allowed but not owner: ${report.ownerIdentity.allowedButNotOwner.join(", ") || "none"}`);
    console.log(`owner-check: ${report.ownerCheck.VERDICT ?? report.ownerCheck.error}`);
    for (const [agent, sim] of Object.entries(report.simulation)) {
      for (const [name, r] of Object.entries(sim ?? {})) {
        console.log(`  ${agent}/${name.padEnd(15)} write=${r.write} ${r.writeRemovedBy?.length ? `removed by: ${r.writeRemovedBy.join(" > ")}` : ""}`);
      }
    }
    console.log(`Memory files: ${JSON.stringify(report.memoryFiles)}`);
    console.log(`VERDICT: ${report.verdict}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(() => process.exit(0), (err) => {
    console.error(`[memory-flush-doctor] ${err.name}`);
    process.exit(1);
  });
}
