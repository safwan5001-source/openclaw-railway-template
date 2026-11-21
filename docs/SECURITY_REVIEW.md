# BASHT Security & Production Readiness Review (2026-11-21)

Scope: `src/server.js` admin wrapper, OpenClaw/broker images, `entrypoint.sh`, CI/CD and deployment.
Method: code review + a **live lab**: the real wrapper in front of the real pinned OpenClaw 2026.10.9 gateway on
loopback, synthetic config/data only. Production was **not** probed (a probe would expose live secrets).
Production state (read-only): the OpenClaw service runs commit `60ee51b` (= `main`), deploys on every push to
`main` without waiting for CI, has a public domain and a 5 GB volume at `/data`.

## 1. Proven vulnerabilities (fixed in this branch)

| # | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| V1 | **Critical** | The wrapper attached `Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>` to **every** proxied request (HTTP and WebSocket) except `/hooks/*`, and `GET /openclaw` redirected **any visitor** to `/openclaw?token=<gateway token>`. Anyone on the internet had operator access to the gateway. | Lab: anonymous `POST /tools/invoke` through the wrapper returned data from `sessions_list`, `session_status`, `agents_list`, and `memory_get` read a synthetic `MEMORY.md`; `message`, `web_fetch`, `browser`, `memory_search`, `sessions_history` were dispatched (not 401). The same request straight to the gateway: **401**. `GET /openclaw` → `302 Location: /openclaw?token=<token>`. | Token attached only when the request carries the valid setup password; `/openclaw` link only after the setup login; `/hooks/*` never gets the token nor the setup password. After fix (lab): anonymous → **401** from the gateway; operator path unchanged. |
| V2 | High | CSRF on `/setup/api/*`: Basic credentials are re-sent by browsers on cross-site form posts. Body-less actions (`reset` deletes `openclaw.json`; `devices/approve` with no body approves the **newest** pending device with `operator.admin`; `doctor --fix`) were triggerable from any web page while the operator was logged in. Chained with V1 (attacker creates a pending pairing) → admin device. | Code; regression test posts with `Origin: https://evil.example` and asserts 403 and that the config survives. | Same-origin check (`Origin` / `Sec-Fetch-Site`) on every non-GET request to `/setup` and `/logs`. UI unchanged (it is same-origin). |
| V3 | Medium | Login throttling keyed on `req.ip` without `trust proxy` = Railway edge address (shared by all clients), counted **successful** requests (50/min) → the operator's own use could lock everyone out, and wrong-password guessing through the proxy path (V1 surface) was not throttled at all. | Code (`setupRateLimiter`), tests. | Failed logins only; per client (Railway `X-Real-IP`, same trust as `proxy-headers.js`) 10/15 min + global 200/15 min; applied on `/setup`, the proxy path and WebSocket upgrades. |
| V4 | Medium (functional) | Global `express.json()` consumed JSON bodies of **proxied** requests: JSON `/hooks/*` webhooks and APIs reached the gateway empty and hung until the 120 s proxy timeout. | Lab: 408 `Request body timeout`; regression test hits the 120 s timeout on `main`. | Parser mounted on `/setup` only. |
| V5 | Medium | `SETUP_PASSWORD` was inherited by the gateway, the agent's tools and every CLI child (`...process.env`). | Lab: `/proc/<gateway>/environ` contained it; after fix: 0 entries. | `delete process.env.SETUP_PASSWORD` after reading it. Residual: the wrapper's own `/proc/<pid>/environ` (same uid) still holds the startup value — see R1. |
| V6 | Medium (availability) | `entrypoint.sh` copied Homebrew to the volume with `set -e` and no staging: a failed copy (full volume) **stopped boot**, and a half copy was trusted forever (never retried). | `scripts/test-openclaw-entrypoint.sh` against the old script: 5/11 checks fail. | Copy to `.linuxbrew.partial` + rename; on failure log and boot with the image's Homebrew; next boot retries. |
| V7 | Low | `npm install -g clawhub@latest` → non-reproducible image (0.26.0 → 0.27.0 on 2026-11-19). | npm registry timeline. | Pinned `clawhub@0.27.0`; invariant test forbids `@latest`/`@next`. |
| V8 | Low | `auto-close-spam.yml` exempted the **upstream** owner (`arjunkomath`); in this fork the owner's own short-titled PRs would be auto-closed. | Code. | Exempt `context.repo.owner` and OWNER/MEMBER/COLLABORATOR. |
| V9 | Low | No anti-framing headers on admin pages; `?lines=abc` returned the whole log. | Code. | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `no-store` on `/setup/api`, input validation. |
| V10 | **High** (availability, unauthenticated) | A client that resets its TCP connection during a WebSocket handshake raised an unhandled `error` on the raw socket and **killed the wrapper process** — gateway and WhatsApp down until Railway restarts the container, repeatable at will by anyone. Present on `main`. | Lab, real gateway: 21 anonymous resets crash both `main` and the first PR head. Regression test (64 resets) fails before, passes after. | `socket.on("error")` first thing in the upgrade handler; WebSocket proxy errors destroy the socket. |
| V11 | Medium (availability of memory) | On a **fresh volume** (first boot, or disaster recovery onto a new volume) `skill-sync` runs as root after `chown -R /data`, leaving `/data/workspace` and `skills/` root-owned: the agent cannot write memory until the next reboot. | Container on an empty volume: `drwxr-xr-x root root /data/workspace`. | Entrypoint hands both directories back to `openclaw` after the sync; simulation test. |

### Final verification of V1 (old code vs fix, real gateway, production-like: public domain + external client IP)

| Step | `main` | This PR |
|---|---|---|
| Anonymous `GET /openclaw` | 302 → `?token=<gateway token>` | 401, no token |
| Anonymous HTTP `/tools/invoke` (memory, sessions, message, web_fetch, browser) | executed | 401 |
| Anonymous WebSocket with its own device identity, using the harvested token | pairing request created | no token → `AUTH_TOKEN_MISSING`, nothing created |
| Cross-site POST `/setup/api/devices/approve` riding the operator's login | approved the attacker's device | 403 |
| Attacker reconnects | **`operator.admin` session** | — |
| Spoofed `X-Real-IP: 127.0.0.1` | — | rejected; wrapper stays up (V10) |

The WebSocket path itself never trusted the injected HTTP header (the gateway reads the token from the connect frame),
so the WS risk was the token handed out by `/openclaw` plus V2 — both closed. Token never found in wrapper, gateway or
container logs. The operator flow still works: setup login → `/openclaw` → Control UI connects and removes the token
from the address bar itself.

## 2. Potential risks (need verification or an owner decision; not changed)

| # | Risk | What to verify / do |
|---|---|---|
| R1 | Wrapper, gateway and agent tools run as the same uid in one container: a prompt-injected agent with `exec` can read the wrapper's `/proc/<pid>/environ` (SETUP_PASSWORD, gateway token) and every variable set on the service (API keys, a GitHub token, broker/bridge tokens). | Remove variables the agent does not need; give any GitHub token the narrowest scope (read-only, or none). With `main` unprotected and auto-deploy without CI, a write-scoped GitHub token = the agent can ship code to production. |
| R2 | `/setup` export = every secret, protected by legacy ZipCrypto with the setup password on `zip`'s command line. Import buffers up to 250 MB in RAM and extracts without a size cap. | Use the encrypted backup (docs/BACKUP.md) instead; seal any legacy export locally right away. Optional: a size cap on import. |
| R3 | `X-Real-IP` trust: if Railway's edge forwards a client-supplied value, per-client throttling can be spread across keys (global ceiling still applies). | Confirm on Railway docs/support. |
| R4 | `browser.noSandbox=true` when `OPENCLAW_BROWSER=1`: a Chromium exploit runs as the agent user (which already holds all secrets, R1). | Prefer the cloud browser (Browserbase/Steel), keep the local browser off. Variable value not read. |
| R5 | Homebrew installer fetched from `Homebrew/install@HEAD` and piped to bash at build time; base images use tags, not digests. | Pin the installer commit and image digests if build reproducibility matters. |
| R6 | `chown -R /data` on every boot rewrites ctime of every file. Measured: 0.25 s / 100k files on local disk (targeted `find` 0.14 s). | Low impact; revisit if PR #26 diagnostics show >500k files. `.linuxbrew` size on the volume will also be visible in PR #26 output. |
| R7 | `openclaw.json.bak-*` is written on every config save and never pruned (contains secrets, uses volume space). | Decide a retention; not deleted automatically (production data). |
| R8 | Other services reaching the wrapper over the private network got the token injected too. After V1 they need their own gateway token. | After deploy, watch logs for new 401s from sibling services. |

## 3. Deploy plan (owner approval required — nothing here was deployed)

Compatibility checked: WhatsApp (Baileys plugin, outbound only, no inbound HTTP route), Daftra broker (OpenClaw calls
the broker on the private network; the broker never calls OpenClaw), browser bridges (OpenClaw calls them; their
variables reference only the cloud-browser APIs). None depends on the token the wrapper used to inject.
Railway switches traffic only after `/setup/healthz` passes, so a build or boot failure leaves the old deployment live.

1. **Backup first** (Railway Hobby has none): `/setup` → Export Data, then seal it locally — `docs/BACKUP.md`
   "Before the security deploy". Note the rollback target: the active deployment (commit `60ee51b`).
2. Review + merge the PR to `main` (auto-deploys). Optionally in the same change: set `BASHT_BACKUP_PUBLIC_KEY`.
3. **Acceptance tests (within 10 minutes)** — any failure → rollback (step 5):

   | # | Check | Expected |
   |---|---|---|
   | A1 | `curl -s https://<domain>/setup/healthz` | 200, `"gatewayReachable":true` |
   | A2 | `curl -s -o /dev/null -w '%{http_code}' -X POST https://<domain>/tools/invoke -d '{"tool":"session_status"}'` | **401** |
   | A3 | `curl -s -o /dev/null -w '%{http_code}' https://<domain>/openclaw` | **401** (no `Location` with a token) |
   | A4 | `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://example.org' -u x:<SETUP_PASSWORD> https://<domain>/setup/api/pairing/approve` (harmless: empty body) | **403** (400 would mean the CSRF guard is off) |
   | A5 | Browser: `/setup` → password → wizard, Devices, Logs load | works |
   | A6 | Browser: `/openclaw` → password → Control UI connected | works |
   | A7 | WhatsApp: message BASHT from the owner's phone | reply received |
   | A8 | Ask BASHT for a Daftra read (e.g. last 5 invoices) | answered via the broker |
   | A9 | Railway logs, 15 min | no crash/restart loop; no new 401/429 from sibling services |
   | A10 | If the key is set: `/setup` → Download Encrypted Backup; `inspect` it locally | `.bkp`, correct key id, gateway back within seconds |

4. **Rotate after the deploy is accepted** (not before — the old code would hand the new token out again):

   | Secret | Why | How | Order |
   |---|---|---|---|
   | `OPENCLAW_GATEWAY_TOKEN` | handed to every visitor of `/openclaw` until now | `openssl rand -hex 32` → Railway variable → redeploy. Verified in the lab: the old token is rejected immediately (the CLI flag overrides the copy in `openclaw.json`; update that copy via `/setup` → Config to keep CLI tools consistent). | 1 |
   | Paired devices | device tokens survive a gateway-token rotation | Control UI → Devices (or `openclaw devices list` in the Railway shell): remove every device you do not recognise | 2 |
   | `SETUP_PASSWORD` | was inherited by the gateway and the agent's tools | new long random value → Railway variable → redeploy | 3 |
   | WhatsApp | an attacker with operator access could have linked a session | phone → WhatsApp → Linked devices: remove unknown entries | 4 |
   | Provider / API keys in `openclaw.json` and service variables | only if the logs show anonymous `/tools/invoke`, `/v1/*` or WebSocket activity, or step 2 found an unknown device | rotate at each provider, then update | 5 (conditional) |

   Evidence to check before deciding step 5: Railway HTTP logs for `POST /tools/invoke`, `GET /openclaw` (302) and
   WebSocket upgrades from addresses that are not yours, since the domain went public.
5. **Rollback:** Railway → Deployments → the noted deployment → **Rollback** (or revert the merge commit). No data
   migration is involved; rotated tokens stay valid with the old code (but the old code would expose them again, so
   roll forward with a fix rather than staying on the old code).

## 3b. Incident containment

| Signal | Immediate action | Then |
|---|---|---|
| Health check fails / restart loop after deploy | Rollback (step 5) | Read the deploy logs; reproduce with `scripts/smoke-openclaw-image.sh` |
| WhatsApp stops answering, service healthy | Check logs for the WhatsApp channel; restart once | Rollback if it started with the deploy; WhatsApp session is in the backup |
| Unknown paired device / anonymous tool calls in logs | Rotate gateway token + setup password, remove devices (step 4, rows 1–4) | Take an encrypted backup for forensics *before* cleaning; rotate provider keys; review `sessions` for data exposure |
| Volume near full | Nothing is lost: boot no longer depends on the Homebrew copy | Enable `DIAG_STORAGE=1` (PR #26) to see what grows; restore needs free space (docs/BACKUP.md) |
| Data loss / corrupted volume | Stop changes; new volume | Restore the latest `.bkp` (docs/BACKUP.md, drilled end to end) |

## 4. CI/CD

- **GitHub Actions: BLOCKED at GitHub.** `workflow_dispatch` returns `Actions has been disabled for this repository`.
  Ruled out: billing/budget (public repo; runs billed 0 ms), disabled workflows (both `active`), path filters
  (`auto-close-spam` on every PR also stopped). Last run: 2026-11-06 19:57 UTC; PRs #20–#26 have no runs.
  Official remediation: Settings → Actions → General → *Allow all actions and reusable workflows* → **Save**. If the
  page already shows that and the error persists, the restriction is on GitHub's side: open a ticket at
  support.github.com (Actions) quoting the repository and the error above. No payment method is needed for a public
  repository.
- `basht-ci.yml`: every push/PR, no path filters, Node 24 + 26, runs `scripts/ci-local.sh --with-openclaw`.
- Fallback until Actions is back: `bash scripts/ci-local.sh [--with-openclaw]` in an isolated dev container
  (e.g. a Claude Code cloud session). Results per commit in `.ci-results/<sha>.summary|.log`; paste the summary in
  the PR. Docker image builds still need Actions or a Docker host.
- `basht-ci.yml` job `image` (PRs / manual): builds the real image, runs `scripts/smoke-openclaw-image.sh` (19 checks)
  and `scripts/restore-drill.sh` (14 checks). Both also run on any Docker host.
- Recommended once Actions runs: protect `main` (PR required, required checks `suite (node 26)` and
  `daftra-tests (node 26)`, no force-push) and enable Railway **Wait for CI** (`checkSuites`) on the OpenClaw service.
