# Storage diagnostics (read-only)

Purpose: find out what fills the persistent volume (`/data`, 5 GB on the Hobby plan) without shell access and without
exposing contents. Implemented in `src/storage-diagnostics.js`; **off unless `DIAG_STORAGE=1`**.

## What it logs

Two JSON lines tagged `[storage-diag]` at boot+90 s (`DIAG_STORAGE_FIRST_DELAY_SEC`, integer 5..3600, default 90) and then every `DIAG_STORAGE_INTERVAL_HOURS` (default 6):

1. **summary** — `fs` (statfs total/used/free/usedPct), `scan` stats (incl. `cpuMs`, `lagMaxMs`, `rssMB` of the scan
   itself), `protectedMB`, measured cleanup `candidates` (`tmp`, `backup`, `log`, `cache`, `exportsOld`), `recovery`
   (`doctor`, `pluginCaptures` — see below, **never candidates**), `possibleDupes` (same name **and** size, contents
   never compared) and `activeExcluded`.
2. **detail** — top folders at depth 1 and 2 with size, file count and the part modified in the last 24 h (`m24`, the
   growth driver).

Read them with Railway logs (filter `storage-diag`). Log volume: 2 lines (~0.5 KB + ≤ 3.5 KB) per interval, i.e.
8 lines/day at the default 6 h, plus at most one alert line per level change and one reminder per 24 h.

## Recovery artifacts (`recovery`) — measured, never cleanup candidates

The wrapper runs `openclaw doctor --fix` on every boot, and OpenClaw keeps recovery copies of the data it repairs or
migrates. They are copies of sessions, config, auth profiles, audit logs and plugins, are owned by OpenClaw, and are
reported in their own bucket so their growth is visible without ever suggesting their removal:

| Bucket | Matches (openclaw@2026.10.9) | Notes |
|---|---|---|
| `recovery.doctor` | the private Doctor capture root `<stateDir>.update-captures/` (on Railway `/data/.openclaw.update-captures/`: a **full pre-repair copy of state, credentials included**, kept per container; OpenClaw retires other copies after 30 days); `*.pre-doctor-*` (e.g. `<session>.jsonl.pre-doctor-branch-repair-<ts>.bak`), `*.doctor-backup-*`, `*.doctor-importing*`, `*.doctor-scrub-*`, `*.quarantined-*`, `*.migrated`, `*.migrated-*`, `*.migrated.*`, `*.pre-startup-migration-*`; whole directories with these suffixes | counted inside and outside protected trees; `.update-captures` is also protected (shown only as `<protected>`); a doctor copy of a protected file stays `<protected>` |
| `recovery.pluginCaptures` | everything under a `plugin-captures/` directory (default `<stateDir>/tmp/plugin-captures/<instance>/…`) | lease-owned by OpenClaw (`owner.sqlite`) and reclaimed by it; previously this fell under the `tmp` cache rule — now excluded from `cache` |

`recovery` can overlap `protectedMB` (both are anonymous totals). Names of these files are never printed; a directory
with a doctor suffix is labelled `<doctor-snapshot>` (or `<protected>` when the original name is protected).

## Safety rules (enforced by tests)

- `readdir`/`lstat`/`statfs` only: no reading of file contents, no writes, no deletes, no child processes, no network.
- Symlinks are not followed; other filesystems are not crossed; scan is bounded (300 k entries / 25 s).
- Memory, sessions, WhatsApp/Baileys, credentials/auth/tokens, databases, identity files, `openclaw.json`, `.env*`,
  backups (`backup/`, `backups/`, `basht-backup*`, `*.bkp`) are summed into a single `<protected>` total and are never
  named or counted as candidates. Backup/temp/doctor variants of a protected name (`customers.sqlite.bak`,
  `IDENTITY.md.bak`, `AGENTS.md.doctor-backup-<ts>`, `agents.migrated-<ts>/`) stay protected.
- **Scan root inside a protected tree.** `DIAG_STORAGE_ROOT` may be any directory, including one *inside* a protected
  tree (`<workspace>/memory`, `<state>/agents/main/sessions`, `…/credentials/whatsapp/default`, a doctor snapshot,
  `plugin-captures/…`). Protection is derived from every component of the resolved root path **and** of its real path
  (a symlinked root is followed with `realpath`, the only call besides `readdir`/`lstat`/`statfs`). In that case every
  byte is counted as `<protected>` (or `recovery.*`), the detail output has the single anonymous row `/<protected>`
  (`/<doctor-snapshot>`, `/<plugin-captures>`), nothing is a candidate, and the `enabled root=` log line prints a
  sanitised label (`/data/workspace/<protected>`), never the configured path. Only *protective* context is inherited:
  cache/exports classification is not, so narrowing the root can only reduce what is reported as a candidate.
  Fail-safe side effect: if a component of the real mount path happens to look protected (e.g. a host path containing
  `state`), the scan is anonymous rather than detailed.
- A scan failure logs only the errno code (`scan failed: ENOENT`), never a message or a path.
- Names that look like phone numbers, ids or hashes are printed as `<other>`.
- Files modified in the last 24 h, `.lock/.pid/.sock/.wal/.shm` and anything younger than 7 days are never candidates.
- A candidate is a *measurement*, not a deletion list. Cleanup needs a separate, explicitly approved change.

## Cost and gateway impact (measured)

The scan runs inside the wrapper process (`src/server.js`), which proxies HTTP/WS to the gateway; the gateway itself
is a separate child process and is never paused, signalled or restarted by the scan. The walk is strictly sequential
(one `readdir`/`lstat` in flight, so it occupies one libuv thread-pool slot), yields every 500 entries and is capped at
300 k entries / 25 s. Reproduce with `node --expose-gc scripts/bench-storage-diag.mjs <files>` (synthetic tree, temp
dir, removed afterwards):

| Files | Scan wall | Process CPU | RSS Δ (peak) | Heap peak | Max event-loop delay | Proxy-stand-in p99 / max during scan (baseline) |
|---|---|---|---|---|---|---|
| 20 000 | 1.4 s | 1.9 s | +11.8 MB | 16 MB | 10.4 ms | 0.4 / 3.6 ms (0.2 / 12.1 ms) |
| 100 000 | 5.6 s | 6.7 s | +22 MB | 28 MB | 13.1 ms | 0.2 / 4.1 ms (0.2 / 10.1 ms) |

(Node 22, 4 vCPU dev container; CPU > wall because lstat runs on the thread pool.)

Real image (`scripts/test-storage-diag-container.sh <image>`, openclaw@2026.10.9, Node 26, real gateway, 46 k files /
417 MB synthetic volume): scan 2.6 s, wrapper CPU 2.6 s (≈ one core for the scan duration), max event-loop delay
20.8 ms, `/setup/healthz` through the wrapper p50 3.8 ms / p99 12.6 ms / max 74 ms with 652/652 requests = 200 during
the scan window, gateway PID unchanged, 64 seeded sensitive/recovery files byte-identical across the scan, 3
`storage-diag` lines in total. With `DIAG_STORAGE=0` there is no `storage-diag` line at all. Every production run reports its own
`scan.ms`, `scan.cpuMs`, `scan.lagMaxMs` and `scan.rssMB`, so the real cost on the volume is visible in the logs.

## Alerts

The heartbeat logs one `WARN` when the volume crosses 85 % (and 95 %), at most one reminder per 24 h, and one recovery
line below 80 %. For a push/e-mail alert use the Railway **disk usage monitor** (Observability → Monitors) at 85 %.

## Rollback

Unset `DIAG_STORAGE` (or set it to `0`) and redeploy/restart; the code path then returns immediately.
