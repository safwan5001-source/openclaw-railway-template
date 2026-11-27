// BASHT app control (B5 + B6 + B7): what the owner's app may SEE of the engine beyond the chat, plus two automation switches.
// Mounted by src/app-bridge.js under /app/v1 (after its token check), so every route here needs BASHT_APP_TOKEN.
//
//   GET  /app/v1/automations                 -> the engine's scheduled jobs (cron.list), fixed shape, cached 20 s
//   GET  /app/v1/automations/:id/runs        -> that job's recent runs (cron.runs scope "job", <= 20), short summaries
//   POST /app/v1/automations/:id/run         -> run it now (cron.run {id, mode:"force"}), owner-created jobs only
//   POST /app/v1/automations/:id/enabled     -> {enabled: boolean} (cron.update {id, patch:{enabled}}), owner-created jobs only
//   GET  /app/v1/usage                       -> app-session tokens/cost (sessions.usage) + all-agents 30-day totals (usage.cost)
//   GET  /app/v1/memory/status               -> index state and counts (memory.status) + MEMORY.md / USER.md presence
//   GET  /app/v1/memory/search?q=&page=      -> memory.search over memory files only (never session transcripts)
//   GET  /app/v1/memory/item?ref=&part=      -> one search hit's file text (memory.get), by an opaque ref this bridge issued
//   GET  /app/v1/memory/file?name=&part=     -> MEMORY.md or USER.md (agents.files.get), read-only
//   GET  /app/v1/capabilities                -> channels (linked/connected), skills ready/missing, effective tools, plugins
//
// Rules (same as the bridge): raw engine objects never leave this module — every route builds one fixed shape; no server
// paths, config, account ids or secrets; engine error text is never passed on (paths in run summaries are scrubbed).
// Writes: only cron.run and cron.update, with params built HERE (validateControlRpc re-checks them in the wrapper), one at a
// time, never on engine-managed jobs (declarationKey). No create/edit/delete, no memory edits, no installs, no config writes.
// Cost: each gateway call spawns the CLI (~1.6 s, ~1.5 s CPU), so reads are cached and at most MAX_CONCURRENT run at once.
import crypto from "node:crypto";
import express from "express";

export const CONTROL_READ_RPC = Object.freeze(["cron.list", "cron.runs", "sessions.usage", "usage.cost", "memory.status", "memory.search",
  "memory.get", "agents.files.list", "agents.files.get", "skills.status", "tools.effective", "tools.catalog", "channels.status", "plugins.list"]);
export const CONTROL_WRITE_RPC = Object.freeze(["cron.run", "cron.update"]);
export const MEMORY_FILES = Object.freeze(["MEMORY.md", "USER.md"]);
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AGENT = "main";
const MAX_CONCURRENT = 2;
const TTL = { jobs: 20_000, runs: 20_000, usage: 60_000, memoryStatus: 30_000, search: 30_000, file: 30_000, caps: 60_000, catalog: 600_000 };
const MAX_JOBS = 200;
const MAX_RUNS = 20;
const MAX_QUERY = 200;
const SEARCH_PAGE = 10;
const SEARCH_PAGES = 3;
const PART_CHARS = 20_000;
const MAX_PARTS = 10;
const REFS_KEPT = 300;
const REF_TTL_MS = 30 * 60_000;
const RUN_STATUS = ["ok", "error", "skipped"];
const COMPLETION = ["succeeded", "failed", "unknown"];
const DELIVERY = ["delivered", "not-delivered", "unknown", "not-requested"];
const NAME = /^[A-Za-z0-9_.+-]{1,64}$/;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);
const names = (v, max = 4) => (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && NAME.test(x)).slice(0, max);

// Absolute paths (not URLs: a "/" right after a word, ":" "/" or "." is part of a URL or a relative ref) and secret-shaped tokens.
const PATHISH = /(?<![\w:/.~-])(?:~\/|\/)(?:[\w.@+-]+\/)+[\w.@+-]*|\b[A-Za-z]:\\[\w\\.@+ -]+/g;
const SECRETISH = /\b(?:sk|pk|rk|xox[abprs]|gh[opsu]|glpat)[-_][A-Za-z0-9_-]{8,}|__OPENCLAW_REDACTED__/g;

/** Display text from an upstream value: strings only, control characters (except newlines) removed, paths and secret-shaped
 * tokens replaced, capped. Else null. */
export function cleanText(v, max = 200, { multiline = false } = {}) {
  if (typeof v !== "string") return null;
  let s = v.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, multiline ? "" : " ");
  s = s.replace(PATHISH, "…").replace(SECRETISH, "…").trim();
  if (!multiline) s = s.replace(/\s+/g, " ");
  return s ? (s.length > max ? s.slice(0, max - 1) + "…" : s) : null;
}

/** File name only, for a memory source. Never a directory. */
export function baseName(v) {
  if (typeof v !== "string") return null;
  const b = v.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return /^[^\u0000-\u001f<>:"|?*]{1,120}$/.test(b) && b !== "." && b !== ".." ? b : null;
}

/**
 * The wrapper's second check on the two admin-scope writes: exactly the params this module builds, nothing else.
 * Returns true for any method that is not a control write (the wrapper's own allowlist decides those).
 */
export function validateControlRpc(method, params) {
  if (!CONTROL_WRITE_RPC.includes(method)) return true;
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : null;
  if (!p || typeof p.id !== "string" || !JOB_ID.test(p.id)) return false;
  const keys = Object.keys(p).sort().join(",");
  if (method === "cron.run") return keys === "id,mode" && p.mode === "force";
  const patch = p.patch;
  return keys === "id,patch" && !!patch && typeof patch === "object" && !Array.isArray(patch)
    && Object.keys(patch).join(",") === "enabled" && typeof patch.enabled === "boolean";
}

// ---- B5: automations ----
export function mapSchedule(s) {
  if (s?.kind === "cron" && typeof s.expr === "string") return { kind: "cron", expr: cleanText(s.expr, 100), tz: cleanText(s.tz, 64) };
  if (s?.kind === "every") return { kind: "every", everyMs: int(s.everyMs) };
  if (s?.kind === "at") return { kind: "at", at: cleanText(s.at, 64) };
  // event / on-exit / stream schedules carry commands and working directories: shown as a kind only
  return { kind: "other" };
}

export function mapJob(j) {
  if (!j || typeof j.id !== "string" || !JOB_ID.test(j.id)) return null;
  const st = j.state && typeof j.state === "object" ? j.state : {};
  const system = typeof j.declarationKey === "string" && j.declarationKey.length > 0;
  const p = j.payload;
  const lastAt = num(st.lastRunAtMs) ?? num(j.lastRunAtMs);
  return {
    id: j.id,
    name: cleanText(j.displayName, 120) ?? cleanText(j.name, 120) ?? j.id,
    enabled: j.enabled === true,
    system, // managed by the engine or a plugin (e.g. memory "dreaming"): view only
    kind: p?.kind === "agentTurn" ? "agent" : p?.kind === "systemEvent" ? "event" : p?.kind === "command" ? "command" : "other",
    // the owner's own instruction (agent turns only; command payloads and managed prompts are never shown)
    prompt: !system && p?.kind === "agentTurn" ? cleanText(p.message, 300) : null,
    schedule: mapSchedule(j.schedule),
    nextRunAt: num(st.nextRunAtMs) ?? num(j.nextRunAtMs),
    running: num(st.runningAtMs) != null,
    last: lastAt == null ? null : {
      at: lastAt, status: oneOf(st.lastRunStatus ?? j.lastRunStatus, RUN_STATUS), durationMs: int(st.lastDurationMs),
      delivery: oneOf(st.lastDeliveryStatus ?? j.lastDeliveryStatus, DELIVERY), error: cleanText(st.lastError, 200),
    },
    consecutiveErrors: int(st.consecutiveErrors) ?? 0,
    autoDisabled: !!st.autoDisabled,
  };
}

const QUIET = /^\s*NO_REPLY\b/;
export function mapRun(e) {
  if (!e || typeof e !== "object" || (e.action != null && e.action !== "finished")) return null;
  const at = num(e.runAtMs) ?? num(e.ts);
  if (at == null) return null;
  const quiet = typeof e.summary === "string" && QUIET.test(e.summary);
  return {
    at, status: oneOf(e.status, RUN_STATUS), completion: oneOf(e.completionStatus, COMPLETION), durationMs: int(e.durationMs),
    quiet, // the agent ran and had nothing to report ("NO_REPLY")
    summary: quiet ? null : cleanText(e.summary, 500, { multiline: true }),
    error: cleanText(e.error, 200),
    delivery: oneOf(e.deliveryStatus, DELIVERY),
  };
}

// ---- B5: usage ----
const tokensOf = (u) => num(u?.totalTokens) ?? ((num(u?.input) ?? 0) + (num(u?.output) ?? 0));
function costOf(u) {
  const missing = int(u?.missingCostEntries) ?? 0;
  const c = num(u?.totalCost);
  // a model without pricing reports 0: then the cost is unknown, never "free"
  return { cost: c != null && !(c === 0 && missing > 0) ? c : null, costPartial: missing > 0 };
}
const dayRow = (d) => (typeof d?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date)
  ? { date: d.date, tokens: tokensOf(d), ...costOf(d) } : null);

export function mapUsage(sessionsUsage, usageCost, appKey, todayDate) {
  const out = { app: null, all: null, missingCostModels: [] };
  const missing = new Set();
  const noteMissing = (u) => { for (const k of Object.keys(u?.missingCostByModel ?? {})) if (NAME.test(k.replace(/\//g, "_"))) missing.add(k.slice(0, 100)); };
  if (sessionsUsage && Array.isArray(sessionsUsage.sessions)) {
    const row = sessionsUsage.sessions.find((s) => s?.key === appKey);
    const u = row?.usage ?? null;
    const today = typeof sessionsUsage.endDate === "string" ? sessionsUsage.endDate : todayDate;
    const days = (Array.isArray(u?.dailyBreakdown) ? u.dailyBreakdown : []).map(dayRow).filter(Boolean);
    out.app = { range: "30d", tokens: u ? tokensOf(u) : 0, input: num(u?.input) ?? 0, output: num(u?.output) ?? 0, ...(u ? costOf(u) : { cost: 0, costPartial: false }),
      today: days.find((d) => d.date === today) ?? { date: today, tokens: 0, cost: 0, costPartial: false } };
    if (u) noteMissing(u);
  }
  if (usageCost && typeof usageCost === "object" && usageCost.totals) {
    const days = (Array.isArray(usageCost.daily) ? usageCost.daily : []).map(dayRow).filter(Boolean).slice(-31);
    out.all = { days: int(usageCost.days) ?? days.length, tokens: tokensOf(usageCost.totals), ...costOf(usageCost.totals),
      today: days.find((d) => d.date === todayDate) ?? (days.at(-1)?.date === todayDate ? days.at(-1) : { date: todayDate, tokens: 0, cost: 0, costPartial: false }),
      daily: days };
    noteMissing(usageCost.totals);
  }
  out.missingCostModels = [...missing].slice(0, 5);
  return out;
}

// ---- B6: memory ----
export function mapMemoryStatus(s, files) {
  const legacy = s?.details?.legacy ?? {};
  const counts = Array.isArray(legacy.sourceCounts) ? legacy.sourceCounts : [];
  const mem = counts.find((c) => c?.source === "memory");
  const identity = legacy.custom?.indexIdentity;
  const stale = s?.status === "degraded" && identity?.status === "mismatched";
  const lastIndexedAt = num(legacy.lastIndexedAtMs) ?? num(legacy.indexedAtMs) ?? num(legacy.lastSyncAtMs) ?? num(s?.lastIndexedAtMs);
  return {
    state: s == null ? "unavailable" : stale ? "stale" : s.status === "ready" || s.status === "ok" ? "ok" : (oneOf(s.status, ["degraded", "disabled", "unavailable"]) ?? "unknown"),
    reason: stale ? (oneOf(identity?.code, ["model", "provider", "dimensions", "chunking"]) ?? "index") : null,
    searchMode: legacy.provider === "none" ? "fts-only" : cleanText(legacy.custom?.searchMode, 20),
    files: int(mem?.files) ?? int(legacy.files),
    chunks: int(mem?.chunks) ?? int(legacy.chunks),
    dirty: legacy.dirty === true,
    lastIndexedAt,
    bootstrap: (Array.isArray(files?.files) ? files.files : []).filter((f) => MEMORY_FILES.includes(f?.name))
      .map((f) => ({ name: f.name, exists: f.missing !== true, size: int(f.size), updatedAt: num(f.updatedAtMs) })),
  };
}

const MEMORY_PATH = /^(?:[\w.-]+\/){0,4}[\w.-]+\.md$/;
/** One memory.search hit. `reference` stays in the bridge (the router swaps it for an opaque `ref`). The engine returns a
 * workspace-relative path; memory.get takes it as a provider-scoped reference and re-checks it is an allowed memory file. */
export function mapHit(h, providerId = "memory-core") {
  if (!h || typeof h !== "object" || (h.source != null && h.source !== "memory")) return null;
  const path = typeof h.path === "string" && MEMORY_PATH.test(h.path) && !h.path.split("/").includes("..") ? h.path : null;
  const ref = h.reference && typeof h.reference === "object" && typeof h.reference.id === "string" ? { providerId: String(h.reference.providerId ?? providerId), id: h.reference.id }
    : path ? { providerId, id: path } : null;
  const file = baseName(path ?? ref?.id);
  const snippet = cleanText(h.snippet ?? h.text, 500, { multiline: true });
  if (!snippet || !file) return null;
  const lines = Number.isInteger(h.startLine) ? { from: h.startLine, to: int(h.endLine) } : null;
  return { file, snippet, score: num(h.score), lines, date: /^\d{4}-\d{2}-\d{2}/.exec(file)?.[0] ?? null, reference: ref };
}

/** Whole memory text for display: the same path / secret-shaped-token redaction as cleanText, with layout kept (no trimming,
 * no collapsing, newlines and tabs kept; other control characters removed). */
export function redactText(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(PATHISH, "…").replace(SECRETISH, "…");
}

/** Text paging: PART_CHARS per part, at most MAX_PARTS. The text is redacted (redactText) before it is paged. */
export function textPart(text, part) {
  const t = redactText(text);
  const parts = Math.max(1, Math.min(MAX_PARTS, Math.ceil(t.length / PART_CHARS)));
  const p = Math.min(Math.max(part, 0), parts - 1);
  return { text: t.slice(p * PART_CHARS, (p + 1) * PART_CHARS), part: p, parts, chars: t.length, truncated: t.length > MAX_PARTS * PART_CHARS };
}

// ---- B7: capabilities ----
export function mapChannels(c) {
  if (!c || typeof c !== "object") return null;
  const order = Array.isArray(c.channelOrder) ? c.channelOrder : Object.keys(c.channelAccounts ?? {});
  const issues = Array.isArray(c.statusIssues) ? c.statusIssues : [];
  return order.filter((id) => typeof id === "string" && /^[a-z0-9][a-z0-9._-]{0,40}$/.test(id)).slice(0, 20).map((id) => {
    const accts = Array.isArray(c.channelAccounts?.[id]) ? c.channelAccounts[id] : [];
    const any = (k) => accts.some((a) => a?.[k] === true);
    const issue = issues.find((i) => i?.channel === id);
    const lastConnectedAt = accts.map((a) => num(a?.lastConnectedAt)).filter((x) => x != null).sort((a, b) => b - a)[0] ?? null;
    // no account ids, names, numbers, tokens or paths: those are in the raw snapshot, not here
    return { id, label: cleanText(c.channelLabels?.[id], 40) ?? id, accounts: accts.length, configured: any("configured"), linked: any("linked"),
      running: any("running"), connected: any("connected"), lastConnectedAt, issue: issue ? oneOf(issue.kind, ["intent", "permissions", "config", "auth", "runtime"]) : null };
  });
}

export function mapSkill(s) {
  const name = cleanText(s?.name, 80);
  if (!name) return null;
  const m = s.missing && typeof s.missing === "object" ? s.missing : {};
  const state = s.disabled === true ? "disabled" : s.blockedByAllowlist === true || s.blockedByAgentFilter === true ? "blocked"
    : s.platformIncompatible === true ? "platform" : s.eligible === true ? "ready" : "missing";
  return {
    name, emoji: cleanText(s.emoji, 8), description: cleanText(s.description, 160), state,
    // what is missing, by kind: tool (binary) and environment-variable NAMES only, config keys as a count; never values or paths
    missing: state === "missing" ? { bins: [...names(m.bins), ...names(m.anyBins)].slice(0, 4), env: names(m.env), config: Array.isArray(m.config) ? m.config.length : 0,
      os: Array.isArray(m.os) && m.os.length > 0 } : null,
  };
}

export function mapTools(effective, catalog) {
  if (!effective || !Array.isArray(effective.groups)) return null;
  const groupOf = new Map();
  for (const g of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    for (const t of Array.isArray(g?.tools) ? g.tools : []) if (typeof t?.id === "string") groupOf.set(t.id, { id: String(g.id), label: cleanText(g.label, 60) });
  }
  const groups = new Map();
  for (const g of effective.groups) {
    for (const t of Array.isArray(g?.tools) ? g.tools : []) {
      if (typeof t?.id !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(t.id)) continue;
      const cg = groupOf.get(t.id) ?? (t.source === "plugin" && typeof t.pluginId === "string" ? { id: `plugin:${t.pluginId}`, label: t.pluginId } : { id: "other", label: null });
      const gid = /^[a-z0-9:_.-]{1,80}$/i.test(cg.id) ? cg.id : "other";
      if (!groups.has(gid)) groups.set(gid, { id: gid, label: cleanText(cg.label, 60), plugin: gid.startsWith("plugin:"), tools: [] });
      groups.get(gid).tools.push({ id: t.id, label: cleanText(t.label, 60) ?? t.id });
    }
  }
  return { profile: cleanText(effective.profile, 30), count: [...groups.values()].reduce((n, g) => n + g.tools.length, 0), groups: [...groups.values()] };
}

export function mapPlugins(p) {
  if (!p || !Array.isArray(p.plugins)) return null;
  const row = (x) => ({ id: cleanText(x.id, 60), name: cleanText(x.name, 60) ?? cleanText(x.id, 60) });
  const rows = p.plugins.filter((x) => typeof x?.id === "string");
  return {
    enabled: rows.filter((x) => x.enabled === true && x.state !== "error" && x.state !== "failed").map(row).slice(0, 150),
    needsSetup: rows.filter((x) => x.state === "needs-setup").map(row).slice(0, 50),
    failed: rows.filter((x) => x.state === "error" || x.state === "failed").map(row).slice(0, 50),
    total: rows.length,
  };
}

/**
 * @param {{ gatewayCall?: (method: string, params: object) => Promise<any>, appSessionKey: string, now?: () => number, log?: any }} opts
 * @returns {import("express").Router}
 */
export function createAppControl({ gatewayCall, appSessionKey, now = Date.now, log }) {
  const router = express.Router();

  // at most MAX_CONCURRENT engine calls from this module at once (each one is a CLI process)
  let active = 0;
  const waiting = [];
  const call = async (method, params) => {
    while (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
    active++;
    try { return await gatewayCall(method, params); } finally { active--; waiting.shift()?.(); }
  };

  const cache = new Map(); // key -> { at, value } | { pending }
  const cached = (key, ttl, fn) => {
    const hit = cache.get(key);
    if (hit?.value !== undefined && now() - hit.at < ttl) return Promise.resolve({ value: hit.value, at: hit.at, cached: true });
    if (hit?.pending) return hit.pending;
    const pending = (async () => {
      try {
        const value = await fn();
        cache.set(key, { at: now(), value });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return { value, at: now(), cached: false };
      } catch (err) { cache.delete(key); throw err; }
    })();
    cache.set(key, { ...(hit?.value !== undefined ? hit : {}), pending });
    return pending;
  };
  const forget = (prefix) => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); };

  const notAvailable = (res) => {
    if (gatewayCall) return false;
    res.status(503).json({ ok: false, error: "not_available" });
    return true;
  };
  const fail = (res, err, what) => {
    log?.warn?.("app-control", `${what}: ${err?.message ?? err}`);
    res.status(502).json({ ok: false, error: "engine_unavailable" });
  };
  const bad = (res, error) => res.status(400).json({ ok: false, error });
  const partOf = (q) => { const n = Number.parseInt(String(q ?? "0"), 10); return Number.isInteger(n) && n >= 0 && n < MAX_PARTS ? n : null; };

  // ---- automations ----
  const jobs = () => cached("jobs", TTL.jobs, async () => {
    const r = await call("cron.list", { includeDisabled: true, limit: MAX_JOBS, sortBy: "nextRunAtMs", sortDir: "asc" });
    if (!Array.isArray(r?.jobs)) throw new Error("cron.list: no jobs array");
    return { jobs: r.jobs.map(mapJob).filter(Boolean), truncated: r.hasMore === true };
  });
  const findJob = async (id) => (await jobs()).value.jobs.find((j) => j.id === id) ?? null;

  router.get("/automations", async (_req, res) => {
    if (notAvailable(res)) return;
    try {
      const { value, at, cached: c } = await jobs();
      res.json({ ok: true, jobs: value.jobs, truncated: value.truncated, fetchedAt: at, cached: c });
    } catch (err) { fail(res, err, "automations"); }
  });

  router.get("/automations/:id/runs", async (req, res) => {
    if (notAvailable(res)) return;
    const id = req.params.id;
    if (!JOB_ID.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), MAX_RUNS);
    try {
      if (!(await findJob(id))) return res.status(404).json({ ok: false, error: "not_found" }); // only jobs the engine listed
      const { value, at } = await cached(`runs:${id}:${limit}`, TTL.runs, async () => {
        const r = await call("cron.runs", { scope: "job", id, limit, sortDir: "desc" });
        return { runs: (Array.isArray(r?.entries) ? r.entries : []).filter((e) => e?.jobId == null || e.jobId === id).map(mapRun).filter(Boolean), hasMore: r?.hasMore === true };
      });
      res.json({ ok: true, id, runs: value.runs, hasMore: value.hasMore, fetchedAt: at });
    } catch (err) { fail(res, err, "automation runs"); }
  });

  // the two writes run one at a time (two devices pressing together never interleave)
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  const writable = async (res, id) => {
    if (!JOB_ID.test(id)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
    forget("jobs"); // decide on fresh engine state, not a 20-second-old list
    const job = await findJob(id);
    if (!job) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
    if (job.system) { bad(res, "system_job"); return null; }
    return job;
  };

  router.post("/automations/:id/run", (req, res) => serial(async () => {
    if (notAvailable(res)) return;
    try {
      const job = await writable(res, req.params.id);
      if (!job) return;
      if (job.running) return res.status(409).json({ ok: false, error: "busy" });
      const r = await call("cron.run", { id: job.id, mode: "force" });
      forget("jobs"); forget(`runs:${job.id}:`);
      res.json({ ok: true, id: job.id, enqueued: r?.enqueued === true || r?.ran === true || r?.ok === true });
    } catch (err) { if (err?.refused) return bad(res, "rejected"); fail(res, err, "automation run"); }
  }));

  router.post("/automations/:id/enabled", (req, res) => serial(async () => {
    if (notAvailable(res)) return;
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") return bad(res, "bad_request");
    try {
      const job = await writable(res, req.params.id);
      if (!job) return;
      if (job.enabled !== enabled) await call("cron.update", { id: job.id, patch: { enabled } });
      forget("jobs");
      const after = await findJob(job.id); // report the engine's state, never the requested one
      res.json({ ok: true, id: job.id, enabled: after ? after.enabled : null });
    } catch (err) { if (err?.refused) return bad(res, "rejected"); fail(res, err, "automation enable"); }
  }));

  // ---- usage ----
  router.get("/usage", async (_req, res) => {
    if (notAvailable(res)) return;
    try {
      const { value, at, cached: c } = await cached("usage", TTL.usage, async () => {
        const [s, u] = await Promise.allSettled([call("sessions.usage", { key: appSessionKey, range: "30d" }), call("usage.cost", {})]);
        if (s.status === "rejected" && u.status === "rejected") throw s.reason;
        return mapUsage(s.status === "fulfilled" ? s.value : null, u.status === "fulfilled" ? u.value : null, appSessionKey, new Date(now()).toISOString().slice(0, 10));
      });
      res.json({ ok: true, ...value, fetchedAt: at, cached: c });
    } catch (err) { fail(res, err, "usage"); }
  });

  // ---- memory (read-only) ----
  const refs = new Map(); // opaque token -> { reference, file, at }: memory.get only ever receives a reference memory.search returned
  const issueRef = (reference, file) => {
    const token = crypto.randomBytes(12).toString("hex");
    refs.set(token, { reference, file, at: now() });
    while (refs.size > REFS_KEPT) refs.delete(refs.keys().next().value);
    return token;
  };

  router.get("/memory/status", async (_req, res) => {
    if (notAvailable(res)) return;
    try {
      const { value, at } = await cached("memory:status", TTL.memoryStatus, async () => {
        const [s, f] = await Promise.allSettled([call("memory.status", { agentId: AGENT }), call("agents.files.list", { agentId: AGENT })]);
        if (s.status === "rejected" && f.status === "rejected") throw s.reason;
        return mapMemoryStatus(s.status === "fulfilled" ? s.value : null, f.status === "fulfilled" ? f.value : null);
      });
      res.json({ ok: true, ...value, fetchedAt: at });
    } catch (err) { fail(res, err, "memory status"); }
  });

  router.get("/memory/search", async (req, res) => {
    if (notAvailable(res)) return;
    const q = typeof req.query.q === "string" ? req.query.q.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    const page = Number.parseInt(String(req.query.page ?? "0"), 10);
    if (!q || q.length > MAX_QUERY || !Number.isInteger(page) || page < 0 || page >= SEARCH_PAGES) return bad(res, "bad_request");
    try {
      const { value } = await cached(`search:${q}:${page}`, TTL.search, async () => {
        // memory files only: session transcripts can hold other people's (group) messages
        const r = await call("memory.search", { query: q, agentId: AGENT, maxResults: (page + 1) * SEARCH_PAGE, sources: ["memory"] });
        const all = (Array.isArray(r?.results) ? r.results : []).map((h) => mapHit(h)).filter(Boolean);
        return { hits: all.slice(page * SEARCH_PAGE, (page + 1) * SEARCH_PAGE), more: all.length >= (page + 1) * SEARCH_PAGE && page + 1 < SEARCH_PAGES,
          stale: r?.stale === true, mode: cleanText(r?.searchMode, 20) };
      });
      // a fresh opaque ref per response; the engine reference itself never leaves the bridge
      const results = value.hits.map(({ reference, ...h }) => ({ ...h, ref: reference ? issueRef(reference, h.file) : null }));
      res.json({ ok: true, query: q, page, results, more: value.more, stale: value.stale, mode: value.mode });
    } catch (err) { if (err?.refused) return bad(res, "rejected"); fail(res, err, "memory search"); }
  });

  router.get("/memory/item", async (req, res) => {
    if (notAvailable(res)) return;
    const token = typeof req.query.ref === "string" ? req.query.ref : "";
    const part = partOf(req.query.part);
    const entry = /^[0-9a-f]{24}$/.test(token) ? refs.get(token) : null;
    if (part == null) return bad(res, "bad_request");
    if (!entry || now() - entry.at > REF_TTL_MS) return res.status(404).json({ ok: false, error: "not_found" });
    try {
      const { value } = await cached(`item:${token}`, TTL.file, async () => {
        const r = await call("memory.get", { reference: entry.reference });
        return typeof r?.text === "string" ? r.text : typeof r?.content === "string" ? r.content : typeof r?.item?.text === "string" ? r.item.text : "";
      });
      res.json({ ok: true, file: entry.file, ...textPart(value, part) });
    } catch (err) { if (err?.refused) return res.status(404).json({ ok: false, error: "not_found" }); fail(res, err, "memory item"); }
  });

  router.get("/memory/file", async (req, res) => {
    if (notAvailable(res)) return;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    const part = partOf(req.query.part);
    if (!MEMORY_FILES.includes(name) || part == null) return bad(res, "bad_request");
    try {
      const { value } = await cached(`file:${name}`, TTL.file, async () => {
        const r = await call("agents.files.get", { agentId: AGENT, name });
        const f = r?.file && typeof r.file === "object" ? r.file : r;
        return { exists: f?.missing !== true && typeof f?.content === "string", content: typeof f?.content === "string" ? f.content : "", updatedAt: num(f?.updatedAtMs) };
      });
      res.json({ ok: true, name, exists: value.exists, updatedAt: value.updatedAt, ...textPart(value.content, part) });
    } catch (err) { if (err?.refused) return res.status(404).json({ ok: false, error: "not_found" }); fail(res, err, "memory file"); }
  });

  // ---- capabilities (read-only) ----
  router.get("/capabilities", async (_req, res) => {
    if (notAvailable(res)) return;
    try {
      const { value, at, cached: c } = await cached("caps", TTL.caps, async () => {
        const catalog = cached("catalog", TTL.catalog, () => call("tools.catalog", { agentId: AGENT, includePlugins: true })).then((x) => x.value);
        const [ch, sk, te, tc, pl] = await Promise.allSettled([
          call("channels.status", { probe: false }), call("skills.status", { agentId: AGENT }),
          call("tools.effective", { agentId: AGENT, sessionKey: appSessionKey }), catalog, call("plugins.list", {}),
        ]);
        const v = (r) => (r.status === "fulfilled" ? r.value : null);
        if ([ch, sk, te, pl].every((r) => r.status === "rejected")) throw ch.reason;
        const skills = Array.isArray(v(sk)?.skills) ? v(sk).skills.map(mapSkill).filter(Boolean) : null;
        return {
          channels: mapChannels(v(ch)),
          skills: skills && { ready: skills.filter((s) => s.state === "ready"), missing: skills.filter((s) => s.state === "missing"),
            unavailable: skills.filter((s) => s.state !== "ready" && s.state !== "missing").map(({ name, emoji, state }) => ({ name, emoji, state })), total: skills.length },
          tools: mapTools(v(te), v(tc)),
          plugins: mapPlugins(v(pl)),
        };
      });
      res.json({ ok: true, ...value, fetchedAt: at, cached: c });
    } catch (err) { fail(res, err, "capabilities"); }
  });

  return router;
}
