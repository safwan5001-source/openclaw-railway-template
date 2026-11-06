# BASHT × Daftra — Separate-service broker: design notes, threat model, test mapping

Status: **implemented and tested offline; NOT deployed.** Nothing here touches Railway, the Gateway, the model, the OpenClaw
service, its `/data` volume, the Dockerfile/entrypoint, or any variable. Code: `skills/basht-daftra/scripts/daftra-broker-service.mjs`,
`daftra-operator-auth.mjs`, `daftra-broker-service-client.mjs` (agent side) and the service mode of `daftra-cli.mjs`.
(Packaging — Dockerfile.broker, entrypoint, railway config, CI — is owned by the packaging work-stream.)

## 1. Why a separate service

A broker in the same container/OS-user as the agent (the Unix-socket mode in `DAFTRA_BROKER.md`) is only as strong as that OS
separation. On Railway the OpenClaw container is one service with one volume (`/data`) owned by the agent's user. A **separate
Railway service** has its own container, its own variables, its own volume, and its own network identity: the agent process
cannot read its environment, its files, or its `/proc`, and no variable of the broker service is ever referenced from the agent service.

```
 iPhone (operator, separate device/context)                    OpenClaw service (agent / Gateway)
   Safari ──https──► PUBLIC console :PORT (8080)                 env: DAFTRA_BROKER_URL, DAFTRA_BROKER_TOKEN, DAFTRA_API_KEY(read)
   password + TOTP, step-up TOTP per action                      NO write key, NO approval secret, NO operator credentials
                         │                                                  │  http://<broker>.railway.internal:8081
                  ┌──────┴───────────── BROKER SERVICE (own container, own volume /broker-data) ──────┴───────┐
                  │ public listener  PORT          : console (HTML) + /healthz + /setup/healthz              │
                  │ private listener BROKER_PRIVATE_PORT (8081, bound to ::) : /v1/propose|propose_duplicate|show|status │
                  │ holds: DAFTRA_WRITE_API_KEY, DAFTRA_APPROVAL_SECRET (HMAC), OPERATOR_PASSWORD, OPERATOR_TOTP_SEED, │
                  │        BROKER_AGENT_TOKEN, state: proposals + HMAC ledger + HMAC audit + operator state            │
                  └──────────────► https://<tenant>.daftra.com (pinned, no redirects) ─────────────────────────────┘
```

Approval therefore originates from **a different device and a different channel** (the operator's browser on the public domain,
authenticated by password + a TOTP that lives in the owner's authenticator), never from text the agent can see, generate or relay.
There is no `execute`, `approve`, `resolve` or "enable writes" route for the agent at all.

## 2. Environment contract

**Broker service (all required unless noted; all set in the Railway dashboard of THAT service only):**

| Variable | Meaning |
| --- | --- |
| `DAFTRA_BASE_URL` | `https://<tenant>.daftra.com` — the only host the service ever contacts |
| `DAFTRA_WRITE_API_KEY` (or `_FILE`) | write-capable Daftra key; exists nowhere else |
| `DAFTRA_APPROVAL_SECRET` (or `_FILE`) | ≥32 chars; HMAC key for proposals, ledger, audit |
| `BROKER_AGENT_TOKEN` (+ `BROKER_AGENT_TOKEN_PREVIOUS` during rotation) | ≥32 chars; the agent-side credential (authentication only) |
| `OPERATOR_PASSWORD` | ≥20 chars |
| `OPERATOR_TOTP_SEED` | ≥32 chars random; the TOTP key is **derived** from it (HKDF-SHA256 → 20 bytes → base32) so no shell/base32 tool is needed |
| `BROKER_STATE_DIR` | default `/broker-data`: a volume mounted ONLY on this service (refuses symlink / group-or-other-writable / other-readable / foreign-owner dirs) |
| `RAILWAY_PRIVATE_DOMAIN` (Railway-provided) and/or `BROKER_PRIVATE_HOSTS` | Host names accepted on the private API (anything else ⇒ uniform 404) |
| `DAFTRA_WRITES_ENABLED` | **unset ⇒ writes impossible** (default). Only the literal `1` enables; no request can change it |
| `PORT` (Railway-provided, default 8080) / `BROKER_PRIVATE_PORT` (8081) | public console port / private API port; must differ |
| `BROKER_PUBLIC_ORIGIN` (recommended) | `https://<public-domain>`; if set, console POSTs must carry exactly this Origin |
| `BROKER_TRUST_PROXY=1` | use `X-Real-IP` (valid IP only) for lockout bucketing — set on Railway where the edge proxy sets it |
| `OPERATOR_ENROLLMENT=1` (temporary) | enables `/enroll` once to show the derived authenticator key; remove afterwards |
| `OPERATOR_STATE_RESET=1` (temporary) | one-shot recovery if the operator state file fails authentication |
| `BROKER_MAX_PENDING` (20), `BROKER_PROPOSE_PER_MIN` (10), `BROKER_RATE_PER_MIN` (60), `DAFTRA_MAX_WRITES_PER_HOUR` (20) | quotas |
| `RAILWAY_PUBLIC_DOMAIN` (Railway-provided) / `BROKER_PUBLIC_DOMAINS` | names that identify "this is the public edge" for the exposure alarm |

**Agent service (OpenClaw)** — exactly: `DAFTRA_BASE_URL`, `DAFTRA_API_KEY` (role-limited **read** key), `DAFTRA_BROKER_URL`
(`http://<broker-service>.railway.internal:8081`), `DAFTRA_BROKER_TOKEN` (= broker's `BROKER_AGENT_TOKEN`). It must NOT hold: `DAFTRA_WRITE_API_KEY`,
`DAFTRA_APPROVAL_SECRET`, `DAFTRA_WRITES_ENABLED`, `OPERATOR_*`, `BROKER_AGENT_TOKEN*`, `BROKER_STATE_DIR`, any `RAILWAY_API_TOKEN`/`RAILWAY_TOKEN`
(`capabilities` warns when any of these is present). Do not use Railway reference variables that expose broker secrets to the agent service.

## 3. Routes

| Port | Route | Auth | Purpose |
| --- | --- | --- | --- |
| private | `POST /v1/propose`, `/v1/propose_duplicate`, `/v1/show`, `/v1/status` | Host in allowlist, no edge headers, `Authorization: Bearer <token>` | propose / read / poll. Replies never contain phrases, codes or MACs |
| private | everything else (all other methods/paths, `/console`, `/login`, …) | — | 404/405 |
| public | `GET /healthz`, `GET /setup/healthz` | none | plain `ok` (the repo's root `railway.toml` health path is `/setup/healthz`) |
| public | `GET /`, `POST /login` | password + TOTP | sign-in (single-use form token, Origin check) |
| public | `GET /console`, `GET /proposal/<id>` | session | list / full review (same content as the operator tool, HTML-escaped) |
| public | `POST /proposal/<id>/approve`, `/reject`, `/resolve` | session + CSRF + Origin + **fresh TOTP** + request-hash echo | the only way a write happens |
| public | `GET\|POST /enroll` | only when `OPERATOR_ENROLLMENT=1`, password | show the derived authenticator key once |
| public | `POST /logout` | session + CSRF | |
| public | `/v1/*` | — | 404 (never served on this port) |

## 4. If the owner mis-targets the public domain at the private port

Railway shows a list of ports when a service listens on several; a mis-tap could point the public domain at **8081**. The private
API is therefore safe even if reachable from the internet:
1. **Host allowlist** — only `RAILWAY_PRIVATE_DOMAIN` / `BROKER_PRIVATE_HOSTS` (loopback only with a test flag). A request through the public edge carries the public Host ⇒ uniform `404 Not Found` **before** auth or body parsing.
2. **Edge-header refusal** — any of `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `X-Railway-*`, `CF-*`, `True-Client-IP`, `Via`, … ⇒ same 404 (private-network calls never carry them), even with a spoofed private Host.
3. **Loud alarm** — log line `ALERT PRIVATE_API_REACHABLE_VIA_PUBLIC_DOMAIN`, audited event `private_api_via_public`, and a red banner in the console until restart.
4. The Bearer token requirement, per-peer failure throttling, per-token rate limits and the pending-proposal quota remain the last layer. Even a full bypass of 1–4 only buys `propose/show/status`.

**Owner instruction:** choose **`PORT` / 8080** as the domain's target port. Picking 8081 does not expose a write path (see above) but the console would then not be reachable and the banner would light up.

## 5. Threat model → mitigation → test

(Tests live in `daftra-broker-service.test.mjs` = E2E, `daftra-broker-service-adversarial.test.mjs` = ADV, `daftra-operator-auth.test.mjs` = AUTH.)

| STRIDE / Railway concern | Mitigation | Tests |
| --- | --- | --- |
| **Spoofing the agent** (token theft, token confusion, rotation) | Bearer token ≥32 chars, constant-time compare of SHA-256 digests, exactly one `Authorization` header, no query/cookie/body tokens, `_PREVIOUS` for rotation, failure flood limiter | ADV `TOKEN CONFUSION…`, `AUTH FAILURE FLOOD…` |
| **Authentication ≠ authorization** (a leaked agent token) | the token only buys `propose/show/status`; it can create *proposals* (quota-capped) but nothing can execute without the operator | ADV `COMPROMISED AGENT: no route exists…`, `RATE LIMITS and PENDING QUOTA…` |
| **Unauthenticated callers / any service in the Railway project** (private network is reachable by every service in the environment) | Host allowlist + token; no unauthenticated route besides `/healthz` (static `ok`) | ADV `private API with an unknown Host…`, `PORT SEPARATION…` |
| **Public edge reaches the private port** | Host + edge-header refusal, alarm | ADV `PRIVATE API REFUSES the public edge…` |
| **Spoofing the operator** (stolen password, brute force, credential stuffing) | password ≥20 chars **and** TOTP; uniform failures; exponential lockout per client + global, persisted across restarts; TOTP replay window persisted | AUTH `login needs BOTH factors…`, `LOCKOUT…`; ADV `LOGIN…`, `LOCKOUT over HTTP…` |
| **Agent impersonating the operator / relaying approval** | no phrase exists in service mode; approval is a console action with a fresh TOTP bound to the proposal id + request hash; the agent has no channel to the console | E2E `END TO END…`; ADV `STEP-UP…` |
| **Replay / duplicate execute** | single-use proposals (claim lock), hash lock, HMAC-chained ledger, monotonic TOTP step, 15-min proposal TTL, no blind retry | ADV `CONCURRENT approvals of ONE proposal…`, `…TWO proposals with the SAME request…`, `REPLAY…`; AUTH `REPLAY…` |
| **CSRF / clickjacking / session attacks** | `__Host-` cookie (`Secure; HttpOnly; SameSite=Strict`), per-session CSRF token, mandatory same-origin `Origin`, single-use login form tokens, new session id at login, idle 10 min / absolute 30 min, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'` | ADV `CSRF…`, `SESSIONS…`, `LOGIN…` |
| **Tampering with the request** (agent edits what the human approves) | request hash echoed on the page and re-checked at approval; proposals HMAC-signed incl. tenant; body-shape allowlist; all existing write guards | ADV `STEP-UP…` (wrong-proposal hash), E2E |
| **Tampering with state** (proposals, ledger, audit, operator state, state dir) | HMAC everywhere, chain verification on every ledger/audit append, state-dir ownership/mode/symlink checks, fail-closed | ADV `LEDGER / PROPOSAL / OPERATOR-STATE / AUDIT tampering…`, `STATE DIR…`, `OPERATOR_STATE_RESET…`; AUTH `STATE TAMPERING…` |
| **Cross-tenant / foreign state** | `tenant` signed into proposals; refused if different from the pinned tenant or signed with another secret | ADV `CROSS-TENANT / FOREIGN STATE…` |
| **SSRF** | broker contacts only the pinned `*.daftra.com` tenant over https, `redirect:'manual'`; agent supplies only enums/ids/validated fields; the agent **client** only accepts `http://<name>.railway.internal:<port>` | ADV `SSRF…`; E2E `CLIENT-side SSRF guard…` |
| **Repudiation** | HMAC-chained `audit.jsonl` (login ok/fail with truncated IP hash, step-up fail, approve/reject/resolve with session short-id, agent auth failures, exposure alerts) + JSON stdout lines; audited **before** acting so an audit failure blocks the write | E2E `END TO END…`; ADV `AUTH FAILURE FLOOD…`, `…audit tampering…` |
| **Information disclosure** | secrets scrubbed from every response/log; uniform 404 for refused callers; "not configured" pages never name missing variables; no secrets in ledger/proposals/audit | ADV `SECRETS never appear…`, E2E `NOT CONFIGURED…` |
| **Injection into the console** | every dynamic value HTML-escaped after control/bidi escaping, strict CSP (no scripts, no external resources), form-action self | ADV `XSS / UI SPOOFING…` |
| **DoS** | 256 KiB / 16 KiB body caps, header/request timeouts enforced every 2 s, `maxRequestsPerSocket`, per-peer/per-token rate limits, pending quota, session cap | ADV `PROTOCOL ABUSE…`, `RATE LIMITS…` |
| **Elevation: enabling writes** | `DAFTRA_WRITES_ENABLED` read once from the service's own env; no route/header/body can change it; unconfigured service refuses writes | ADV `COMPROMISED AGENT…`; E2E `WRITES DISABLED by default…`, `NOT CONFIGURED…` |
| **Leaked read key** | read key authenticates nothing on the broker (not a bearer, not accepted) and cannot write | ADV `TOKEN CONFUSION…` |

## 6. Operator flow (iPhone, no shell)

1. Open the broker's public domain → sign in (password + 6-digit code).
2. `Proposals` → open the one the agent created → read the full review (what is sent, original-vs-proposed, duplicates that were overridden, checks, warnings).
3. Wait for a **new** code in the authenticator (it must differ from the one used to sign in), type it, tap **Approve & send** (or **Reject**).
4. The page shows the outcome; the agent can poll `status`. Ambiguous outcomes are resolved on the same page after checking Daftra.

Enrollment (once): set `OPERATOR_ENROLLMENT=1`, open `/enroll`, enter the password, copy the **setup key** into the iOS Passwords app
(verification code → "Enter Setup Key"; time-based, 6 digits, 30 s, SHA-1), then delete the variable and redeploy.

## 7. Audit retention

`audit.jsonl` and the ledger live on the broker's own volume (kept across redeploys; take Railway volume backups); the same events go to
stdout (Railway log retention applies, plan-dependent). `readAudit({stateDir, secret})` verifies the chain. Neither file contains secrets,
amounts, or names.

## 8. Residual risks (honest)

- **Anyone with Railway dashboard / variable access to the broker service** can read the write key, approval secret and operator credentials. Railway project-member access control is outside this code: limit it, and do not give the agent a Railway token.
- **A compromised operator phone / Passwords app** (password + TOTP seed) = full approval power. A human who approves without reading the review defeats the gate.
- **Private networking reaches every service of the Railway environment**: any other service you add can call the private API; only the bearer token + quotas stand between it and `propose`. Keep the environment minimal.
- **Plain http inside the private network** (Railway encrypts it with WireGuard; there is no extra TLS or mTLS here). The bearer token is therefore not secret from other services that can sniff nothing but is also not tied to a client identity.
- **IP-based throttling** depends on Railway's proxy setting `X-Real-IP`; with `BROKER_TRUST_PROXY` unset, throttling buckets by the (proxy) socket address, which makes the lockout effectively global (safe but coarser).
- **TOTP** is RFC 6238 SHA-1 (what authenticator apps support); no WebAuthn/passkey yet. A phished real-time (password + code) relay is not defeated.
- **Single replica** (a volume forbids replicas); redeploys cause a short outage. Sessions and rate-limit counters are in memory (lost on restart; lockouts and replay counters are persisted).
- The broker re-uses the existing proposal/ledger/write libraries: their documented limits (undocumented Daftra semantics, no tail-truncation detection of the ledger beyond the 15-minute TTL + claim locks) still apply.
- Not proven here: behaviour of Railway's edge (header names it adds beyond those listed), real iOS enrollment UX, load behaviour.
