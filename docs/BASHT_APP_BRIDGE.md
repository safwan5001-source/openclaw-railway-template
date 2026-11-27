# BASHT app bridge (C2 + C4 + M + B1/B2)

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
| `POST /app/v1/send {message, images?}` | B2: up to 8 photos ride on the same turn as `image_url` data parts | `/v1/chat/completions` (as above) |
| `GET /app/v1/history?key=&before=\|around=` | B1: earlier rows (also across a reset) or a window around one message | RPC `chat.history {messageId}` (anchored) |
| `POST /app/v1/new` | B1 «محادثة جديدة»: a fresh context for the app session; nothing is deleted | RPC `sessions.reset {key: app session, reason: "new"}` |
| `GET /app/v1/search?q=` | B1: search the readable conversations only | RPC `sessions.search {sessionKeys: readable keys}` |
| `GET /app/v1/media?key=&msg=&ref=` | B2: one image/file of one message of a readable conversation (bytes) | RPC `artifacts.download`, or an engine-owned file |

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

## Chat basics and media (B1 + B2)

Code: `src/app-bridge-convo.js` and `src/app-bridge-media.js`. Tests: `src/app-bridge-media.test.mjs`. The wrapper's CLI allowlist
adds `sessions.reset`, `sessions.search`, `chat.history` and `artifacts.download`; only `artifacts.download` gets a 32 MB output
buffer. Every call is built by the bridge with the app session key or a key that passed `isReadable`.

- **Photos in.** Only `/send` takes a larger body (19 MB); every other route keeps 64 kB. `images: [{mime, data}]` (base64, no
  `data:` prefix). Limits follow the engine: at most 8 images, 10 MB each, 14 MB per message (so the request stays under the
  engine's 20 MiB cap). MIME must be on the engine's list and the first bytes must match it. Refusals are `too_many_images`,
  `image_too_large`, `images_too_large` and `unsupported_image`. The app re-encodes photos on the device first (no EXIF or GPS).
  A text-only model gets no image at all (lab: the engine drops it silently), so the app warns before sending.
- **Rows.** `/history` rows carry `id` (`__openclaw.id`) and `media`. A reset boundary is `{role: "system", kind: "reset"}`.
  `MEDIA:` lines (the engine's rule: standalone, outside code) and `[media attached: …]` markers are removed from `text` and
  become `media: [{ref, kind: image|file, name, mime, size, available}]`, or `{kind: "link", url}` for a public https URL.
  A `ref` is `sha256(key, messageId, position, source)`. Paths and artifact ids never leave the bridge.
- **`/media`.** The ref is resolved from the bridge's bounded ref cache, or else by re-reading THAT message (anchored
  `chat.history`), so it only works for the message it came from.
  - Image blocks are fetched with `artifacts.download` (image types only, bytes must match).
  - Allowed roots are resolved per request (a root created after the wrapper started is honoured).
  - Files are served only if their realpath (symlinks resolved, `O_NOFOLLOW`) is a regular file inside the agent workspace or
    `<stateDir>/media`, the extension is on a fixed list (images, PDF, txt/md/csv/json, docx/xlsx/pptx, mp3/m4a/ogg/wav, mp4),
    the first bytes match the type, and the size is at most 20 MB. Relative paths resolve against the workspace.
    `media://inbound/<id>` maps to the inbound store. Other schemes are never followed, and nothing is listed.
  - Responses carry `Content-Disposition: attachment`, `nosniff` and `CSP: sandbox`. SVG is never inline.
- **Steps.** While the app polls `/runs/:id`, the bridge reads the app session's last 12 rows (`sessions_history`,
  `includeTools`) at most every 1.5 s, and returns `steps: [{tool, done}]`: tool names only.
- **New conversation.** Refused while a turn runs (409); while a reset is under way `/send` answers 409 `busy` too (one shared
  exclusion), and the reset re-checks for a running turn right before `sessions.reset`. OpenClaw keeps the same session id and transcript. Its default
  projection then starts at the reset row, while older rows stay reachable by an anchored read. That read stays inside one
  reset segment, and a forged `cursor` gets `windowReset`. So the bridge records, per reset it makes, `{resetId, anchorId}` (ids
  only) in `<stateDir>/app-bridge/resets.json` (0600, last 50). `/history` returns `earlier: <resetId>` when the first row is such a
  reset. `before=<cursor>` pages back and chains across earlier resets the bridge made. Resets made elsewhere (for example `/new`
  in the Control UI) have no anchor, so their earlier rows are not offered to the app; they stay in the engine.
- **Search.** `sessionKeys` is always the readable keys (app, main and the owner's WhatsApp direct chats). Results are filtered
  again, toolResult hits are dropped, and snippets lose `MEDIA:` lines, markers and absolute paths.
- **Not offered.** Documents/PDFs to BASHT (they need `chat.send` attachments: over the CLI argv cap; waits for a WebSocket
  client). No edit or rewind (admin, branches). No parallel app sessions.

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

  Groups, other people's chats, subagents and cron jobs are never listed or read. History returns text parts only (plus B2 media refs): no tool payloads and no thinking. OpenClaw caps each message at 4,000 characters in `sessions_history`.
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

B1/B2 (lab-cm: this wrapper in front of the real 2026.11.10 gateway, mock provider that logs image parts), 23/23 via the app:
- A 3000×2000 JPEG with GPS EXIF reached the provider as one `image/jpeg` part of 148 KB with no EXIF.
- After the turn, the user row carries the engine's image block as media (served through `artifacts.download`).
- `MEDIA:` image and PDF were shown; the PDF download was byte-identical. `/etc/passwd`, a symlink out of the workspace and
  `../` were `available: false` / 404.
- Tool step shown («قراءة ملف»); stop, then retry, re-sent the same message.
- Search found an engine message and jumped to it.
- After `/new`, the first turn reached the provider with 3 messages instead of 22, and the earlier rows were paged back in.
