# BASHT app bridge (C2 + C4 + M + B5–B7)

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

| `GET /app/v1/automations` | BASHT's scheduled jobs, fixed shape; cached 20 s | RPC `cron.list {includeDisabled, limit: 200}` |
| `GET /app/v1/automations/:id/runs` | That job's recent finished runs (≤ 20), short summaries | RPC `cron.runs {scope: "job", id}` |
| `POST /app/v1/automations/:id/run` | Runs an owner-created job now | RPC `cron.run {id, mode: "force"}` (admin, CLI) |
| `POST /app/v1/automations/:id/enabled {enabled}` | Enables or disables an owner-created job | RPC `cron.update {id, patch: {enabled}}` (admin, CLI) |
| `GET /app/v1/usage` | App-session tokens/cost (30 days, today) and all-agent 30-day totals; cached 60 s | RPC `sessions.usage {key: app, range: "30d"}` + `usage.cost` |
| `GET /app/v1/memory/status` | Index state and memory-file counts, MEMORY.md / USER.md presence; cached 30 s | RPC `memory.status` + `agents.files.list` |
| `GET /app/v1/memory/search?q=&page=` | Search over memory files only (never transcripts), ≤ 10 per page, 3 pages | RPC `memory.search {sources: ["memory"]}` |
| `GET /app/v1/memory/item?ref=&part=` | One hit's file text, by an opaque ref this bridge issued (30 min) | RPC `memory.get {reference}` |
| `GET /app/v1/memory/file?name=&part=` | `MEMORY.md` or `USER.md` only, read-only | RPC `agents.files.get` |
| `GET /app/v1/capabilities` | Channels, skills ready/missing, effective tools of the app session, plugins; cached 60 s | RPC `channels.status`, `skills.status`, `tools.effective`, `tools.catalog` (10 min), `plugins.list` |

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

## App control (B5–B7): `src/app-control.js`

Mounted by the bridge after its token check (same gate, same JSON 404 for unknown paths). Every gateway call goes through the
wrapper's `gatewayCall`, whose allowlist (`APP_BRIDGE_RPC` in `server.js`) now holds exactly the read methods above plus
`cron.run` and `cron.update`.

- **Fixed shapes.** Each route rebuilds its rows. Never passed on: server paths (`storePath`, `sessionFile`, `filePath`,
  `baseDir`, `workspace`, `dbPath`), session keys, run ids, delivery targets, account ids or phone numbers, payload commands and
  working directories, managed-job prompts, `config.get`, raw engine error text. Free text that does reach the app (run summaries,
  last errors, skill descriptions) has absolute paths and secret-shaped tokens replaced by `…`.
- **Two writes only, built by the bridge.** `cron.run {id, mode: "force"}` and `cron.update {id, patch: {enabled}}`. The id must
  be one `cron.list` returned; engine-managed jobs (`declarationKey`, e.g. memory "dreaming") answer 400 `system_job`; a job
  already running answers 409 `busy`. The wrapper re-checks the exact params (`validateControlRpc`) before it spawns the CLI. The
  answer to enable/disable is the engine's state re-read after the write, never the requested one. Writes run one at a time.
  Not offered: create, edit, delete, schedule changes.
- **Memory is read-only.** Search requests `sources: ["memory"]` (session transcripts can hold other people's messages). A hit's
  engine reference stays in the bridge; the app receives an opaque 24-hex `ref`, valid 30 minutes. The engine re-checks that
  the path is an allowed memory file. Text is paged in parts of 20,000 characters (at most 10). Only `MEMORY.md` and `USER.md`
  can be opened directly.
- **Capabilities are read-only.** Channels report `configured / linked / running / connected / lastConnectedAt` and an issue
  *kind* only. Skills: `ready`, `missing` (missing tool and environment-variable names, config count; never values), and
  `unavailable` (disabled, blocked, other platform). Tools: the app session's effective tools grouped by the engine's own
  catalog groups. Plugins: enabled, needs-setup and failed names. No toggles.
- **Cost control.** Each `gateway call` spawns the CLI (~1.6 s, ~1.5 s CPU), so reads are cached (20–60 s, catalog 10 min),
  parallel reads of one view share a call, and this module never runs more than two engine calls at once. A cold
  `/capabilities` takes ~12 s in the lab; warm reads are instant.
- **Errors.** No `gatewayCall`: 503 `not_available`. Engine unreachable: 502 `engine_unavailable`. A gateway refusal on a write:
  400 `rejected`. One failing section of `/capabilities` or `/usage` is `null`; the others still answer.

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

App control (B5–B7, lab-cc: its own state, wrapper 8499 / gateway 19190, the real OpenClaw 2026.11.10, mock model; then the app
over BFF → API → HTTPS bridge, 22/22 checks):
- Three owner jobs created with `openclaw automations add` plus the managed "Memory Dreaming Promotion" job: `/automations`
  listed all four in the fixed shape; no paths or session keys in the response.
- Disable → enable from the Tasks screen reached the engine (`cron.list` showed the change); "run now" produced a new finished
  run in `cron.runs` (status, duration, summary); running the managed job answered `system_job`.
- `/usage`: app session 11,352 tokens; the unpriced `xai/grok-3-fast` made the cost "unknown", not $0.
- Memory (`memory.search.provider: "none"`, keyword index): status `ok` with 6 memory files; a search for «النخبة» returned
  `MEMORY.md` and `2026-11-26.md`; the opaque ref opened the daily file; `AGENTS.md` and a traversal path were refused.
- `/capabilities`: 25 of 58 skills ready, 24 with missing requirements, 66 effective tools in 17 groups, 47 enabled plugins;
  no channel in the lab (WhatsApp shows "not linked"). No `/tmp/` path or redaction marker in any response.

