# BASHT × Daftra — Packaging, CI and Railway readiness notes

Status: **prepared and tested offline; NOTHING is deployed.** No Railway setting, variable, secret, volume or service was touched; no
real Daftra request was made; the OpenClaw Gateway/model/volume are unchanged. These notes are raw material for the final
iPhone-only rollout plan (the parent folds them into the PR docs).

## 1. Artifacts and what each one is

| File | Service | Role |
| --- | --- | --- |
| `Dockerfile` (changed) | **OpenClaw** (existing) | + `fontconfig`, `fonts-noto-core` (Debian bookworm: Noto Naskh/Sans Arabic), `fc-cache` + a build-time `fc-match 'Noto Naskh Arabic'` assertion, `COPY skills ./skills`, `skill-sync.sh`. OpenClaw pin (`2026.10.9`), Node 26 base, healthcheck, `EXPOSE 8080`, volume mount: **unchanged**. Holds **no** broker/Daftra secret. |
| `entrypoint.sh` (changed) | OpenClaw | Existing `chown /data`, linuxbrew handling and the final `exec gosu openclaw node src/server.js` are **byte-identical**; one fail-soft call to `skill-sync.sh` was inserted before the exec (a sync failure only logs; the Gateway always starts). |
| `skill-sync.sh` (new) | OpenClaw | Copies `/app/skills/basht-daftra` → `${OPENCLAW_WORKSPACE_DIR:-/data/workspace}/skills/basht-daftra`: idempotent (content hash), staged + renamed (target is always the old or the new tree; interrupted swaps are recovered), never follows/copies symlinks, preserves the rest of the workspace, normalises modes, chowns `openclaw:openclaw` with `-h`, tolerates a missing source. **Caveat:** if `OPENCLAW_WORKSPACE_DIR` is unset the Gateway itself uses `~/.openclaw/workspace` (server.js default), not `/data/workspace`, so the skill would land where OpenClaw does not look — the repo's documented env (`.env.example`, README) sets it to `/data/workspace`; keep that variable set. The agent can edit its workspace copy; the next boot restores it. |
| `Dockerfile.broker` (new) | **Broker** (new service) | `node:26-bookworm-slim` + `gosu` + `tini` only; copies `skills/basht-daftra/scripts` (tests excluded by `.dockerignore`); user `broker` (uid 10001); `ENV PORT=8080`, `BROKER_PRIVATE_PORT=8081`, `BROKER_STATE_DIR=/broker-data`; `EXPOSE 8080` only; node-based `HEALTHCHECK /healthz`. No OpenClaw, Chromium, Homebrew, Python, curl, git, compilers; no secret/ENV key baked in. |
| `broker-entrypoint.sh` (new) | Broker | Root only to validate/prepare the volume path (absolute, normalised, not a symlink anywhere, not a system path, never `/data*`), `mkdir`, `chown -R -h broker`, `chmod 700`; then `exec gosu broker:broker node /app/scripts/daftra-broker-service.mjs`. Refuses to run the service as root (no gosu ⇒ exit). If started non-root (`RAILWAY_RUN_UID`), the volume must already be owned and writable by that uid, else exit. Prints no secrets, no env dump. |
| `railway.broker.toml` (new) | Broker | **Optional reference only** (Railway marks config-as-code deprecated; legacy services keep working until 2026-12-01). Not required, not relied on. No `[variables]`. |
| `.dockerignore` (new) | both | Keeps `.git`, `.env*`, tests and fixtures out of both build contexts. |
| `scripts/*` (new) | CI/local | `check-dockerfiles.mjs`, `test-entrypoint.sh/.mjs`, `smoke-broker-image.sh`, `check-font-layer.sh`, `verify-skill-eligibility.sh` (see §3). |
| `skills/basht-daftra/scripts/daftra-pdf-rtl.test.mjs` (new) | — | Offline Arabic/RTL PDF test with the real renderer + poppler. |
| `.github/workflows/basht-daftra-ci.yml` (reworked) | — | 5 jobs, see §3. |
| removed | — | `daftra_office_export.py`, `test_daftra_office_export.py` (see §6). |

### Service / volume / variable layout the files imply

```
 Service "openclaw" (EXISTING, unchanged wiring)            Service "basht-broker" (NEW)
   build: Dockerfile (root)                                   build: Dockerfile.broker  <- variable RAILWAY_DOCKERFILE_PATH
   volume /data (existing)                                    volume /broker-data (its OWN volume; one volume per service)
   public domain: existing (Gateway/setup)                    public domain: operator console ONLY, target port 8080
   vars (agent side only):                                    private: http://basht-broker.railway.internal:8081 (never a public domain)
     DAFTRA_BASE_URL, DAFTRA_API_KEY (READ-only role key)     vars (broker only, never on openclaw):
     DAFTRA_BROKER_URL=http://basht-broker.railway.internal:8081   DAFTRA_BASE_URL, DAFTRA_API_KEY (write-capable key)
     DAFTRA_BROKER_TOKEN                                          DAFTRA_APPROVAL_SECRET, BROKER_AGENT_TOKEN, OPERATOR_PASSWORD,
     (NO approval secret, NO write key, NO operator creds)        OPERATOR_TOTP_SEED, DAFTRA_WRITES_ENABLED (leave UNSET)
```

## 2. Railway facts relied on (and where they come from)

| Fact | Source |
| --- | --- |
| Services in one project/environment reach each other at `<service-name>.railway.internal`, plain `http://` (traffic is WireGuard-encrypted). | https://docs.railway.com/networking/private-networking · …/how-it-works |
| Environments created before 2025-10-16 are **IPv6-only** internally; newer ones resolve IPv4+IPv6. Servers should listen on `::` (the broker defaults to `::`; the CI smoke test sets `0.0.0.0` only because plain Docker bridges have no IPv6). | …/how-it-works, …/library-configuration |
| Select a non-default Dockerfile per service with the **service variable** `RAILWAY_DOCKERFILE_PATH` (relative path ok). | https://docs.railway.com/builds/dockerfiles |
| `railway.toml`/`railway.json` apply to every service built from the repo root; "Config as Code is deprecated … until 2026-12-01". The root `railway.toml` has **no** `dockerfilePath`, so the variable wins; its healthcheck `/setup/healthz` and `PORT=8080` also apply to the broker (the broker answers both `/healthz` and `/setup/healthz`). | https://docs.railway.com/reference/config-as-code |
| Each service can have **one volume**; replicas cannot be used with volumes; non-root images hit permission errors on volumes (set `RAILWAY_RUN_UID=0` or fix ownership at start — the broker entrypoint fixes ownership then drops privileges). | https://docs.railway.com/reference/volumes |
| Railway reference variables `${{service.VAR}}` exist; **template functions such as secret generation only run when a *template* is deployed**, not when typing a variable by hand — so no shell-free "generate secret" button is assumed. The broker therefore derives the TOTP key from `OPERATOR_TOTP_SEED` (Fork A's enrollment page) and the owner pastes long random strings from the iOS Passwords generator. | https://docs.railway.com/reference/variables |
| `RAILWAY_PRIVATE_DOMAIN` / `RAILWAY_PUBLIC_DOMAIN` are injected per service. | …/variables (Railway-provided variables) |

### Could NOT be verified offline
* The **exact dashboard labels/flow** on the iPhone (Railway has a mobile app and a mobile-responsive dashboard; every click path below is from memory of the web dashboard and must be eyeballed once).
* That generating a public domain for the broker targets port **8080** (the `PORT` variable) and not 8081 — check the domain's "target port" before sharing the URL; never add a domain for 8081.
* Whether the existing `openclaw` service's Railway "watch paths"/auto-deploy would also rebuild when only broker files change (harmless; optional watch patterns could reduce rebuilds).
* Real image build time/size of the **root** Dockerfile (Homebrew install + OpenClaw npm install need real network); only its apt/font layer was built here.
* IPv6-only private-network behaviour end to end (needs two real Railway services).

## 3. What each check proves — and does NOT prove

| Check (run locally with…) | Proves | Does **not** prove |
| --- | --- | --- |
| `node --test scripts/check-dockerfiles.mjs` | Static invariants: pinned bases, fonts + `COPY skills` in the OpenClaw image, launch line/OpenClaw pin unchanged, no `DAFTRA_*`/`BROKER_*`/`ENV` secrets in the OpenClaw files, broker image minimal (no openclaw/chromium/python/curl/git/installers), non-root drop, healthcheck, only 8080 exposed, `railway.broker.toml` fields, root `railway.toml` leaves the Dockerfile choice to the variable, the broker's import graph needs no test-only file, shell scripts parse (+ shellcheck), the Python exporter is gone with no stale references. | That images build or run. |
| `node --test scripts/test-entrypoint.mjs` (36 bash assertions) | `skill-sync.sh`: install, idempotence (mtime untouched), upgrade, removed-file cleanup, tamper overwrite, modes, workspace preserved, missing source tolerated, every symlink variant refused with the victim untouched, interrupted-swap recovery, `chown -R -h`. `broker-entrypoint.sh` (fake `id/gosu/chown`): path validation (11 bad paths + symlinked dir/parent), root without gosu refuses, gosu drop with the exact command, non-root branch, no secret in output. | Real uid/permission behaviour of Railway volumes. |
| `bash scripts/smoke-broker-image.sh <image>` after `docker build -f Dockerfile.broker .` (17 checks) | The **real image** starts with only FAKE env: `/healthz` and `/setup/healthz` = `ok`; `/v1/*` is 404 on the public port even with the agent token; `/console` unauthenticated ≠ 200; private port: no token / wrong token / public Host header refused; no `execute/approve/resolve/enable_writes` routes; node runs as uid 10001; `/broker-data` is `700 broker`; logs say writes are disabled; no fake secret in logs/responses/`docker inspect`; no openclaw/chromium/python/curl/git/gcc/test files in the image; no crash loop. | Railway's proxy/private network, or any behaviour with real credentials. |
| `RUN_RTL_TEST=1 bash scripts/check-font-layer.sh` | The **verbatim apt layer of the root Dockerfile** builds on the real base image; Chromium resolves *Noto Naskh Arabic*; the RTL PDF test (Arabic extractable in reading order, not mirrored, Arabic notice, embedded font = `NotoNaskhArabic`) passes inside it with `EXPECT_NOTO=1` and nothing skipped. | OpenClaw/Homebrew layers of the image. |
| `daftra-pdf-rtl.test.mjs` (plain `node --test`) | Same assertions with whatever Chromium/poppler/fonts the machine has (embeds DejaVu or Noto); **skips** with a clear reason when Chromium or poppler is missing. | — |
| `bash scripts/verify-skill-eligibility.sh <dir with node_modules/openclaw>` (Node ≥ 24.22.1 or 26) | Pinned `openclaw@2026.10.9` discovers the skill as a workspace skill; `eligible:false` + `missing.env=[DAFTRA_BASE_URL,DAFTRA_API_KEY]` without the env; `eligible:true` with fake values. | That OpenClaw *uses* it correctly in a chat. |
| CI matrix Node 24 + 26 | The whole offline suite on both supported Node lines. | — |

### Running everything locally
```
npm run test:packaging                         # static + entrypoint simulations
npm run build:broker-image && npm run smoke:broker-image
npm run check:font-layer                       # builds the Dockerfile's apt/font layer and runs the RTL test in it (several minutes, large download)
npm run verify:skill-eligibility -- <dir>      # after: mkdir <dir> && cd <dir> && npm i --ignore-scripts openclaw@2026.10.9 (use Node 26)
node --test src/*.test.mjs skills/basht-daftra/scripts/*.test.mjs
```
In a sandbox without a Docker bridge: `SMOKE_HOST_NETWORK=1`, `DOCKER_BUILD_ARGS=--network=host`, `DOCKER_RUN_ARGS=--network=host`.

### What only CI can prove
Node 24 behaviour (the sandbox had Node 22 and 26); the build on a clean `ubuntu-latest` Docker with its bridge (publishing ports, IPv4-only containers); the rest is reproduced locally (results in the parent's report).

## 4. Dashboard steps for the broker service that need NO shell (to be confirmed once on the iPhone; owner approval required — nothing here has been done)

1. **New service** from this GitHub repo, branch `feat/basht-daftra-readonly-pdf` (or `main` after merge). Name it exactly **`basht-broker`** (the private DNS name derives from it). Do **not** attach it to the OpenClaw service's volume.
2. **Variable `RAILWAY_DOCKERFILE_PATH=Dockerfile.broker`** — add it *before the first deploy* (otherwise Railway builds the root Dockerfile = a second OpenClaw).
3. **Volume**: add a new volume to `basht-broker`, mount path **`/broker-data`**.
4. **Variables** (paste long random strings from the iOS Passwords generator; ≥ 32 characters for tokens/secrets, ≥ 20 for the password): `DAFTRA_BASE_URL` (`https://<tenant>.daftra.com`), `DAFTRA_API_KEY` (the **write-capable** Daftra key, a *different* key from the agent's read key), `DAFTRA_APPROVAL_SECRET`, `BROKER_AGENT_TOKEN`, `OPERATOR_PASSWORD`, `OPERATOR_TOTP_SEED`, `BROKER_TRUST_PROXY=1` (Railway's proxy sets the client IP header — Fork A's note), and temporarily `OPERATOR_ENROLLMENT=1`. Leave **`DAFTRA_WRITES_ENABLED` unset**.
5. **Networking**: generate a public domain **for the console port 8080 only** (verify the target port); never create a domain/TCP proxy for 8081.
6. Deploy; open `https://<domain>/healthz` in Safari → `ok`. Open `/` → login page; log in with the password, open `/enroll`, add the shown setup key to the iOS Passwords app (verification codes), then **remove `OPERATOR_ENROLLMENT`** and redeploy.
7. On the **openclaw** service add only `DAFTRA_BROKER_URL=http://basht-broker.railway.internal:8081` and `DAFTRA_BROKER_TOKEN` (same value as the broker's `BROKER_AGENT_TOKEN`; do not use a `${{basht-broker.*}}` reference for anything else), plus the READ-role `DAFTRA_BASE_URL`/`DAFTRA_API_KEY`. No `RAILWAY_API_TOKEN`, no broker secret.
8. Merging this branch and redeploying `openclaw` applies the Dockerfile/entrypoint changes (fonts + skill copy) — a production change that needs its own approval; rollback = redeploy the previous deployment in Railway.
9. Rollback of the broker: stop/delete the `basht-broker` service (its volume holds only proposals/ledger/audit); writes cannot happen without it because the agent has no write key.

## 5. Unresolved risks
* Anyone with Railway dashboard access to the broker service can read its variables (out of scope for software controls).
* `skill-sync.sh` leaves the skill writable by the agent inside its workspace (it runs there anyway); integrity is restored at each boot, not continuously.
* `RAILWAY_DOCKERFILE_PATH` forgotten ⇒ a second OpenClaw build; the broker would not start. Mitigation: step 2 order; `/healthz` check.
* If both services build from the same branch, a skill-only commit rebuilds both (harmless).
* IPv4-only containers cannot bind `::` — only relevant outside Railway (CI sets `BROKER_PUBLIC_HOST=BROKER_PRIVATE_HOST=0.0.0.0`).
* The `fonts-noto-core` + Chromium layer adds image size (not measured for the full image).

## 6. Legacy Python exporter removal
Verified before deleting: `grep -rn "daftra_office_export|test_daftra_office_export|unittest discover"` found **only** the two files themselves and the CI step; no docs, `SKILL.md`, tests or `package.json` referenced them, and no Node module imported them (the Node tests use system `python3` only as an *independent reader* of the XLSX/DOCX/CSV the Node writers produce, and skip if absent). Node writers (`daftra-office.mjs`, 13 tests in `daftra-office/exports`) cover XLSX and DOCX. Removed: `skills/basht-daftra/scripts/daftra_office_export.py`, `test_daftra_office_export.py`, the CI step "Legacy Python XLSX/DOCX exporter tests". Text the parent should update: the PR description line "`daftra_office_export.py` أصبح مكررًا … لقرارك" (now done), `docs/DAFTRA_INTEGRATION_CONTRACT.md` needs no change (its "opened with openpyxl / python-docx" remains true; CI now `pip install`s both for that purpose).
