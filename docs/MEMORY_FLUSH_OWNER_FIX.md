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

For the **file-arm** flush only, the flush keeps the owner's identity (`senderIsOwner: true` + the owner's
`SenderId/SenderE164`) **only when all of the following hold — otherwise it fails closed to upstream's anonymous
identity**:

1. the source turn was an owner turn (`run.senderIsOwner === true`) and its transcript is not tainted;
2. the flush uses the file arm (`memoryFlushWritePath` set — never the tools arm);
3. ownership is **proven again at flush time** with OpenClaw's own channel-owner rule
   (`get-reply-XXltnwYw.mjs:3847`, `isCurrentChannelOwner`):
   * a bound `commandOwnerAuthority` must be **current** — revoked/expired/throwing ⇒ denied, **no fallback**;
   * with no bound authority, the sender must match `commands.ownerAllowFrom` in the **live** config
     (`isConfiguredCommandOwner(getRuntimeConfig(), …)`; wildcards are stripped and never count);
4. only identifiers that **individually** prove ownership are propagated (an impostor `SenderId` next to an owner
   `SenderE164` is dropped);
5. the proof is **repeated before every model attempt** — a revocation mid-flush aborts the attempt.

Unchanged: non-owner sessions, tainted turns, tools-arm providers, CLI/webchat turns without a sender, the owner-only
core-tool deny list, the flush tool projection (**exactly `read` + append-only `write` locked to `memory/<date>.md`**,
with OpenClaw's duplicate-content rejection), and every operator allow/deny rule.

Safety rails: the patch is four exact-match edits; the build **fails** if the OpenClaw version, the file hash
(`afee1159…7641`) or any anchor differs. OpenClaw's own `postinstall-content-inventory.json` entry is updated so update
and integrity tooling stays consistent.

### 3.1 How owner identity is established (OpenClaw 2026.10.9 source)

| Source of `senderIsOwner` on a live turn | WhatsApp in 2026.10.9 |
|---|---|
| `senderIsOwnerByIdentity` — adapter-supplied `SenderId`/`SenderE164` match `commands.ownerAllowFrom` (`command-auth-BHrKDij6.mjs:439`) | **This is the only basis.** |
| `senderIsOwnerByScope` — internal channel with `operator.admin` scope (`:440`) | n/a (internal channels only) |
| `commandOwnerAuthority` — bound only for a **verified** stable-id principal (`runtime-DMtpNGYN.mjs:1275`) | **Never produced**: the WhatsApp plugin declares its sender identity without `authentication`, so it defaults to `"asserted"`, not `"verified"` (`@openclaw/whatsapp` `monitor-DVzumwCI.mjs:188-212`, core `runtime-DMtpNGYN.mjs:28`). |

So requiring `commandOwnerAuthority` unconditionally would make the fix inert on WhatsApp, while accepting the
propagated flag alone (the original revision) trusted a boolean. The fail-closed revision re-derives ownership from the
same evidence the gateway used — the channel-asserted sender id against the configured owner list — and honours a
command-owner authority wherever one exists. A sender that is admitted by `channels.whatsapp.allowFrom` but is **not**
in `commands.ownerAllowFrom` is never treated as owner.

### 3.2 Why the flush can never exceed the real owner's rights

* The flush tool set is projected to `read` + append-only `write` **before** any policy layer
  (`core-coding-tools-DFJcX7yX.mjs:123-140`); policy can only remove tools.
* For `trigger === "memory"` OpenClaw disables ring-zero tools (`agent-tools-Bpi7xWYy.mjs`), tool-search/code-mode
  (`tool-surface-bridge-Ccc1MrSf.mjs:1584-1593`), client tools and bundle MCP/LSP tools
  (`builtin-openclaw-BxzDR6yL.mjs:604-620`), and forces workspace-only file access (`prepared-tool-surface-uIlMCUI4.mjs:13`).
* The append-only writer rejects any path other than `memory/<date>.md` (including `@`-prefixed and escaping paths),
  never truncates, and refuses replayed content (`agent-tools.read-KaO_d_Xi.mjs:521-575`).

## 4. Verification

| Layer | What | Result |
|---|---|---|
| Unit — security gates | `senderIsOwner=true` + sender, **no** authority, **not** configured ⇒ denied; configured owner ⇒ allowed; owner removed from live config mid-flush ⇒ attempt aborts; authority current ⇒ allowed; authority revoked/expired/throwing ⇒ denied **without** config fallback; impostor number / mixed ids / other channel / no channel; non-owner, tainted, tools-arm, identity-less, config-read failure | 6/6 |
| Unit — patch & doctor | transform, drift refusal, reversibility, version/hash refusal, PN/LID helpers, doctor applies the same owner gate | 5/5 |
| Integration (real `openclaw@2026.10.9` dist) | hash pin; patched module links; real tool-policy matrix; helper with **real** `isConfiguredCommandOwner` / `getCommandOwnerAuthority` (wildcard, prefixed-entry-without-plugin fail closed, revoked bound authority); **real** append-only writer: 6 forbidden paths rejected, replay rejected, append preserves existing entries, other files untouched | 5/5 |
| End-to-end (`patches/e2e/memory-flush-e2e.sh`) | real `openclaw agent --local` turns with the **real `@openclaw/whatsapp` plugin** → flush → compaction → recall | 6/6 |
| Regression | full repo suite | 502/502 |
| Packaging | `check-dockerfiles` + entrypoint simulations | 10/10 |
| Image | Dockerfile builds with the patch (sha `2812f12a…`); image boots via entrypoint (`/setup/healthz` 200, gateway ready) | pass |
| Security review | dedicated security review of the full diff against OpenClaw + WhatsApp plugin source | 0 findings ≥ 8/10 |

End-to-end matrix (owner `+15550001234` is in `commands.ownerAllowFrom` as `whatsapp:+15550001234` and has an
owner-only `toolsBySender` grant; `*` denies `write`):

| Case | Owner identity kept | Flush tools | Saved | Recall after compaction | Result |
|---|---|---|---|---|---|
| A upstream, owner turn | — | `read` | no — "no write tool survived" | NOT-FOUND (**production bug**) | PASS (bug reproduced) |
| B patched, owner turn | yes (configured-owner) | `read, write` | yes | **ZEBRA-4417** | PASS |
| C patched, owner flag spoofed with another number | **no** (gate) | `read` | no | NOT-FOUND | PASS |
| D patched, non-owner turn | no | `read` | no | NOT-FOUND | PASS |
| E patched, CLI turn without sender | no (= upstream) | `read` | no | NOT-FOUND | PASS |
| F patched, owner flag + owner number, owner **not** in `ownerAllowFrom` | **no** (gate) | `read` | no | NOT-FOUND | PASS |

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
| Owner not listed in `commands.ownerAllowFrom` (only in `channels.whatsapp.allowFrom`) | Patch fails closed (flush stays anonymous); doctor reports `OWNER UNVERIFIED`. Adding the owner is a config decision. |
| Provenance (residual, accepted): owner flush notes are tagged `agent` instead of upstream's `untrusted`, so they become eligible for dreaming promotion. Turn-taint only covers the latest turn, so injected text from earlier turns in the flushed window could reach a promotable note. | Same trust model OpenClaw applies to the owner's live turns (which see the same history with more tools). If stricter labelling is wanted, keep `senderIsOwner:false` for provenance only — a one-line follow-up. |

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
