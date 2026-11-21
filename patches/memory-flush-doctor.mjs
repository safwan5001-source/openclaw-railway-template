#!/usr/bin/env node
// Read-only memory-flush diagnostic for the BASHT OpenClaw container.
//
//   node /app/patches/memory-flush-doctor.mjs            # human report
//   node /app/patches/memory-flush-doctor.mjs --json     # machine report
//
// It never writes config, sessions or memory, never restarts the gateway and never sends messages. It reads the
// live config through `openclaw config get`, the session list through `openclaw sessions list --json`, and then
// replays OpenClaw's own tool-policy assembly (the exact code the gateway runs) for four cases:
//   owner_turn        the owner's normal WhatsApp turn
//   flush_upstream    the pre-compaction memory flush as stock OpenClaw 2026.10.9 builds it (anonymous non-owner)
//   flush_patched     the same flush with the BASHT owner-identity patch (verified owner identity kept)
//   flush_impostor    a flush whose source turn came from a non-owner number (must never gain `write`)
// For each case it names the policy step that removed `write`, so the report says whether the remaining problem
// is identity propagation (fixed by the patch) or an operator tool policy (needs an explicit config decision).
// Phone numbers and WhatsApp ids are masked in the output.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const JSON_OUT = process.argv.includes("--json");
const PKG = process.env.OPENCLAW_PACKAGE_ROOT
  || path.resolve(path.dirname(process.env.OPENCLAW_ENTRY || "/usr/local/lib/node_modules/openclaw/dist/entry.js"), "..");
const ENTRY = path.join(PKG, "dist/entry.js");
const AGENT_TOOLS_CHUNK = "dist/agent-tools-Bpi7xWYy.mjs";
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

function cli(args) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", timeout: 120_000, env: process.env });
  const text = (r.stdout || "").trim();
  try {
    return { ok: r.status === 0, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: (r.stderr || text || `exit ${r.status}`).trim().split("\n").slice(-3).join(" | ") };
  }
}

function readConfigSection(key) {
  const r = cli(["config", "get", key, "--json"]);
  if (r.ok && r.value && r.value.ok === false) return { missing: true, error: r.value.error?.message };
  return r.ok ? { value: r.value } : { missing: true, error: r.error };
}

function normalizeOwnerCandidates(commands, whatsapp) {
  const raw = [...(commands?.ownerAllowFrom ?? []), ...(whatsapp?.allowFrom ?? [])].map(String);
  const e164 = [...new Set(raw.map((v) => v.replace(/^whatsapp:/i, "")).filter((v) => /^\+\d{7,15}$/.test(v)))];
  return { raw, e164 };
}

async function simulate(config, ownerE164, workspaceDir) {
  const mod = await import(pathToFileURL(path.join(PKG, AGENT_TOOLS_CHUNK)).href);
  const createInternal = mod.i; // createOpenClawCodingToolsInternalAsync(options, skillReadResources, onPolicyFilter)
  if (typeof createInternal !== "function") throw new Error(`unexpected export shape in ${AGENT_TOOLS_CHUNK}`);
  const impostor = "+10000000001";
  const sessionKey = `agent:main:whatsapp:direct:${ownerE164 ?? "+10000000000"}`;
  const base = { config, agentId: "main", sessionKey, workspaceDir, messageProvider: "whatsapp", messageChannel: "whatsapp", chatType: "direct" };
  const flush = { trigger: "memory", memoryFlushWritePath: `memory/${new Date().toISOString().slice(0, 10)}.md` };
  const cases = {
    owner_turn: { ...base, senderIsOwner: true, senderE164: ownerE164, senderId: ownerE164 },
    flush_upstream: { ...base, ...flush, senderIsOwner: false },
    flush_patched: { ...base, ...flush, senderIsOwner: true, senderE164: ownerE164, senderId: ownerE164 },
    flush_impostor: { ...base, ...flush, senderIsOwner: false, senderE164: impostor, senderId: impostor },
  };
  const results = {};
  for (const [name, options] of Object.entries(cases)) {
    const removedBy = [];
    try {
      const tools = await createInternal(options, undefined, (event) => {
        const had = event.before.some((t) => t.name === "write");
        const has = event.after.some((t) => t.name === "write");
        if (had && !has) removedBy.push(event.step?.label ?? "unknown step");
      });
      const names = tools.map((t) => t.name).sort();
      results[name] = {
        write: names.includes("write"),
        toolCount: names.length,
        tools: name.startsWith("flush") ? names : undefined,
        writeRemovedBy: removedBy,
      };
    } catch (err) {
      results[name] = { error: err.message };
    }
  }
  return results;
}

function verdict(sim) {
  if (!sim || sim.error) return "simulation unavailable";
  const { owner_turn: o, flush_upstream: u, flush_patched: p, flush_impostor: i } = sim;
  if (i?.write && !u?.write) return "UNSAFE: a non-owner sender identity gains write in the flush — review tools.toolsBySender before deploying";
  if (u?.write) return "flush already keeps write without the patch; the patch is harmless here";
  if (p?.write) return "identity propagation is the cause: the BASHT patch restores the append-only flush writer";
  if (o?.write === false) return "operator tool policy removes write for the owner too (config decision needed; the patch alone cannot fix it)";
  return "write is removed for the flush even with owner identity: see writeRemovedBy for the blocking policy step";
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), host: os.hostname(), packageRoot: PKG };
  try {
    report.openclawVersion = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version;
    report.patchApplied = fs.readFileSync(path.join(PKG, PATCH_TARGET), "utf8").includes(PATCH_MARKER);
  } catch (err) {
    report.packageError = err.message;
  }

  const sections = {};
  for (const key of ["tools", "agents", "channels.whatsapp", "commands", "session"]) sections[key] = readConfigSection(key);
  const config = {
    ...(sections.tools.value ? { tools: sections.tools.value } : {}),
    ...(sections.agents.value ? { agents: sections.agents.value } : {}),
    ...(sections["channels.whatsapp"].value ? { channels: { whatsapp: sections["channels.whatsapp"].value } } : {}),
    ...(sections.commands.value ? { commands: sections.commands.value } : {}),
    ...(sections.session.value ? { session: sections.session.value } : {}),
  };
  const agentMain = config.agents?.entries?.main ?? {};
  report.policy = {
    toolsProfile: config.tools?.profile ?? null,
    toolsAllow: config.tools?.allow ?? null,
    toolsAlsoAllow: config.tools?.alsoAllow ?? null,
    toolsDeny: config.tools?.deny ?? null,
    toolsBySenderKeys: Object.keys(config.tools?.toolsBySender ?? {}).map(maskId),
    agentMainTools: agentMain.tools
      ? { ...agentMain.tools, toolsBySender: agentMain.tools.toolsBySender ? Object.keys(agentMain.tools.toolsBySender).map(maskId) : undefined }
      : null,
    sandboxMode: agentMain.sandbox?.mode ?? config.agents?.defaults?.sandbox?.mode ?? null,
    memoryFlush: config.agents?.defaults?.compaction?.memoryFlush ?? null,
    whatsappDmPolicy: config.channels?.whatsapp?.dmPolicy ?? null,
    sessionDmScope: config.session?.dmScope ?? null,
    configErrors: Object.fromEntries(Object.entries(sections).filter(([, v]) => v.missing).map(([k, v]) => [k, v.error])),
  };
  const owners = normalizeOwnerCandidates(config.commands, config.channels?.whatsapp);
  report.ownerIdentity = {
    configuredOwnerEntries: owners.raw.map(maskId),
    configuredForms: [...new Set(owners.raw.map(classifyWhatsAppId))],
  };

  const sessions = cli(["sessions", "list", "--json", "--limit", "200"]);
  const rows = Array.isArray(sessions.value) ? sessions.value : sessions.value?.sessions ?? [];
  const whatsapp = rows.filter((row) => String(row?.key ?? "").includes(":whatsapp:"));
  report.whatsappSessions = whatsapp.slice(0, 10).map((row) => {
    const keyId = String(row.key).split(":").pop();
    const from = row.origin?.from ?? row.lastFrom ?? row.deliveryContext?.to ?? row.lastTo;
    return {
      key: maskId(row.key),
      keyIdForm: classifyWhatsAppId(keyId),
      originForm: classifyWhatsAppId(from),
      chatType: row.chatType ?? row.origin?.chatType ?? null,
      totalTokens: row.totalTokens ?? null,
      compactionCount: row.compactionCount ?? null,
      memoryFlush: row.memoryFlush ?? null,
    };
  });
  if (!sessions.ok) report.sessionsError = sessions.error;

  const workspace = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
  try {
    const memDir = path.join(workspace, "memory");
    const files = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() : [];
    report.memoryFiles = { dir: memDir, count: files.length, latest: files.slice(-3).map((f) => ({ file: f, bytes: fs.statSync(path.join(memDir, f)).size })) };
  } catch (err) {
    report.memoryFiles = { error: err.message };
  }

  try {
    // Simulation runs in a throwaway workspace so even OpenClaw's tool construction cannot touch /data.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "basht-flush-doctor-"));
    report.simulation = await simulate(config, owners.e164[0], scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch (err) {
    report.simulation = { error: err.message };
  }
  report.verdict = verdict(report.simulation);

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`BASHT memory-flush doctor — OpenClaw ${report.openclawVersion ?? "?"}, patch ${report.patchApplied ? "APPLIED" : "not applied"}`);
    console.log(`Owner entries: ${report.ownerIdentity.configuredOwnerEntries.join(", ") || "none"} (forms: ${report.ownerIdentity.configuredForms.join(", ")})`);
    for (const s of report.whatsappSessions) console.log(`Session ${s.key}: key=${s.keyIdForm} origin=${s.originForm} chat=${s.chatType} tokens=${s.totalTokens} flush=${JSON.stringify(s.memoryFlush)}`);
    console.log(`Policy: ${JSON.stringify(report.policy)}`);
    for (const [name, r] of Object.entries(report.simulation ?? {})) {
      console.log(`  ${name.padEnd(15)} write=${r.write ?? "?"} ${r.writeRemovedBy?.length ? `removed by: ${r.writeRemovedBy.join(" > ")}` : ""}${r.tools ? ` tools=${r.tools.join(",")}` : ""}${r.error ? ` error=${r.error}` : ""}`);
    }
    console.log(`Memory files: ${JSON.stringify(report.memoryFiles)}`);
    console.log(`VERDICT: ${report.verdict}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(() => process.exit(0), (err) => {
    console.error(`[memory-flush-doctor] ${err.stack || err.message}`);
    process.exit(1);
  });
}
