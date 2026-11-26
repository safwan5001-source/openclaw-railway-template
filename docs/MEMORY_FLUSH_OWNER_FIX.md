# BASHT — pre-compaction memory flush keeps the verified owner identity

Status: ready for review. **Not deployed.** Sections 1–8 describe the original analysis on OpenClaw 2026.10.9 (chunk names and line numbers there refer to that release); section 9 records the re-validation for 2026.11.10. No production config, WhatsApp setting, model, permission or data was changed.

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

## 4b. Re-verification on top of `main@901dd72` (after the PR #27 security fix)

The branch was updated by **merging** `main` (no rebase, no force-push). The merge had no conflicts. Against `main`, this
PR touches no file in `src/`, `scripts/`, `entrypoint.sh` or the PR #27 workflows; it only adds the patch step to the
`Dockerfile`, the `patches/` directory, a CI job, `package.json` scripts and this document.

| Check (head of this branch) | Result |
|---|---|
| `scripts/ci-local.sh --with-openclaw` (PR #27's local CI): syntax, wrapper + skill suite, packaging + **security invariants**, skills, shellcheck, pinned OpenClaw install, skill eligibility, `patches/*.test.mjs` on the pinned dist | **RESULT PASS** (516 + 14 + 16 tests, 0 failures) |
| E2E with the real `@openclaw/whatsapp` plugin (§4 matrix A–F) | 6/6 |
| Docker image build (patch applied, sha `2812f12a…`) | pass |
| `scripts/smoke-openclaw-image.sh` (V1 token injection, V5 env, V6 full volume, non-root, `/setup` auth) | 19/19 |
| `scripts/export-drill.sh` (V12 streaming export, 900 MB synthetic) | 10/10 |
| `scripts/restore-drill.sh` | pass on most runs; intermittent failures are **pre-existing in `main`** (below) |

**Restore drill (pre-existing timing race, not caused by this PR).** Two checks fail intermittently:
* `.openclaw/openclaw.json.last-good` present after restore but absent in the "before" snapshot. OpenClaw's config-health
  monitor writes this file asynchronously after the gateway starts (`io.factory-*.mjs`, last-known-good promotion), so it
  depends on whether the snapshot was taken before or after that write.
* "backup wrote nothing significant to the volume" (volume-delta timing).

Alternating runs on an idle host: the image built from **`main` (no patch)** failed 3/6 (including the identical
`last-good` diff), the patched image 1/6. The memory-flush code path does not run in the drill (no agent turns).
Suggested fix for the drill (separate PR): exclude `*.last-good` from the manifest, or wait for the config-health
promotion before snapshotting.

## 5. Pre-deploy check on production (read-only)

The doctor ships in the image (`/app/patches/memory-flush-doctor.mjs`). Before or after deploying, in the Railway
console:

```bash
gosu openclaw node /app/patches/memory-flush-doctor.mjs          # or --json
```

Run it as the `openclaw` user (the doctor refuses root).

The doctor is **strictly read-only** (see §5.2): it reads `openclaw.json` through an `O_RDONLY|O_NOFOLLOW` handle,
derives the owner with the same normaliser as `owner-check.mjs` (`patches/whatsapp-owner.mjs`), takes the tool-policy
replay from `owner-check.mjs` (sandboxed child) and prints which policy step removes `write` for: owner turn, upstream
flush, patched flush, impostor flush — plus the owner entry forms and the latest memory files. Numbers are masked. The
final verdict starts with owner-check's `READY` / `BLOCKED` and adds the doctor's cause; if the two tools ever derived
a different owner count it says `INCONSISTENT` instead of picking one. Possible causes:

* **"identity propagation is the cause"** → this PR fixes production.
* **"operator tool policy removes write for the owner too"** → an agent-level `deny`/`allow` excludes `write` for
  every turn. The patch is still correct but not sufficient; enabling the flush then needs an explicit owner decision
  on config (e.g. move the `write` restriction into `toolsBySender."*"` and keep it open for the owner entry). Not done
  here because permission changes require explicit approval.

### 5.1 Owner readiness check (`patches/owner-check.mjs`, strictly read-only)

The first doctor used OpenClaw's CLI (`config get`, `sessions list`). Testing showed that even those read commands
**write to `state/openclaw.sqlite`** (WAL/maintenance) and create caches under `~/.cache` and `/tmp`. For a check that
must not touch a live production volume, `owner-check.mjs` avoids the CLI entirely (and since §5.2 the doctor does too):

* reads `openclaw.json` (JSON or JSON5) and the agent session stores' bytes with `O_RDONLY` file handles — no SQLite
  connection, so no WAL/SHM/lock interaction with the running gateway;
* replays OpenClaw's tool-policy assembly in a child process that receives **only an allowlist of tool-policy fields**
  (`profile/allow/alsoAllow/deny/byProvider/toolsBySender` for `tools` and each agent — no `agentDir`, workspace or
  `session.store` paths, no API keys), whose `HOME`, `TMPDIR`, `XDG_CACHE_HOME`, `OPENCLAW_STATE_DIR` and workspace all
  live in one temp directory (deleted before exit), with a minimal environment (no inherited secrets) and
  `OPENCLAW_LOG_LEVEL=silent` (OpenClaw's file logger ignores `TMPDIR` and would otherwise append to the live gateway's
  `/tmp/openclaw/*.log`); the child's stdout/stderr go to `/dev/null` and its result returns on a private pipe;
* simulates every agent that holds the owner's WhatsApp DM (not only `main`) and counts exactly the owner entries
  OpenClaw accepts (§5.2: with or without `+`, `whatsapp:` prefix, spaces/dashes, user JIDs); legacy `whatsapp:user:`,
  group/other-`@` and `${ENV}` entries, `$include` and `${ENV}` in policy fields are `BLOCKED`;
* prints exactly one line `BASHT_OWNER_CHECK {json}`: booleans, counts, policy-step names and a verdict
  (`READY` / `BLOCKED: <reason>` / `REFUSED`); 7+ digit runs are masked; errors are reduced to their type;
* refuses root and any OpenClaw version other than 2026.11.10.

```bash
gosu openclaw node /app/patches/owner-check.mjs     # after deploy (to run a copy, copy whatsapp-owner.mjs alongside)
```

Verified by `patches/owner-check.test.mjs` (synthetic state, run unprivileged, full before/after file snapshot incl. a
private `TMPDIR`, a live WAL database referenced from config and `/tmp/openclaw` logs; secret and digit leak checks; one
regression test per security-review finding F1–F7) and E2E case G (real OpenClaw SQLite store with `-wal`/`-shm`/lock
files). An independent security review found F1–F7 in the first version (two High: a log append to the live gateway log,
and opening a live database through a forwarded `agentDir`); all are fixed and covered by tests.

### 5.2 Doctor vs owner-check contradiction (READY vs `verifiedOwners=[]`, `write=false`) — root cause and fix

**Symptom.** On production `owner-check.mjs` printed `READY` while `memory-flush-doctor.mjs` printed
`verifiedOwners=[]`, `OWNER UNVERIFIED` and `write=false`.

**Root cause: the doctor's owner parser, not OpenClaw or owner-check.** The doctor accepted an owner only if, after
stripping `whatsapp:`, it matched `/^\+\d{7,15}$/`, so the `+` was **mandatory**. owner-check accepted
`/^(?:whatsapp:)?\+?\d{7,15}$/` (`+` optional). OpenClaw 2026.10.9 itself (`isConfiguredCommandOwner` →
`resolveOwnerAllowFromList` → `@openclaw/whatsapp` `normalizeWhatsAppAllowFromEntries` → `normalizeE164`) keeps
**digits only**, so `whatsapp:9665…` is a valid owner. With an owner entry without `+`, the doctor found no owner, skipped
the `flush_patched` case and reported only the anonymous flush (`write=false`). Reproduced with synthetic state against
the merged PR #25 code: owner-check `READY`, doctor `verifiedOwners: []`.

Owner forms, evaluated with the **real** `isConfiguredCommandOwner` + real WhatsApp plugin
(`patches/whatsapp-owner.test.mjs`, owner `+15550001234`):

| `commands.ownerAllowFrom` entry | OpenClaw | doctor (PR #25) | owner-check (PR #25) | both (fixed) |
|---|---|---|---|---|
| `whatsapp:+15550001234`, `+15550001234` | owner | owner | owner | owner |
| `whatsapp:15550001234`, `15550001234` | owner | **none** | owner | owner |
| `whatsapp:+1 555-000-1234`, `15550001234@s.whatsapp.net`, `whatsapp:whatsapp:+1555…` | owner | none | BLOCKED (unrecognised) | owner |
| `*`, `telegram:…`, `whatsapp:user:…`, `…@g.us` | not owner | not owner | ignored / BLOCKED | ignored / BLOCKED |

**Second defect: the doctor was not read-only.** `openclaw sessions list` creates/writes `state/openclaw.sqlite`
(`-wal`/`-shm`), every CLI start writes ~3–4.6k compile-cache files to `TMPDIR` (`/tmp` in production), and the
in-process replay could append to `/tmp/openclaw/*.log`.

**Fix.** `patches/whatsapp-owner.mjs` mirrors OpenClaw's rule and is the single owner normaliser for both tools. The
doctor no longer runs the CLI or imports OpenClaw; it reuses owner-check's sandboxed replay and cross-checks the owner
count. No owner setting, tool permission or production file is changed by this fix.

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

## 9. Upgrade to OpenClaw 2026.11.10 (re-validated against the real package)

The 2026.11.10 bundle is minified (single line, one-letter locals), so the patch matches exact snippets instead of
formatted source. It still applies the same four additive edits and refuses any drift (version, SHA-256 of
`dist/agent-runner-memory-Bmk5_PZf.mjs`, anchor count). Differences that matter:

| Area | 2026.10.9 | 2026.11.10 |
|---|---|---|
| Patched chunk | `agent-runner-memory-BkOUjtvi.mjs` | `agent-runner-memory-Bmk5_PZf.mjs` |
| Owner functions imported by the helper | `command-auth-BHrKDij6.mjs` | `command-auth-Ch_q0NQN.mjs` (`h` getCommandOwnerAuthority, `t` isConfiguredCommandOwner, `p` bindCommandOwnerAuthority) |
| Live config reader | `io.runtime-B134MOMz.mjs` | `io.runtime-euLviN5p.mjs` (`getRuntimeConfig`) |
| Tool assembly used by tests/diagnostics | `agent-tools-Bpi7xWYy.mjs` (`i`) | `agent-tools.async-Cu9hozum.mjs`: `t` createOpenClawCodingToolsAsync (options only), `n` createOpenClawCodingToolsInternalAsync (third argument is the `onFilter({step, before, after})` observer used by `owner-check.mjs`) |
| Taint input | `turnTainted === true` | patch passes `turnTainted !== false`: an unknown taint state is treated as tainted (stricter, fail-closed). Upstream also reports `turnTainted: true` when the transcript cannot be read. |
| WhatsApp owner entry without the channel plugin | n/a | `whatsapp:+E164` resolves through OpenClaw's own rule even without the plugin; `whatsapp:<digits>` does not (still denied by the helper). The helper adds no rule of its own. |

Behaviour notes: the optional debug line `memory flush keeps verified owner identity` is no longer emitted (the
2026.11.10 insertion avoids a logger anchor). Verify a deployment by the absence of `no write tool survived` and a new
`memory/<date>.md` entry. The diagnostics (`owner-check.mjs`, `memory-flush-doctor.mjs`, `whatsapp-owner.mjs`) now pin
2026.11.10 and the chunk names above.

Verification on the real package (`openclaw@2026.11.10` + `@openclaw/whatsapp@2026.11.10`):

* `node --test --test-concurrency=1 patches/*.test.mjs`: 39/39, none skipped (including the parity test with the real
  WhatsApp plugin and the unprivileged `owner-check` replays).
* `bash patches/e2e/memory-flush-e2e.sh`: A (upstream) loses the fact (`flushTools=["read"]`, recall `NOT-FOUND`); B (patched owner) saves
  it and recalls `ZEBRA-4417`; C (spoofed owner number), D (non-owner), E (no sender) and F (owner removed from
  config) stay read-only. In 2026.11.10 compaction is proven from the summarisation requests the fake model receives
  (`outcome=compacted` is no longer logged), and the runtime-context block is a separate trailing user message, so the
  fake model matches the recall prompt in the last two user messages.
