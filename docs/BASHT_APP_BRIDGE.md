# BASHT app bridge (C2 + C4 + M + B0/B3)

How the BASHT app (`safwan-smart-assistant`) reads the owner's conversations and chats with BASHT live. The code is in
`src/app-bridge.js` and the tests are in `src/app-bridge.test.mjs`.

## Path

```
iPhone ─► Next BFF (owner cookie) ─► FastAPI (HMAC · audit · limits) ─► HTTPS ─► wrapper /app/v1/* ─► loopback gateway
```

The app holds **only** `BASHT_APP_TOKEN`. It never gets `OPENCLAW_GATEWAY_TOKEN` or `SETUP_PASSWORD`.

## Surface (Bearer `BASHT_APP_TOKEN`)

| Route | What it does | Gateway call (made by the wrapper) |
|---|---|---|
| `GET /app/v1/status` | Liveness check plus the app session key | — |
| `GET /app/v1/sessions` | The conversations the owner may read | `sessions_list` |
| `GET /app/v1/history?key=&limit=&offset=` | Text messages of one allowed conversation | `sessions_history` |
| `POST /app/v1/send {message}` | Starts **one** owner turn and returns `runId` at once | `/v1/chat/completions` (stream), session `app:owner` |
| `GET /app/v1/runs/:id` | Live text and status (`running`, `done`, `error` or `stopped`) | — |
| `POST /app/v1/runs/:id/stop` | Stops that turn | — |
| `GET /app/v1/models` | The models the agent may use, in a fixed shape (below); cached 60 s | RPC `models.list` (`agentId: main`, app session, view `default`) |
| `GET /app/v1/model` | The app session's model, thinking level, fast mode, token usage, last fallback and last-run latency | RPC `sessions.describe` + `sessions_history` |
| `POST /app/v1/model {model}` | Pins a listed model on the app session; `"default"` clears the pin | `sessions` tool `patch` (app session) |
| `POST /app/v1/thinking {level}` | Sets a thinking level the **current** model offers; `"default"` clears it | RPC `sessions.patch {thinkingLevel}` (app session) |
| `POST /app/v1/fast {mode}` | `"on"`, `"off"` or `"default"`; `"on"` only if the current model supports fast mode | RPC `sessions.patch {fastMode}` (app session) |
| `GET /app/v1/events?after=<id>&wait=<s>` | B0 event feed: ring records newer than `after` (≤100, oldest first); `wait` ≤ 25 s long-polls | persistent link (events) |
| `GET /app/v1/approvals` | B3: pending exec, plugin and system-agent approvals, fixed shape | link: `exec.approval.list`, `plugin.approval.list`, `openclaw.approval.list` |
| `GET /app/v1/approvals/history?limit=N` | B3: last decided approvals (≤50) | link: `approval.history` |
| `POST /app/v1/approvals/:id {decision}` | B3: `"allow-once"` or `"deny"` only | link: `approval.get` (kind), `approval.resolve` |

`/runs/:id` also returns `firstTokenMs` and `totalMs`, measured by the bridge from the moment the turn started. Assistant messages in
`/history` carry `provider` and `model`. The notice OpenClaw writes when it switches models carries
`fallback: {from, to, reason}`; that notice has `provider: "openclaw"` and `model: "delivery-mirror"`.

## Model control (M)

The wrapper passes in `gatewayCall(method, params)`. It runs `openclaw gateway call <method> --json --port <internal port>`. The CLI
reads the gateway token from its environment, never from argv, and the wrapper permits only `models.list`, `sessions.describe` and
`sessions.patch`. The bridge always fills in the session key itself (`agent:main:app:owner`). A `sessionKey` or `key` in a request
body is ignored.

- **Catalog.** The bridge uses view `default` because it is the agent's `modelPolicy.allow` list when one is configured, and the
  catalog the gateway would use anyway when none is.
  - `configured` also keeps fallback rows that may not be valid manual choices.
  - `all` ignores the policy entirely.

  Each row is rebuilt as `{id, name, provider, providerName, available, unavailableReason, unavailableUntil, contextWindow, reasoning,
  thinkingLevels, thinkingDefault, supportsFastMode, supportsTools, input, recommended, selectable}`:
  - `id` is the selectable `provider/model` ref.
  - `thinkingLevels` is a list of level ids.
  - `selectable` is `available` and not `manualSelectionAllowed: false`.

  Nothing else from upstream is passed through: no endpoints, keys, runtime objects or decision models.
- **Selecting a model.** The value must be an `id` from that list, and the row must be `available` and `selectable`. Anything else
  returns 400 (`unknown_model`, `model_unavailable` or `model_not_selectable`) and never reaches the engine. The gateway checks its
  own policy again; if it refuses, the bridge returns 400 `rejected`.
- **Thinking and fast mode.**
  - A thinking level must be one the session's current model lists, read fresh from `sessions.describe`.
  - The gateway accepts `fastMode` on **any** model; the lab confirmed this. So the bridge allows `"on"` only when the current
    model's catalog row has `supportsFastMode: true`. `"off"` and `"default"` are always allowed, so an old override can be
    cleared after a model change.
- **State.** `GET /model` returns:
  - `model {id, provider, model, source: "override" | "fallback" | "default"}`, from `modelOverrideSource`: `"user"` is the
    owner's pin (`override`); `"auto"` is OpenClaw's temporary runtime-fallback pin (`fallback`, never shown as the owner's
    choice). Pinning the configured primary counts as `default`.
  - `thinking {level, default, effective, levels}`.
  - `fast {supported, enabled, source}`.
  - `usage {inputTokens, outputTokens, contextTokens, contextWindow}`, from the last run.
  - `lastReply {provider, model}`: who actually answered last.
  - `fallback {from, to, reason}`: the last model-switch record for that reply's run, or `null`. OpenClaw's
    `phase: "restored"` notice (the selected model is back) is not a fallback and is never reported as one.
  - `lastRun {runId, status, firstTokenMs, totalMs}`.
- **Concurrency:** settings writes (`POST /model|thinking|fast`) run one at a time, so two devices changing settings together
  never interleave (each is validated against the model it actually lands on). A new turn (`/send`) starts only after an
  in-flight settings write has finished. While a turn is running (the engine's `hasActiveRun`, or this bridge's own running
  turn — the engine flag can lag at the start of a turn) writes answer 409 `busy`: the turn would overwrite the change when it
  saves the session.
- **Switching model** clears a thinking level or fast mode the NEW model does not offer (the gateway would keep it stored and
  silently ignore it); `POST /model` reports this as `reset {thinking, fast}` and re-checks once ~1.5 s later, because
  OpenClaw can save the session again from work that started earlier.
- **Errors.** A gateway that answers a patch with an error is a refusal: 400 `rejected`. Unknown `/app/v1/*` paths end in the
  bridge (JSON 404) and never reach the gateway proxy. If the engine is unreachable or still starting, the bridge returns 502 `engine_unavailable` and the caller retries.
  Right after a gateway start the `sessions` tool briefly returns 400 (`agent-database-inspection-pending`); the bridge reports
  that as 502 too. Without `gatewayCall` the model routes return 503.

### Deliberately not offered

- **No "auto" model mode.** OpenClaw has none, only the configured primary plus fallbacks. Inventing one would mean the bridge
  picking models on its own.
- **No changes to defaults or fallbacks.** Only the app session is ever patched, and nothing writes `openclaw.json`.
- **No per-model latency or rate-limit metrics.** OpenClaw has none without an extra plugin. The bridge reports only its own
  measurements for app turns, plus the `unavailableReason`/`unavailableUntil` that the catalog itself reports.
- **No `"auto"` fast mode** (`fastMode: "auto"` is a per-turn `chat.send` option). There is also no context-window or
  runtime override.
- **No parsing of `session_status` text.** Its `↪️ Fallback` line appears only while a fallback is still active.
  `sessions.describe` and the transcript record give the same facts in structured form.

## Rules

- **Off by default.** The bridge is enabled only when `BASHT_APP_TOKEN` is at least 32 characters long. Without it, `/app/v1/*` returns 404 and nothing else changes.
  - When the bridge is on, the wrapper enables the gateway's chat endpoint once at boot (`openclaw config set gateway.http.endpoints.chatCompletions.enabled true`).
  - That endpoint still requires the gateway token. Anonymous public calls get 401 from the gateway, as before.
- **Owner turns, own session.**
  - Turns from the app use the same agent, the same shared memory, the same tool policy and the same approvals as the Control UI. The Daftra broker's TOTP approvals stay as they are.
  - Turns always run in `agent:main:app:owner`, whatever the caller sends, never in the WhatsApp chat.
- **Reads are limited to the owner's own conversations.** Readable sessions are:
  - the app session;
  - the main session;
  - the owner's direct WhatsApp chat or chats (owners come from `commands.ownerAllowFrom`).

  Groups, other people's chats, subagents and cron jobs are never listed or read. History returns text parts only: no tool payloads and no thinking. OpenClaw caps each message at 4,000 characters in `sessions_history`.
- **Turns are robust.**
  - The wrapper holds the upstream request, so a turn keeps running if the phone disconnects.
  - Only one turn runs at a time; a second request gets 409.
  - A turn times out after 15 minutes.
  - The wrapper keeps the last 20 runs in memory.
- **Secrets.**
  - `BASHT_APP_TOKEN` is removed from `process.env` after startup, like `SETUP_PASSWORD`.
  - Comparison is timing-safe.
  - After 20 failed authentications per minute the bridge returns 429.

## Enable and roll back

1. Generate a long random token and set `BASHT_APP_TOKEN` on the OpenClaw service. Set the same value on the app's `safwan-api` service.
2. To roll back, remove the variable. The bridge turns off on the next deploy. The chat endpoint stays enabled in the config, but it is still protected by the gateway token.

## Verified (lab: the real wrapper in front of the real OpenClaw 2026.11.10 gateway, mock model)

Model control (lab-m):
- Two mock models, `mock/echo` (primary, reasoning) and `mock/echo2` (fallback), plus `xai/grok-3` pointed at the mock, all
  behind `modelPolicy.allow`.
- `gateway call` with the env token connected as `role=operator auth=token`; no pairing was needed.
- `/models` returned the three allowed models. `mock/echo3` is outside the policy: view `all` lists it, `/models` does not, and
  selecting it returns 400; the gateway also refuses it directly.
- Pinning `mock/echo2` changed only the app session. `openclaw.json` was byte-for-byte unchanged.
- Thinking `low` reached the provider as `reasoning_effort: "low"`. Levels not offered by the model returned 400.
- Fast mode `on` (`xai/grok-3`) made the provider receive `grok-3-fast`; `off` sent `grok-3` again. On mock models `on` returned 400.
- With the primary forced to return HTTP 500, the turn was answered by `mock/echo2` after OpenClaw's retries (about 90 s).
  `/history` and `/model` showed `model: echo2` and `fallback {from: mock/echo, to: mock/echo2, reason: server_error}`.
  `/runs/:id` reported `firstTokenMs` and `totalMs` (about 1 s on a healthy turn, about 86 s with the fallback).

Chat and conversations (C2 + C4):

- The token gate works: no token returns 401, and the gateway token sent from outside returns 401.
- The chat endpoint is enabled at boot.
- A turn runs in `agent:main:app:owner` and polling returns its text.
- Sessions and history follow the allowlist.
- Anonymous public `/tools/invoke` and `/v1/chat/completions` still return 401.
- No token appears in the logs.

## B0: the persistent gateway link (`src/gateway-link.js`)

One loopback WebSocket from the wrapper to its own gateway, opened only when the bridge is on. It replaces CLI spawns for reads
(`models.list` and `sessions.describe` now take ~0.5 s instead of ~1.6 s, with the CLI as fallback when the link is down) and carries
the events the app needs. `sessions.patch` (a write) stays on the CLI.

- **Protocol:** gateway protocol v4 as documented (`connect.challenge` → `connect` → `hello-ok`), Node's built-in WebSocket. No new
  dependency: `@openclaw/gateway-client@2026.11.10` (MIT, ~290 KB, but pulls `@openclaw/gateway-protocol` ~10 MB with `typebox`, plus
  `ws`) is not needed for a device-less backend client.
- **Identity and scopes:** `client {id: "gateway-client", mode: "backend"}` on direct loopback with the shared gateway token. This is the
  documented trusted local backend path (`docs/gateway/protocol/handshake.md`): no device identity, no pairing record, no device token,
  and the gateway grants exactly the requested scopes. **Verified in the lab:** `hello-ok.auth.scopes` = the requested set, no
  `PAIRING_REQUIRED`. If a gateway ever grants fewer scopes than requested, the link closes itself and reports `scopes_not_granted`.
- **Scopes requested:** `operator.read`, `operator.approvals`, `operator.admin`, cap `approvals`. **Admin is required:** the gateway
  shows gateway-owned approvals (turns from the app's HTTP endpoint, WhatsApp, cron) only to admin connections
  (`isApprovalRecordVisibleToClient`); a non-admin `operator.approvals` client saw an empty list and the approval was denied at once as
  `no-approval-route` (lab). The wrapper already holds the gateway token (full authority through its CLI), so the link adds no
  authority; `request()` refuses every method outside a fixed list (`LINK_METHODS`: the reads above, the approval lists/get/history and
  `approval.resolve`). Everything else is refused locally, before anything is sent.
- **Behaviour change:** while the link is up it is an approval client (cap `approvals`). An exec that needs approval now **waits** for
  an answer (up to the approval's expiry, 30 min by default) instead of being denied at once by `askFallback`. Without any connected
  approval client the gateway answers "Headless runs cannot wait for interactive exec approval" (lab, before B0).
- **Reconnect:** backoff 1, 2, 4, 8, 15, 30 s (±20 %); a socket with no frame for 2.5 tick intervals is replaced; requests in flight
  fail fast with `link_down`. After every (re)connect the pending approvals are read again, and any that arrived while the link was down
  enter the ring once. Health is in `GET /app/v1/status` → `link {state, since, lastUpAt, reconnects, lastError, pendingApprovals}`.
- **Event ring:** 500 records in memory, ids increasing (seeded with the boot time, so they keep increasing across restarts) plus an
  `epoch`. Only fixed fields:
  - `approval.requested {approval: {id, kind, summary ≤300, title, host, agentId, session, isApp, warning, createdAt, expiresAt, decisions}}`
  - `approval.resolved {approvalId, kind, decision, session}`
  - `chat.final` / `chat.error {session: "app", runId, seen}`: the app session only; `seen` = the app polled the bridge in the last 20 s
  - `cron.finished` / `cron.failed {jobId, name, status}`
  - `gateway.up {downForMs}` / `gateway.down`

  `session` is a label (`app`, `main`, `whatsapp`, `cron`, `other`), never a raw key (WhatsApp keys carry phone numbers). No cwd, env,
  resolved paths, reply text or error text.

## B3: approvals

- `POST /app/v1/approvals/:id` accepts `{"decision": "allow-once" | "deny"}` only; `allow-always` (a standing grant) is refused with
  `bad_decision`. The id must match `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`. The kind comes from the gateway's own record (live event or
  `approval.get`), never from the caller. `approval.resolve` is first-answer-wins: an approval answered elsewhere (Control UI, WhatsApp)
  returns `applied: false` with the recorded decision. Refusals: 404 `not_found` (unknown/expired), 400 `rejected`, 503 `link_down`.
- **Turn timeout:** a turn whose app-session approval is pending is not stopped at 15 minutes; its timer is re-armed until that approval
  expires, plus 60 s.
- **Verified (lab-la, real 2026.11.10 gateway, `tools.exec.mode: "ask"` in the lab config only, mock model calling `exec`):** the
  request appeared in `/approvals` and as an event; `allow-once` ran the command and the same turn continued with its output; `deny`
  returned "user-denied" to the agent and the command did not run; a second answer returned `applied: false`; `allow-always` → 400.

## Production prerequisites (B0/B3)

- Nothing new to configure: the link uses the existing `OPENCLAW_GATEWAY_TOKEN` and `INTERNAL_GATEWAY_PORT` (loopback) and starts only
  with `BASHT_APP_TOKEN`.
- Whether approvals happen at all depends on the production exec policy (`tools.exec.mode` / host approvals). OpenClaw's default for a
  gateway host is `full` with ask `off`: then there are no exec approvals and the inbox stays empty. Check with
  `openclaw approvals get --gateway` (read-only) before relying on the inbox.
- With the link up, `ask` turns wait for an answer instead of failing at once; answer them from the app (or Control UI / `/approve`).
