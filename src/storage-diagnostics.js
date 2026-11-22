// Read-only storage diagnostics for the persistent volume (opt-in: DIAG_STORAGE=1).
//
// What it does: walks the volume with readdir/lstat ONLY and logs two compact JSON lines (sizes, counts, ages).
// What it never does: read file contents, follow symlinks, cross filesystems, delete/move/write anything, or print
// file names that could identify people, sessions or secrets. Memory, sessions, WhatsApp/auth data, credentials,
// databases and identity files are summed into one anonymous "<protected>" bucket and are never cleanup candidates.
// Cleanup candidates are *measured and reported only* -- there is deliberately no delete code in this module.
// OpenClaw recovery artifacts (doctor snapshots/migration backups, tmp/plugin-captures) are measured in their own
// "recovery" bucket and are never candidates: they hold copies of sessions/config/plugins and are owned by OpenClaw.
import fsp from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULTS = Object.freeze({
  intervalHours: 6,
  firstDelayMs: 90_000,
  maxEntries: 300_000,
  maxMs: 25_000,
  minAgeDays: 7,
  activeHours: 24,
  topN: 12,
  dupeMinBytes: MB,
  warnPct: 85,
  critPct: 95,
  recoverPct: 80,
  reminderHours: 24,
});

// Anything matching is "protected": sized in aggregate, never named, never a candidate.
const PROTECTED_NAMES = [
  /^memor(y|ies)([-_.].*)?$/i,
  /^sessions?$/i,
  /^agents?$/i,
  /^(whatsapp|baileys|credentials?|creds?|auth|authorization|secrets?|tokens?|identity|devices|pairing|cron|config|state|databases?|db|keys?)$/i,
  /^(whatsapp|baileys|creds?|auth|secret|token|credential)[-_.]/i,
  /^(soul|identity|user|agents|tools|heartbeat|bootstrap)\.md$/i,
  /^openclaw\.json/i,
  /^\.env/i,
  // backups: BASHT encrypted backups and any backup directory are never candidates
  /^backups?$/i,
  /^basht-backup/i,
  /\.bkp$/i,
  // OpenClaw private Doctor capture root <stateDir>.update-captures/: a full pre-repair copy of state (incl. credentials)
  /\.update-captures$/i,
  /\.(db|sqlite3?|db-wal|db-shm|sqlite-wal|sqlite-shm|key|pem|p12|pfx|jsonl|token)$/i,
];
// Files that are (or may be) in active use.
const ACTIVE_NAMES = /\.(lock|pid|sock|wal|shm)$|-journal$/i;

const TMP_FILE = /\.(tmp|temp|part|partial|download|crdownload|swp)$|~$/i;
const BACKUP_FILE = /\.(bak|old|orig|rej|backup)$|\.(bak|backup)\.[^.]+$/i;
const LOG_FILE = /\.log(\.\d+)?(\.gz)?$/i;
const CACHE_DIR = /^(tmp|temp|cache|\.cache|_cacache|\.npm|\.pnpm-store|code cache|gpucache|shadercache|crashpad)$/i;

// Backup/temp variants of a protected name stay protected (customers.sqlite.bak, IDENTITY.md.bak, creds.json.1 ...).
const VARIANT_SUFFIX = /(\.(bak|old|orig|rej|backup|tmp|temp|swp|part|partial)|~|\.\d+)$/i;

// OpenClaw doctor / state-migration artifacts (openclaw@2026.10.x): <f>.jsonl.pre-doctor-*-repair-<ts>.bak,
// AGENTS.md.doctor-backup-<ts>, TOOLS.md.doctor-importing-<ts>, .<f>.doctor-importing, <f>.doctor-scrub-*,
// <f>.quarantined-<ts>, <f>.migrated[-<ts>|.raw], <f>.pre-startup-migration-<ts>.bak, and the private Doctor capture
// root <stateDir>.update-captures/ (full pre-repair state copy, kept per container; older copies retired after 30 days).
// `openclaw doctor --fix` runs on every boot, so these accumulate; they are recovery copies of protected data,
// measured but never candidates.
const DOCTOR_SUFFIX =
  /\.(?:pre-doctor-|doctor-(?:backup|importing|scrub)|quarantined-|migrated(?=$|[-.])|pre-startup-migration-).*$|\.update-captures$/i;
// OpenClaw plugin source captures: <stateDir>/tmp/plugin-captures/<instance>/... (owner-leased, OpenClaw cleans them).
const PLUGIN_CAPTURES_DIR = /^plugin-captures$/i;

export function isDoctorSnapshotName(name) {
  return DOCTOR_SUFFIX.test(name);
}

export function isProtectedName(name) {
  let n = name;
  for (let i = 0; i < 6; i++) {
    if (PROTECTED_NAMES.some((re) => re.test(n))) return true;
    let stripped = n.replace(VARIANT_SUFFIX, "");
    if (stripped === n) stripped = n.replace(DOCTOR_SUFFIX, "").replace(/^\.(?=.)/, "");
    if (!stripped || stripped === n) break;
    n = stripped;
  }
  return false;
}

// Only plain, short, non-identifying names are ever printed.
export function isSafeName(name) {
  return (
    /^[A-Za-z0-9._-]{1,32}$/.test(name) && !/\d{7,}/.test(name) && !/[0-9a-f]{12,}/i.test(name)
  );
}

function label(parts) {
  const out = [];
  for (const p of parts) {
    if (isProtectedName(p)) {
      out.push("<protected>");
      break;
    }
    if (isDoctorSnapshotName(p)) {
      out.push("<doctor-snapshot>");
      break;
    }
    out.push(isSafeName(p) ? p : "<other>");
  }
  return "/" + out.join("/");
}

const round1 = (n) => Math.round(n * 10) / 10;
const toMB = (b) => round1(b / MB);

function emptyClass() {
  return { n: 0, bytes: 0 };
}

export async function scanTree(root, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now();
  const ops = o.fs ?? { readdir: fsp.readdir, lstat: fsp.lstat };
  const started = Date.now();
  const cpu0 = process.cpuUsage();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  try {
    return await walk(root, o, now, ops, started, cpu0, lag);
  } finally {
    lag.disable();
  }
}

async function walk(root, o, now, ops, started, cpu0, lag) {
  const rootStat = await ops.lstat(root);

  const res = {
    files: 0,
    bytes: 0,
    protectedBytes: 0,
    symlinksSkipped: 0,
    otherFsSkipped: 0,
    truncated: false,
    level1: new Map(),
    level2: new Map(),
    candidates: {
      tmp: emptyClass(),
      backup: emptyClass(),
      log: emptyClass(),
      cache: emptyClass(),
      exportsOld: emptyClass(),
    },
    activeExcluded: emptyClass(),
    recovery: { doctor: emptyClass(), pluginCaptures: emptyClass() },
    dupes: { n: 0, bytes: 0 },
  };
  const dupeMap = new Map();
  const bump = (map, key, bytes, mod) => {
    const e = map.get(key) ?? { bytes: 0, n: 0, mod: 0 };
    e.bytes += bytes;
    e.n += 1;
    if (mod) e.mod += bytes;
    map.set(key, e);
  };

  const stack = [{ abs: root, rel: [], prot: false, cache: false, exp: false, pcap: false, doc: false }];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await ops.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (++seen > o.maxEntries || (seen % 500 === 0 && Date.now() - started > o.maxMs)) {
        res.truncated = true;
        stack.length = 0;
        break;
      }
      if (seen % 500 === 0) await new Promise((r) => setImmediate(r));
      const name = ent.name;
      if (ent.isSymbolicLink()) {
        res.symlinksSkipped++;
        continue;
      }
      const abs = path.join(dir.abs, name);
      const protName = isProtectedName(name);
      if (ent.isDirectory()) {
        let st;
        try {
          st = await ops.lstat(abs);
        } catch {
          continue;
        }
        if (st.dev !== rootStat.dev) {
          res.otherFsSkipped++;
          continue;
        }
        stack.push({
          abs,
          rel: [...dir.rel, name],
          prot: dir.prot || protName,
          cache: dir.cache || CACHE_DIR.test(name),
          exp: dir.exp || name === "exports",
          pcap: dir.pcap || PLUGIN_CAPTURES_DIR.test(name),
          doc: dir.doc || isDoctorSnapshotName(name),
        });
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = await ops.lstat(abs);
      } catch {
        continue;
      }
      const bytes = typeof st.blocks === "number" ? st.blocks * 512 : st.size;
      const ageMs = now - st.mtimeMs;
      const mod = ageMs <= DAY_MS;
      const isProt = dir.prot || protName;
      res.files++;
      res.bytes += bytes;
      if (isProt) res.protectedBytes += bytes;

      const l1 = dir.rel.length === 0 ? "/(root-files)" : label([dir.rel[0]]);
      let l2 = null;
      if (dir.rel.length >= 2) l2 = label(dir.rel.slice(0, 2));
      else if (dir.rel.length === 1) l2 = protName ? `${label([dir.rel[0]])}/<protected>` : `${label([dir.rel[0]])}/(files)`;
      bump(res.level1, l1, bytes, mod);
      if (l2) bump(res.level2, l2, bytes, mod);

      // Recovery artifacts are counted wherever they live (also inside protected trees: anonymous totals only).
      const rec = dir.pcap ? "pluginCaptures" : dir.doc || isDoctorSnapshotName(name) ? "doctor" : null;
      if (rec) {
        res.recovery[rec].n++;
        res.recovery[rec].bytes += bytes;
      }
      if (isProt || rec) continue;

      // Candidate classification (unprotected trees only). Active/recent files are excluded and counted separately.
      const oldEnough = ageMs >= o.minAgeDays * DAY_MS;
      let cls = null;
      if (TMP_FILE.test(name)) cls = "tmp";
      else if (BACKUP_FILE.test(name)) cls = "backup";
      else if (LOG_FILE.test(name)) cls = "log";
      else if (dir.exp) cls = "exportsOld";
      else if (dir.cache) cls = "cache";
      if (cls) {
        if (ACTIVE_NAMES.test(name) || !oldEnough) {
          res.activeExcluded.n++;
          res.activeExcluded.bytes += bytes;
        } else {
          res.candidates[cls].n++;
          res.candidates[cls].bytes += bytes;
        }
        continue;
      }
      if (st.size >= o.dupeMinBytes && !ACTIVE_NAMES.test(name) && dupeMap.size < 100_000) {
        const key = `${st.size}:${name}`;
        const e = dupeMap.get(key) ?? { count: 0, size: st.size };
        e.count++;
        dupeMap.set(key, e);
      }
    }
  }
  for (const e of dupeMap.values()) {
    if (e.count > 1) {
      res.dupes.n += e.count - 1;
      res.dupes.bytes += e.size * (e.count - 1);
    }
  }
  res.scanMs = Date.now() - started;
  const cpu = process.cpuUsage(cpu0);
  res.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  res.lagMaxMs = round1(lag.max / 1e6);
  res.rssMB = toMB(process.memoryUsage.rss());
  return res;
}

export function nextAlertState(prev, usedPct, nowMs, cfg = DEFAULTS) {
  const state = { level: prev?.level ?? "ok", lastEmit: prev?.lastEmit ?? 0 };
  let level = state.level;
  if (usedPct >= cfg.critPct) level = "crit";
  else if (usedPct >= cfg.warnPct) level = level === "crit" ? "crit" : "warn";
  else if (usedPct < cfg.recoverPct) level = "ok";
  // between recoverPct and warnPct: keep the previous level (hysteresis)
  let emit = null;
  const rose = (level === "warn" && state.level === "ok") || (level === "crit" && state.level !== "crit");
  if (rose) emit = level;
  else if (level !== "ok" && nowMs - state.lastEmit >= cfg.reminderHours * 3600_000) emit = "reminder";
  else if (level === "ok" && state.level !== "ok") emit = "recovered";
  if (emit) state.lastEmit = nowMs;
  state.level = level;
  return { state, emit };
}

export function buildLines(report, fsInfo, level, cfg = DEFAULTS, nowIso = new Date().toISOString()) {
  const c = report.candidates;
  const cls = (e) => ({ n: e.n, mb: toMB(e.bytes) });
  const summary = {
    v: 1,
    ts: nowIso,
    level,
    fs: fsInfo
      ? {
          totalGB: round1(fsInfo.total / GB),
          usedGB: round1(fsInfo.used / GB),
          freeGB: round1(fsInfo.free / GB),
          usedPct: round1(fsInfo.pct),
        }
      : null,
    scan: {
      files: report.files,
      mb: toMB(report.bytes),
      ms: report.scanMs,
      cpuMs: report.cpuMs ?? null,
      lagMaxMs: report.lagMaxMs ?? null,
      rssMB: report.rssMB ?? null,
      truncated: report.truncated,
      symlinksSkipped: report.symlinksSkipped,
      otherFsSkipped: report.otherFsSkipped,
    },
    protectedMB: toMB(report.protectedBytes),
    candidates: {
      tmp: cls(c.tmp),
      backup: cls(c.backup),
      log: cls(c.log),
      cache: cls(c.cache),
      exportsOld: cls(c.exportsOld),
    },
    // Never candidates. May overlap protectedMB (doctor snapshots of session files live under protected trees).
    recovery: { doctor: cls(report.recovery.doctor), pluginCaptures: cls(report.recovery.pluginCaptures) },
    possibleDupes: { n: report.dupes.n, mb: toMB(report.dupes.bytes) },
    activeExcluded: cls(report.activeExcluded),
  };
  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, n)
      .map(([p, e]) => ({ p, mb: toMB(e.bytes), n: e.n, m24: toMB(e.mod) }));
  const detail = { v: 1, ts: nowIso, dirs: top(report.level1, 10), sub: top(report.level2, cfg.topN) };
  let d = JSON.stringify(detail);
  while (d.length > 3500 && detail.sub.length > 1) {
    detail.sub.pop();
    d = JSON.stringify(detail);
  }
  return [JSON.stringify(summary), d];
}

export async function getFsInfo(root, statfs = fsp.statfs) {
  try {
    const s = await statfs(root);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    const used = total - Number(s.bfree) * Number(s.bsize);
    return { total, free, used, pct: total > 0 ? (used / total) * 100 : 0 };
  } catch {
    return null;
  }
}

export function startStorageDiagnostics({
  log,
  env = process.env,
  fsImpl,
  statfs,
  now = Date.now,
  setTimeoutFn = setTimeout,
} = {}) {
  if (env.DIAG_STORAGE !== "1") return null;
  const root = (env.DIAG_STORAGE_ROOT || "/data").trim();
  const hours = Math.min(168, Math.max(1, Number(env.DIAG_STORAGE_INTERVAL_HOURS) || DEFAULTS.intervalHours));
  let alert = { level: "ok", lastEmit: 0 };
  let running = false;
  let stopped = false;
  let timer = null;

  async function runOnce() {
    if (running) return null;
    running = true;
    try {
      const fsInfo = await getFsInfo(root, statfs);
      const report = await scanTree(root, { fs: fsImpl, now: now() });
      // Without a usage measurement there is no evidence either way: keep the previous alert state, emit nothing.
      const pct = fsInfo ? fsInfo.pct : null;
      const { state, emit } = pct === null ? { state: alert, emit: null } : nextAlertState(alert, pct, now());
      alert = state;
      const [summary, detail] = buildLines(report, fsInfo, state.level);
      log.info("storage-diag", summary);
      log.info("storage-diag", detail);
      if (emit) {
        const msg =
          emit === "recovered"
            ? `volume usage back below ${DEFAULTS.recoverPct}% (${round1(pct)}%)`
            : `volume usage ${round1(pct)}% (${state.level}); thresholds ${DEFAULTS.warnPct}/${DEFAULTS.critPct}%`;
        (emit === "recovered" ? log.info : log.warn)("storage-diag", msg);
      }
      return { summary, detail, emit };
    } catch (err) {
      // error code only: messages can carry paths
      log.warn("storage-diag", `scan failed: ${/^E[A-Z]+$/.test(err?.code ?? "") ? err.code : "error"}`);
      return null;
    } finally {
      running = false;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    timer = setTimeoutFn(async () => {
      await runOnce();
      schedule(hours * 3600_000);
    }, delayMs);
    timer?.unref?.();
  }
  // Keep the production 90-second default. A bounded opt-in delay allows slower
  // integration environments to capture a baseline before their first scan.
  const requestedDelay = Number(env.DIAG_STORAGE_FIRST_DELAY_MS);
  const initialDelayMs = Number.isFinite(requestedDelay) && requestedDelay >= DEFAULTS.firstDelayMs
    ? Math.min(requestedDelay, 900_000)
    : DEFAULTS.firstDelayMs;
  schedule(initialDelayMs);
  log.info("storage-diag", `enabled root=${root} every ${hours}h (read-only: readdir/lstat/statfs)`);
  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
