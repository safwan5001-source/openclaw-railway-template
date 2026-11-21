# Storage diagnostics (read-only)

Purpose: find out what fills the persistent volume (`/data`, 5 GB on the Hobby plan) without shell access and without
exposing contents. Implemented in `src/storage-diagnostics.js`; **off unless `DIAG_STORAGE=1`**.

## What it logs

Two JSON lines tagged `[storage-diag]` at boot+90 s and then every `DIAG_STORAGE_INTERVAL_HOURS` (default 6):

1. **summary** — `fs` (statfs total/used/free/usedPct), scan stats, `protectedMB`, measured cleanup `candidates`
   (`tmp`, `backup`, `log`, `cache`, `exportsOld`), `possibleDupes` (same name **and** size, contents never compared)
   and `activeExcluded`.
2. **detail** — top folders at depth 1 and 2 with size, file count and the part modified in the last 24 h (`m24`, the
   growth driver).

Read them with Railway logs (filter `storage-diag`).

## Safety rules (enforced by tests)

- `readdir`/`lstat`/`statfs` only: no reading of file contents, no writes, no deletes, no child processes, no network.
- Symlinks are not followed; other filesystems are not crossed; scan is bounded (300 k entries / 25 s).
- Memory, sessions, WhatsApp/Baileys, credentials/auth/tokens, databases, identity files, `openclaw.json`, `.env*` are
  summed into a single `<protected>` total and are never named or counted as candidates.
- Names that look like phone numbers, ids or hashes are printed as `<other>`.
- Files modified in the last 24 h, `.lock/.pid/.sock/.wal/.shm` and anything younger than 7 days are never candidates.
- A candidate is a *measurement*, not a deletion list. Cleanup needs a separate, explicitly approved change.

## Alerts

The heartbeat logs one `WARN` when the volume crosses 85 % (and 95 %), at most one reminder per 24 h, and one recovery
line below 80 %. For a push/e-mail alert use the Railway **disk usage monitor** (Observability → Monitors) at 85 %.

## Rollback

Unset `DIAG_STORAGE` (or set it to `0`) and redeploy/restart; the code path then returns immediately.
