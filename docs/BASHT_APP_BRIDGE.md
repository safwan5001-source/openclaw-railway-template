# BASHT app bridge (C2 + C4 + M + voice)

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
| `POST /app/v1/speak {text}` | The text spoken in BASHT's own voice; returns the audio bytes (`audio/mpeg`) | `tts` tool via `/tools/invoke`, session `agent:main:app:owner` |
| `POST /app/v1/transcribe` (raw audio body) | A voice note transcribed with the engine's own audio config; returns `{ok, text}` | CLI `openclaw infer audio transcribe --agent main --file <temp> --json` |

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
