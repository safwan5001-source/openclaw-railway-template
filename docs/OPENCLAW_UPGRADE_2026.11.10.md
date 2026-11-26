# OpenClaw 2026.10.9 → 2026.11.10: what the upgrade changes operationally

Status: for review. **Nothing here was deployed.** Everything below was reproduced against the real `openclaw@2026.11.10`
package (and in CI on the real image); the commands and sources are named so the claims can be re-checked.

## 1. Gateway state ownership is now enforced across containers (deployment-critical)

2026.11.10 records the running Gateway as the owner of the state directory (a lease in `state/openclaw.sqlite` plus
`tmp/openclaw-<uid>/*.lock`, with host name, PID namespace and heartbeat). A **different container** (different host
name / PID namespace) can no longer prove that a previous owner died, so it never reclaims the lease on its own, whatever
its heartbeat age ("cannot verify Gateway ownership from this process … an unverifiable owner will not be reclaimed
automatically"; `docs/gateway/gateway-lock.md` in the package). The new Gateway waits ~95 s and fails; every OpenClaw CLI
call the wrapper makes at boot fails the same way ("Doctor could not enter maintenance").

| Situation | Lease released? | Replacement container starts? |
|---|---|---|
| Gateway stopped with SIGTERM and given time to exit (measured **≈7 s** on an idle Gateway) | yes | yes |
| Container killed (SIGKILL, OOM-kill, a deploy with 0 s draining) | **no** | **no** until `openclaw gateway recover-lock` |
| Crash/restart of the Gateway process **inside the same container** | no | yes (same PID namespace: verified dead, recovered automatically) |
| Backup route (`/setup/api/backup`: Gateway stopped, same container) | yes/auto | yes |

Reproduced locally: Gateway in its own PID/UTS namespace, SIGKILL, second Gateway with another hostname on the same state ⇒
stuck; with SIGTERM instead ⇒ starts.

**Railway default**: on a replacement deploy the old deployment gets SIGTERM and, by default, **0 seconds** before SIGKILL
(Railway docs, "Deployment Teardown › Draining time" and "Singleton deploys"). With that default the old Gateway is
killed before it can release its lease.

What this branch changes in code (all default-safe):
* `gracefulShutdown` now gives the Gateway up to 25 s after SIGTERM (was 2 s, shorter than the ≈7 s it needs). The 2 s
  used when the wrapper only pauses/restarts the Gateway inside the same container is unchanged.
* `/setup/api/import` clears the foreign lease a restored **live export** carries, with OpenClaw's own
  `gateway recover-lock` (see `docs/BACKUP.md`; `BASHT_IMPORT_KEEP_FOREIGN_LOCK=1` disables it).
* **Opt-in** `BASHT_RECOVER_STALE_GATEWAY_LOCK=1`: once per boot, before anything is started or configured, the wrapper runs
  the same official `recover-lock` (inspect, then `--confirm` with that inspection's fingerprint). Off by default because it
  overrides OpenClaw's protection against two Gateways sharing state; enable it only where one container owns the volume.

**Decision needed before deploying** (pick at least the first):
1. Set the Railway service variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` to at least 30 (Railway documents it; its default
   is 0), so a replaced deployment can finish SIGTERM shutdown. Not set by this PR.
2. And/or set `BASHT_RECOVER_STALE_GATEWAY_LOCK=1` so a container that was killed (OOM, platform restart) does not wedge the
   next start. Without it, recovery is manual: run `openclaw gateway recover-lock`, then the exact `--confirm <fingerprint>`
   command it prints, in the OpenClaw service console, then restart.

## 2. Restored state must be private

`.openclaw/client` must be `0700` and owned by the service user ("Client credential directory is unsafe" otherwise).
An import ZIP has no directory modes, so `/setup/api/import` now tightens the restored state tree (directories `0700`,
group/other bits removed from files; never widened). See `src/private-permissions.js`.

## 3. New derived files in state

`<db>.sqlite.seal` (integrity seal next to each SQLite database) and `openclaw.json.last-good` (written asynchronously).
Both are carried by backups. The restore drills exclude them from the byte comparison (they change on their own); each
SQLite database is still checked with `PRAGMA integrity_check` and `openclaw.json` is compared byte for byte.

## 4. Backup tests need process inspection

The residual-writer guard fails closed on a same-user process it cannot inspect, so the backup tests run in a container
with `CAP_SYS_PTRACE` (`scripts/run-backup-tests.sh`). The guard itself is unchanged.

## 5. Memory-flush owner patch

Re-validated on the new bundle: `docs/MEMORY_FLUSH_OWNER_FIX.md` §9.
