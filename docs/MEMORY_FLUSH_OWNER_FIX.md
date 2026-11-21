# BASHT — pre-compaction memory flush keeps the verified owner identity

Status: ready for review. **Not deployed.** No production config, WhatsApp setting, model, permission or data was changed.

## 1. Symptom (production evidence, Railway `sweet-courtesy` / `OpenClaw`, deployment `c8b213da`, main@60ee51b)

```
[tools] tools.profile (coding) allowlist contains unknown entries (message, browser). ... memory-triggered compaction runs expose only read and append-only write.
[tools] agents.main.tools.allow allowlist contains unknown entries (message, browser). ...
memory flush cannot persist memory/2026-11-20.md: no write tool survived this agent's tool policy, so this run will not save anything.
[compaction-diag] ... sessionKey=agent:main:whatsapp:direct:+9665•••••876 ... trigger=budget ...
```

Every pre-compaction flush on the owner's WhatsApp DM ran, found no `write` tool, saved nothing, and compaction then
summarized the conversation away — facts the owner stated were lost from durable memory.

## 2. Root cause (OpenClaw 2026.10.9 source, verified in `dist/`)

| # | Reported concern | Finding |
|---|---|---|
| 1 | `senderIsOwner=true` reaches the turn, but `verifiedPrincipal` / `commandOwnerAuthority` were not proven to reach the flush | **Confirmed.** `createSessionMaintenanceFollowup()` (`dist/run-C50ZeOtw.mjs:75`) rebuilds the flush run with **`senderIsOwner: false`** and no `senderId/senderE164`; `runMemoryFlushIfNeeded()` then passes **`sessionCtx: {}`** (`dist/agent-runner-memory-BkOUjtvi.mjs:874`). The command-owner capability stays bound only to the source run. |
| 2 | PN JID or LID? | Production DM session key is `agent:main:whatsapp:direct:+<E.164>` → routing uses **PN (phone number)**. The doctor (§5) prints the live form of the owner entries and session origins (PN/LID) without exposing numbers. |
| 3 | File flush does not pass the `owner-private` audience to the memory writer | **Confirmed, by upstream design.** `prepareMemoryFlushAttempt()` resolves an audience only for the *tools* arm; memory-core uses the *file* arm, so no audience is delegated. For the file arm the relevant trust signal is write **provenance**, which is derived from `senderIsOwner` — with the forced `false` every flushed note was tagged `untrusted` (excluded from owner/agent-derived dreaming promotion). The fix restores `agent` provenance for verified owner turns. |
| 4 | Tool policy blocks `write` during the flush | **Confirmed.** Because the flush resolves policy as an anonymous non-owner, any sender-scoped rule (`tools.toolsBySender`, `agents.entries.*.tools.toolsBySender`, group sender rules) that grants `write` only to the owner removes it. Reproduced locally with the real runtime; a config with an owner-only `toolsBySender` grant reproduces the exact production log signature. |
| 5 | Earlier experiments in the BASHT environment | Nothing related exists in GitHub (no branch/PR/commit); production runs `main@60ee51b` with stock `openclaw@2026.10.9`. Any on-server edits live on the volume or in the container and were not relied on. |

## 3. Fix (build-time, version-pinned patch — `patches/openclaw-memory-flush-owner.mjs`)

For the **file-arm** flush only, when the source turn is a **verified owner turn** (`senderIsOwner === true`), its
transcript is **not tainted**, and it carries a concrete sender identity (`SenderId` or `SenderE164`):

* the flush run keeps `senderIsOwner: true` and the owner's `SenderId/SenderE164/SenderName/SenderUsername`;
* if a command-owner authority is bound to the source run it is asserted when the flush is prepared (revoked → falls
  back to upstream anonymous identity) **and again before every model attempt** (revoked mid-flush → attempt aborts).

Unchanged: non-owner sessions, tainted turns, tools-arm providers, CLI/webchat turns without a sender, the owner-only
core-tool deny list, the flush tool projection (**exactly `read` + append-only `write` locked to `memory/<date>.md`**,
with OpenClaw's duplicate-content rejection), and every operator allow/deny rule.

Safety rails: the patch is four exact-match edits; the build **fails** if the OpenClaw version, the file hash
(`afee1159…7641`) or any anchor differs. OpenClaw's own `postinstall-content-inventory.json` entry is updated so update
and integrity tooling stays consistent.

## 4. Verification

| Layer | What | Result |
|---|---|---|
| Unit | patch transform, drift refusal, reversibility, helper gates (owner / non-owner / tainted / tools-arm / no identity / revoked authority), doctor helpers | 7/7 |
| Integration (real `openclaw@2026.10.9` dist) | hash pin; patched module links; real tool-policy matrix | 3/3 |
| End-to-end (`patches/e2e/memory-flush-e2e.sh`) | real `openclaw agent --local` turns → flush → compaction → recall, loopback fake model | 5/5 |
| Regression | full repo suite | 496/496 |
| Packaging | `check-dockerfiles` + entrypoint simulations | 10/10 |
| Runtime | patched gateway boots (`/startupz` 200, `/healthz` 200, DB integrity gate passed) | pass |

End-to-end matrix (owner `+15550001234` has an owner-only `toolsBySender` grant; `*` denies `write`):

| Case | Flush tools | Saved to `memory/<date>.md` | Recall after compaction |
|---|---|---|---|
| A upstream, owner turn | `read` | no — "no write tool survived" | NOT-FOUND (**production bug**) |
| B patched, owner turn | `read, write` | yes | **ZEBRA-4417** |
| C patched, owner flag spoofed with another number | `read` | no | NOT-FOUND |
| D patched, non-owner turn | `read` | no | NOT-FOUND |
| E patched, CLI turn without sender | `read` | no (= upstream) | NOT-FOUND |

The E2E uses test-only instrumentation that gives the CLI maintenance run the same fields a WhatsApp owner reply turn
carries; it is applied identically to baseline and patched installs and never ships in the image.

## 5. Pre-deploy check on production (read-only)

The doctor ships in the image (`/app/patches/memory-flush-doctor.mjs`). Before or after deploying, in the Railway
console:

```bash
gosu openclaw node /app/patches/memory-flush-doctor.mjs          # or --json
```

Run it as the `openclaw` user (the doctor refuses root): reading the session store as root could leave root-owned
SQLite side files on `/data` that the gateway can no longer write.

It reads config via `openclaw config get`, sessions via `openclaw sessions list --json`, replays OpenClaw's own tool
policy in a throwaway workspace and prints which policy step removes `write` for: owner turn, upstream flush, patched
flush, impostor flush — plus PN/LID forms and the latest memory files. Numbers are masked. Possible verdicts:

* **"identity propagation is the cause"** → this PR fixes production.
* **"operator tool policy removes write for the owner too"** → an agent-level `deny`/`allow` excludes `write` for
  every turn. The patch is still correct but not sufficient; enabling the flush then needs an explicit owner decision
  on config (e.g. move the `write` restriction into `toolsBySender."*"` and keep it open for the owner entry). Not done
  here because permission changes require explicit approval.

## 6. Risks

| Risk | Mitigation |
|---|---|
| OpenClaw upgrade changes the chunk | Build fails loudly (version + hash + anchor checks); re-validate with `npm run test:memory-flush` and `npm run e2e:memory-flush`. |
| Owner identity widens flush tools | Impossible by construction: projection to `read` + append-only `write` happens before policy; owner-only tools are not in the projection. Covered by integration + E2E. |
| Prompt-injected transcript writes junk memory | Tainted turns keep upstream behaviour; append-only writes with duplicate rejection; non-owner sessions unchanged. |
| Owner revoked between turn and flush | Command-owner assertion at prepare time and before every attempt. |
| Production config blocks `write` for everyone | Doctor reports it; requires an explicit config decision (§5). |

## 7. Other production findings (out of scope, not changed)

* The owner's WhatsApp DM is ~305k estimated tokens against a 252k budget (`route=compact_only`, every 30 min) and an
  earlier compaction failed on an OpenAI rate-limit cooldown — the first successful compaction after deploy will run
  the flush.
* `Memory search provider is set to "openai" but no API key was found` — semantic memory search/indexing is degraded;
  recall currently relies on file reads/keyword search.
* `cron … ⚠️ Automations blocked` and one `Compaction safeguard: finalized artifact truncated` event.

## 8. Rollout and rollback

Rollout (after approval): merge → Railway builds `main` → watch deploy logs for
`[memory-flush-patch] patched …` (build) and, on the next compaction, absence of `no write tool survived` plus a new
`memory/<date>.md` entry. Optional debug line: `memory flush keeps verified owner identity`.

Rollback: Railway → OpenClaw → Deployments → redeploy `c8b213da` (current production, `canRollback: true`), or
`git revert` the merge commit. The patch touches only the image's OpenClaw `dist/`; it changes no config, volume
data or WhatsApp credentials, so rollback has no data migration. Memory notes written by the fixed flush are ordinary
append-only Markdown and remain valid after a rollback.
