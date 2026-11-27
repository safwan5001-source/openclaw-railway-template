# BASHT app bridge (C2 + C4 + M + B0/B3 + voice + B1/B2 + B5–B7)

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
| `POST /app/v1/speak {text}` | The text spoken in BASHT's own voice; returns the audio bytes (`audio/mpeg`) | `tts` tool via `/tools/invoke`, session `agent:main:app:owner` |
| `POST /app/v1/transcribe` (raw audio body) | A voice note transcribed with the engine's own audio config; returns `{ok, text}` | CLI `openclaw infer audio transcribe --agent main --file <temp> --json` |
| `POST /app/v1/send {message, images?}` | B2: up to 8 photos ride on the same turn as `image_url` data parts | `/v1/chat/completions` (as above) |
| `GET /app/v1/history?key=&before=\|around=` | B1: earlier rows (also across a reset) or a window around one message | RPC `chat.history {messageId}` (anchored) |
| `POST /app/v1/new` | B1 «محادثة جديدة»: a fresh context for the app session; nothing is deleted | RPC `sessions.reset {key: app session, reason: "new"}` |
| `GET /app/v1/search?q=` | B1: search the readable conversations only | RPC `sessions.search {sessionKeys: readable keys}` |
| `GET /app/v1/media?key=&msg=&ref=` | B2: one image/file of one message of a readable conversation (bytes) | RPC `artifacts.download`, or an engine-owned file |
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

## Voice (V2 speak · V3 voice notes)

The app gets BASHT's voice and the engine's transcription **from the engine's own configuration**. It holds no provider key and
cannot choose a voice, provider, model or session.

- **Speak.** `POST /speak {text}` runs the agent's `tts` tool through `/tools/invoke` with the fixed session key
  `agent:main:app:owner`. Only that path applies the agent block `agents.entries.main.tts` (provider, voice, model and
  `instructions`: the owner's tuned pronunciation, dialect and style). The RPCs `tts.convert` / `tts.speak` ignore the agent block
  and are not used. Anything else in the request body (`sessionKey`, `voice`, `provider`, …) is ignored.
  - `text`: string, trimmed, 1–1500 characters. The app splits longer replies on sentence boundaries (the engine's own hard cap,
    `tts.maxTextLength`, defaults to 4096 and this path does no chunking). The engine strips markdown before speaking.
  - The tool writes `<STATE_DIR>/media/tool-speech-synthesis/voice---<uuid>.mp3` and returns that local path. The bridge resolves it
    (`realpath`) and reads it only if it is a regular file **inside** that directory with an audio extension (`.mp3`, `.opus`,
    `.ogg`, `.wav`, ≤ 8 MB). It returns the bytes with `Content-Length` and `Cache-Control: no-store`, then deletes the file. A path
    anywhere else (traversal, symlink out, wrong type) is never read or deleted: the answer is 503 `voice_unavailable`.
  - 30 requests a minute.
- **Transcribe.** `POST /transcribe` takes the raw recording as the body (no JSON, no multipart).
  - `Content-Type` must be one of `audio/ogg`, `audio/webm`, `audio/mp4`, `audio/x-m4a`, `audio/mpeg`, `audio/wav` (`audio/x-wav`,
    `audio/wave`); parameters such as `;codecs=opus` are ignored. Anything else is 415 `unsupported_audio`, before the body is read.
  - At most 10 MB (413 `too_large`). Under 1 KB is 422 `no_speech` (OpenClaw skips such files anyway). The app also stops
    recording at 3 minutes.
  - The bridge writes the body to a private temp file (`mkdtemp` 0700, file 0600, name `note.<ext>` chosen by the bridge from the
    MIME type) and calls the wrapper's injected `transcribe(path)`. The wrapper runs
    `openclaw infer audio transcribe --agent main --file <path> --json` with `execFile` (no shell; the temp path is the only
    argument that varies), timeout 90 s. A WebM note (Chrome/Android) is first remuxed to Ogg/Opus with `ffmpeg -c:a copy` (no
    re-encode) in the same private directory: OpenClaw sniffs WebM as `video/webm` and its audio step skips it ("No transcript
    returned"); an unreadable recording is 415 `unsupported_audio`. That is the same audio configuration (`tools.media`) as WhatsApp voice notes. There is no
    transcription RPC, and `/v1/chat/completions` silently drops audio parts. The temp directory is removed in every case.
  - The answer is `{ok: true, text}`: `outputs[].text`, trimmed, capped at 8000 characters (one sendable message). An empty
    transcript is 422 `no_speech`.
  - 20 requests a minute and at most two at once (each one spawns the CLI, about 5 s cold start).
- **Errors.** The tool refusing (not configured, provider error: HTTP 500 `tool_error`), the tool not allowed by policy (404), or
  the CLI answering `ok: false` are all 503 `voice_unavailable`, so the app can hide the control or explain it. An engine that does
  not answer (still starting, crashed, CLI missing) is 502 `engine_unavailable`. Without `stateDir` / `transcribe` (an older
  wrapper) the routes are 503 `voice_unavailable`.
- **Not offered (future option).** Live Talk (`talk.client.create`, WebRTC realtime). The production realtime provider does not
  support browser sessions and would speak with a different voice than `agents.entries.main.tts`. The app's live voice
  conversation is a turn loop over `/transcribe` → `/send` → `/speak` in the same `app:owner` conversation.

### Production prerequisites

- `agents.entries.main.tts` (or the global `tts`) must name a configured provider. For OpenAI the key comes from
  `tts.providers.openai.apiKey` or `OPENAI_API_KEY`; `models.providers.openai` alone does not configure TTS. Without it the
  tool fails (`openai: not configured`) and `/speak` is 503.
- The `tts` tool must be reachable on `/tools/invoke` for the shared-secret caller. It is **not** on the gateway's default HTTP
  deny list, but a `tools.profile` / `tools.allow` / `tools.deny` or `gateway.tools.deny` that excludes it makes `/speak` 503.
- Transcription uses `tools.media` (explicit `tools.media.models` with an `audio` capability, or auto-detection). If WhatsApp
  voice notes are transcribed today, `/transcribe` works with the same settings. `ffmpeg` is already in the image.

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
- **New conversation.** Runs in the same one-at-a-time queue as model/thinking/fast writes (so a reset never interleaves with a
  settings write, and the next `GET /model` reads afresh). Refused while a turn runs (409); while a reset is under way `/send` answers 409 `busy` too (one shared
  exclusion), and the reset re-checks for a running turn right before `sessions.reset`. OpenClaw keeps the same session id and transcript. Its default
  projection then starts at the reset row, while older rows stay reachable by an anchored read. That read stays inside one
  reset segment, and a forged `cursor` gets `windowReset`. So the bridge records, per reset it makes, `{resetId, anchorId}` (ids
  only) in `<stateDir>/app-bridge/resets.json` (0600, last 50). `/history` returns `earlier: <resetId>` when the first row is such a
  reset. `before=<cursor>` pages back and chains across earlier resets the bridge made. Resets made elsewhere (for example `/new`
  in the Control UI) have no anchor, so their earlier rows are not offered to the app; they stay in the engine.
- **Search.** `sessionKeys` is always the readable keys (app, the owner's WhatsApp direct chats, and main only while it is
  owner-only — the same `readPolicyFromConfig` rule as `/sessions` and `/history`; `/media` uses it too). Results are filtered
  again, toolResult hits are dropped, and snippets lose `MEDIA:` lines, markers and absolute paths.
- **Not offered.** Documents/PDFs to BASHT (they need `chat.send` attachments: over the CLI argv cap; waits for a WebSocket
  client). No edit or rewind (admin, branches). No parallel app sessions.

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
  - the owner's direct WhatsApp chat or chats (owners come from `commands.ownerAllowFrom`). The key is parsed exactly:
    `agent:main:whatsapp:[<account>:]direct:<peer>`, nothing after the peer, and the account segment is never `direct`, `group`,
    `channel` or `thread`;
  - the main session (`agent:main:main`), **only while it can hold nobody else's messages** (security review L9). With OpenClaw's
    default `session.dmScope` (`main`), every admitted direct-message sender (pairing, or an `allowFrom` beyond the owner) lands in
    the main session, so the bridge reads `openclaw.json` on each call and allows main only when one of these holds:
    - `session.dmScope` is `per-peer`, `per-channel-peer` or `per-account-channel-peer` (DMs get their own sessions), or
    - every enabled channel has `dmPolicy: "disabled"`, or is WhatsApp with `dmPolicy: "allowlist"` and an `allowFrom` made only of
      owners. Any other channel (Telegram, Discord…) or `pairing` / `open` counts as "not owner-only".

    Otherwise main is neither listed nor readable (404). To show it in the app, set `session.dmScope` to a per-peer value (the
    owner's WhatsApp chat then appears as its own `…:direct:<owner>` conversation) or make WhatsApp an owner-only allowlist.
    An unreadable config fails closed.

  Groups, other people's chats, subagents and cron jobs are never listed or read. History returns text parts only (plus B2 media refs): no tool payloads and no thinking. OpenClaw caps each message at 4,000 characters in `sessions_history`.
- **Turns are robust.**
  - The wrapper holds the upstream request, so a turn keeps running if the phone disconnects.
  - Only one turn runs at a time; a second request gets 409.
  - A turn times out after 15 minutes.
  - The wrapper keeps the last 20 runs in memory.
- **Engine load (review L6).** Model control spawns the `openclaw gateway call` CLI. At most 2 run at once and 16 wait; more fail at
  once (502). `GET /model` shares one `sessions.describe` for 2.5 s; any settings write, and the end of a turn, makes the next read
  fresh. `GET /models` is cached 60 s.
- **Secrets.**
  - `BASHT_APP_TOKEN` is removed from `process.env` after startup, like `SETUP_PASSWORD`.
  - Comparison is timing-safe.
  - After 20 failed authentications per minute the bridge returns 429.

- **Residual (review L4).** The app's API reaches the bridge over the public domain with one static bearer token (no timestamp,
  nonce or source restriction). Recommended next step: allow `http://<service>.railway.internal` for `BASHT_CORE_URL` in the API
  (it currently requires https) so the token never crosses the internet, or sign bridge calls like the app's BFF → API hop.
  Until then, treat `BASHT_APP_TOKEN` as an owner credential: rotate it if it may have leaked.

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

Voice (lab-m, mock OpenAI-compatible `/v1/audio/speech` and `/v1/audio/transcriptions` on 127.0.0.1:4111):
- Config: `agents.entries.main.tts = {provider: "openai", providers: {openai: {apiKey, baseUrl: <mock>, model: "gpt-4o-mini-tts",
  speakerVoice: "cedar", instructions: "<Arabic dialect/pronunciation text>"}}}`, `models.providers.openai` (mock `baseUrl`,
  `request.allowPrivateNetwork: true`) and `tools.media.models = [{provider: "openai", model: "gpt-4o-mini-transcribe",
  capabilities: ["audio"]}]`. With no `tts` block the tool fails and `/speak` is 503; with the provider key only under
  `models.providers.openai`, TTS reports `openai: not configured`.
- `/speak` with `**markdown**` text and a caller-sent `voice: "alloy"` and `sessionKey: "agent:main:main"`: the mock received
  `{model: "gpt-4o-mini-tts", voice: "cedar", instructions: "<the configured text>", input: <markdown stripped>}` and the app got
  `audio/mpeg` bytes identical to what the mock returned. The speech file was deleted afterwards.
- WebM/Opus recorded by Chromium's MediaRecorder: transcribed after the remux (without it the CLI answered "No transcript returned";
  `.m4a`, `.mp3`, `.wav` and `.ogg` are accepted as they are).
- `/transcribe` with an Ogg/Opus voice note: the mock received `model: gpt-4o-mini-transcribe` and a file named `note.ogg`; the
  bridge returned the mock's transcript. While the gateway was still starting, `/speak` answered 502 `engine_unavailable`.

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
