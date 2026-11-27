# BASHT app bridge (C2 + C4 + M + B0/B3 + voice + B1/B2 + B5–B7)

How the BASHT app (`safwan-smart-assistant`) reads the owner's conversations and chats with BASHT live. The code is in
`src/app-bridge.js` and the tests are in `src/app-bridge.test.mjs`. Voice identity guard: `src/app-bridge-voice.js`. Request signing:
`src/app-bridge-signing.js` (shared test vectors: `src/fixtures/bridge-signing-vectors.json`).

## Path

```
iPhone ─► Next BFF (owner cookie) ─► FastAPI (HMAC · audit · limits) ─► HTTPS ─► wrapper /app/v1/* ─► loopback gateway
```

The app holds **only** `BASHT_APP_TOKEN`. It never gets `OPENCLAW_GATEWAY_TOKEN` or `SETUP_PASSWORD`.

## Surface (Bearer `BASHT_APP_TOKEN`)

| Route | What it does | Gateway call (made by the wrapper) |
|---|---|---|
| `GET /app/v1/status` | Liveness, the app session key, the link state and the additive fields below (`features`, `voice`, `runs`, `signing`, `engine`). Cheap: the config file, in-memory state and, at most every 3 s, two read-only counting reads over the persistent link (`runs`); no TTS call, no write | — |
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
| `POST /app/v1/speak {text}` | The text spoken in BASHT's own voice; returns the audio bytes (`audio/mpeg`, or `audio/ogg` / `audio/wav`) | link RPC `tts.speak {text}` when the voice identity guard says `match`; otherwise the `tts` tool via `/tools/invoke`, session `agent:main:app:owner` (see Voice) |
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

`/runs/:id` also returns `firstTokenMs` and `totalMs`, measured by the bridge from the moment the turn started. Its `text` (while
running and when done) never contains the engine's own media markers: standalone `MEDIA:` lines and `[media attached: …]` markers are
removed with the same rules as history rows, and while the reply is still streaming a half-written marker at the very end (`ME`,
`MEDIA:`, `[media att…`) is held back until the next chunk completes it. The file itself is delivered as in history (`media` refs). Assistant messages in
`/history` carry `provider` and `model`. The notice OpenClaw writes when it switches models carries
`fallback: {from, to, reason}`; that notice has `provider: "openclaw"` and `model: "delivery-mirror"`.

### `GET /app/v1/status` fields (additive; the older fields keep their shape)

```json
{ "ok": true, "appSession": "agent:main:app:owner", "link": { "state": "up", ... },
  "features": ["voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1"],
  "voice": { "speak": "ready", "reason": "…", "warnings": [] },
  "runs": { "active": 0, "engine": 0, "cron": 0, "approvalsPending": 0, "total": 0, "complete": true },
  "signing": { "mode": "optional", "active": true, "warnings": [], "replayProtection": "memory+boot_fence",
               "lastRejected": { "reason": "skew", "at": 0 } },
  "engine": { "version": "…" } }
```

- `features`: capability hints for the app, equal to the shared contract file `src/fixtures/voice-contract.json` (an identical copy
  lives in the app; both sides' tests compare against it). `voice.speak.v2` = `/speak` answers with a `reason` on every refusal and can
  use the link path; `voice.transcribe.v1` = `/transcribe`; `voice.status.v1` = the `voice` block below; `signing.v1` = the engine can
  verify `basht-bridge-v1` signatures (whether it enforces them is `signing.mode`). The same file fixes every `reason` token
  and every `voice.speak` value: reasons are fixed tokens, never free text.
- `voice.speak`: `ready` (guard `match` and the link is up) · `degraded` (`link_down`: the link is down; or `tool_path_only`: the
  link path cannot be used yet — no global `tts` block, or no agent block to compare with — so only the tool path speaks) ·
  `mismatch` (`identity_mismatch`) · `unconfigured` (`no_tts_config`, or `tool_path_unavailable`) · `unknown` (`config_unreadable`).
  `warnings` are codes only (`global_auto_enabled`, `global_prefs_path`, `prefs_file_overrides`), see Voice.
- `runs`: how much work is running, counts only, for the release rule below (never a session key, phone number, job id or path).
  Read-only, over the persistent link, shared for 3 s:

  | Field | Source | Meaning |
  |---|---|---|
  | `active` | this bridge, in memory | app turns running right now (always known) |
  | `engine` | link `sessions.list {activeOnly: true, limit: 1, includeGlobal, includeUnknown}`, read as `totalCount` | sessions with a queued or running turn across **all** sessions: WhatsApp chats, the app, cron-run sessions, subagents (the gateway's live-run projection, before pagination; closed params, one row returned and dropped) |
  | `cron` | link `cron.list {includeDisabled, limit: 200, compact, includeDeliveryPreviews: false}` | cron jobs with a running state; a list longer than one page is unknown, not guessed |
  | `approvalsPending` | the approvals this link tracks (events and resync) | pending exec, plugin and system-agent approvals; **unknown (`null`) while the link is down and until all three approval lists were read on the current connection** (an empty map right after (re)connecting, or after a failed list read, is never reported as zero) |
  | `total` | `active + engine + cron` (the known parts) | **only meaningful as "is it zero"**: the parts overlap (the app's own turn is also an active session, a running cron job also has a session). Approvals are not in it |
  | `complete` | `true` only if `engine`, `cron` and `approvalsPending` were all obtained | `false` means the picture is partial |

  A source that cannot be read read-only is `null` and makes `complete` `false`; nothing is ever guessed. The link allows only these
  two extra reads, each with an exact fixed params object (anything else is refused locally, `bad_params`); no write method is added.
  **`runs` does not cover:** work that starts right after the check (re-check immediately before the restart); runs outside the
  session index (the gateway counts sessionless/internal runs, background exec sessions, media generation and ACP turns in its own
  maintenance snapshot, which is not exposed on a read-only method the link may call); memory-flush / compaction internals unless they
  run in a session; queued but not yet running cron jobs; WhatsApp deliveries in flight; and every other service (for example the broker).
- `signing`: `{mode, active, ...}`, never a secret. `mode` is `off` | `optional` | `required` as configured. `active` is whether this
  bridge is verifying signatures now (a valid secret and a mode other than `off`). For `required` without a usable secret
  `active` is `false` and `error` is `secret_missing` | `secret_invalid` | `previous_only`: the bridge **fails closed** (see Signing).
  For `optional` without a usable secret `reason` says the same (it has nothing to verify and accepts unsigned requests).
  `warnings` carries `mode_invalid` when `BASHT_BRIDGE_SIGNING_MODE` was not recognised (it is then `optional`).
  `replayProtection` is always `"memory+boot_fence"`: **NOT durable** (see Signing). `lastRejected {reason, at}`: the last signature
  this bridge did not accept (`reason` is `missing`, `malformed`, `skew`, `before_boot`, `signature`, `replay` or `body`; `at` in ms),
  absent until there was one.
- `engine.version`: the engine version the gateway reported in `hello-ok` on the persistent link; absent until the link has been up once.

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

- **Speak.** `POST /speak {text}`. BASHT's voice is the agent block `agents.entries.main.tts` (provider, voice, model and
  `instructions`: the owner's tuned pronunciation, dialect and style). Two engine paths can speak it, and the **voice identity
  guard** (next bullet) decides which, from `openclaw.json` read fresh on every request:
  - **Link path (v2).** The bridge sends the gateway RPC `tts.speak {text}` over the existing persistent link, with a 60 s timeout
    (the link's default is 15 s; a provider can take longer). `tts.speak` accepts `text` only (a closed schema: the link refuses any
    other param locally, `bad_params`) and speaks with the **global** `tts` block, never the agent block. It returns
    `{audioBase64, provider, outputFormat, mimeType, fileExtension}`. The gateway may fall back to **another provider** when the
    first fails, and the closed params cannot disable that, so the bridge compares the answer's `provider` (normalised like the guard's)
    with the approved one and, when it differs or is missing, refuses with 503 `identity_mismatch` and returns **no audio**. A refusal
    here can still have been billed (the provider already spoke), as can any audio the checks below reject. The bridge decodes the
    audio and checks it: not empty, at most 8 MB, `mimeType` one of `audio/mpeg` (`audio/mp3`), `audio/ogg` (`audio/opus`), `audio/wav` (`audio/x-wav`, `audio/wave`) and,
    when given, a `fileExtension` in `.mp3` / `.opus` / `.ogg` / `.wav`. Then it sends the bytes with `Content-Length`,
    `Cache-Control: no-store`. Nothing is written to disk.
  - **Tool path (unchanged).** The agent's `tts` tool through `/tools/invoke` with the fixed session key `agent:main:app:owner`
    (the agent block applies there). It works wherever the `tts` tool is allowed by the tool policy.
  - **Never retried, no automatic admin fallback.** A client timeout does not stop the provider call, so a retry would be billed
    twice: the bridge makes exactly one attempt. If the link is down it answers 502 `engine_unavailable` (`link_down`); it does **not**
    fall back to the CLI / admin path (owner decision).
  - Anything else in the request body (`sessionKey`, `voice`, `provider`, …) is ignored.
  - `text`: string, trimmed, 1–1500 characters, counted in **UTF-16 code units** (JavaScript `string.length`, which is also how the
    engine counts); an app that counts code points (emoji, some scripts take two units) must count the same way or stay well below
    1500. The engine's own text rules can be stricter (a lower `tts.maxTextLength`): its rejection is 400 `bad_request` /
    `text_rejected`. The app splits longer replies on sentence boundaries (the engine's own hard cap,
    `tts.maxTextLength`, defaults to 4096 and this path does no chunking). The engine strips markdown before speaking.
  - The tool writes `<STATE_DIR>/media/tool-speech-synthesis/voice---<uuid>.mp3` and returns that local path. The bridge resolves it
    (`realpath`) and reads it only if it is a regular file **inside** that directory with an audio extension (`.mp3`, `.opus`,
    `.ogg`, `.wav`, ≤ 8 MB). It returns the bytes with `Content-Length` and `Cache-Control: no-store`, then deletes the file. A path
    anywhere else (traversal, symlink out, wrong type) is never read or deleted: the answer is 503 `voice_unavailable`.
  - 30 requests a minute, and at most 2 in flight (429 `rate_limited`, reason `in_flight` / `per_minute`). A refusal logs one line
    with the reason only, never the text.
- **Voice identity guard (`src/app-bridge-voice.js`).** `tts.speak` is agent-less: it speaks with the **global** `tts` block alone,
  and with no matching global block it does not fail: it silently speaks with a **different default voice and no instructions**,
  which is unacceptable for BASHT. The gateway builds the agent's own voice as the global block with the agent block merged over it
  (deep merge, the agent's keys win). So the guard computes both effective identities the way the gateway does (verified against
  OpenClaw 2026.11.10) and requires them to be equal:
  - **Agent identity** = `merge(global tts, agents.entries.main.tts)`; **RPC identity** = the global block alone. Compared:
    the provider and that provider's settings (`model`, `speakerVoice`, `instructions`, …), as canonical JSON (key order does not matter).
  - The provider id is normalised like the gateway (trim, lower-case, `edge` = `microsoft`). An id that is not a plain token
    (`[a-z0-9._-]`, ≤ 64) or is a registry alias whose settings cannot be told apart from here (`azure`, `cli`) fails closed as a
    mismatch. Provider settings are read as `providers.<id>`, else the legacy top-level `<id>: {…}` entry, on both sides; the voice
    aliases (`voice`, `speakerVoice`, `voiceName`, and the `…Id` forms) are unified as the gateway does.
  - Secret-looking keys (`apiKey`, `token`, `secret`, `password`, `key`, `*Key`, `*Token`, `authorization`, `headers`, …) are removed
    first, so keys are not compared, hashed or logged.
  - **Personas.** A global `persona` / `personas` (non-empty) is a mismatch: the RPC would speak something the agent block never
    approved. In the agent's merged block, any persona that has more than `label` / `description` (a provider, voice, model, instructions…)
    is a mismatch, because the global copy cannot carry it. A persona with only `label` / `description` never reaches the provider
    request (lab-verified) and is fine.
  - **The preferences file.** The gateway always reads a TTS preferences file (the config `prefsPath`, else the environment variable
    `OPENCLAW_TTS_PREFS`, else `<state dir>/settings/tts.json`) whose provider, persona and auto settings override the config for
    everyone. The guard reads it (read-only; missing, unreadable or malformed means none, as for the gateway). A provider other than
    the approved one, or a persona that is not harmless, is a mismatch; `auto`/`enabled` is a warning. (A machine-wide path kept in the
    gateway's state database is not visible from here.) Its content is never logged or returned.
  - The result is a state, the effective provider id, a 12-character sha256 prefix of the identity and warning codes: never text,
    instructions, keys or paths.

  | State | Meaning | `/speak` does | `voice.speak` |
  |---|---|---|---|
  | `match` | agent block present, global block names a provider, the two effective identities are equal, nothing else can change them | link path | `ready` (link up) / `degraded` `link_down` |
  | `no_global` | agent block, the global block names no provider (production **before** the config change) | tool path, as before | `degraded` `tool_path_only` |
  | `global_only` | no agent block, the global block names a provider | tool path (nothing to compare with) | `degraded` `tool_path_only` |
  | `mismatch` | any difference above | 503, **nothing is called** | `mismatch` |
  | `no_agent_block` | no provider anywhere | 503 | `unconfigured` |
  | `unknown` | `openclaw.json` unreadable or malformed | tool path | `unknown` |

  Warnings (never a refusal by themselves): `global_auto_enabled` (the global `auto` is anything but `off`: the engine would speak
  replies on its own), `global_prefs_path` (a `prefsPath` is configured), `prefs_file_overrides` (the preferences file sets a
  provider, a persona or auto mode).
- **Reasons.** Every refusal of `/speak` keeps the existing `{ok:false, error}` and adds `reason`; a client that ignores `reason` is
  unaffected. The tokens are the shared contract (`src/fixtures/voice-contract.json`). The plain validation `bad_request` (400:
  empty or over-long text, checked before anything runs) carries none.

  | Status | `error` | `reason` | When |
  |---|---|---|---|
  | 503 | `voice_unavailable` | `identity_mismatch` | guard `mismatch` (no provider was called), or the gateway answered with another provider's audio (dropped) |
  | 503 | `voice_unavailable` | `unconfigured` | guard `no_agent_block`; or no state dir for the tool path |
  | 503 | `voice_unavailable` | `tool_denied` | the tool path got 404/403: the `tts` tool is not allowed by the tool policy |
  | 503 | `voice_unavailable` | `provider_error` | the gateway answered `ok:false` (e.g. `UNAVAILABLE`); or the tool path was refused (HTTP 500 `tool_error`, any other refusal) |
  | 400 | `bad_request` | `text_rejected` | the gateway rejected the text itself (`INVALID_REQUEST`, e.g. longer than its `tts.maxTextLength`) |
  | 503 | `voice_unavailable` | `bad_audio` | empty / over 8 MB / type not allowed / path outside the speech directory |
  | 502 | `engine_unavailable` | `link_down` | link path and the link is not up (or dropped mid-request); no fallback |
  | 502 | `engine_unavailable` | `timeout` | no answer within 60 s (kept in the existing vocabulary instead of a 504); not retried |
  | 502 | `engine_unavailable` | `engine_error` | any other failure talking to the engine |
  | 429 | `rate_limited` | `per_minute` / `in_flight` | 30 a minute / 2 at once |
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
- **Errors.** For `/speak` see the reasons table above. For `/transcribe`: the CLI answering `ok: false` is 503 `voice_unavailable`
  (no `reason`), an engine that does not answer (still starting, crashed, CLI missing) is 502 `engine_unavailable`. Without `transcribe`
  (an older wrapper) `/transcribe` is 503 `voice_unavailable`; without `stateDir` only the tool path of `/speak` is unavailable.
- **Not offered (future option).** Live Talk (`talk.client.create`, WebRTC realtime). The production realtime provider does not
  support browser sessions and would speak with a different voice than `agents.entries.main.tts`. The app's live voice
  conversation is a turn loop over `/transcribe` → `/send` → `/speak` in the same `app:owner` conversation.

### The minimal global `tts` block (operator change that turns the link path on)

Until the operator adds it, `/speak` uses the tool path and `voice.speak` reads `degraded` (`tool_path_only`). Add a **minimal** global
`tts` block that is an exact copy of the identity of `agents.entries.main.tts`, and nothing else:

```json
"tts": {
  "provider": "<same provider as the agent block>",
  "providers": { "<provider>": { "model": "<same>", "speakerVoice": "<same>", "instructions": "<same, byte for byte>" } }
}
```

That is: `provider` plus `providers.<provider>.{model, speakerVoice, instructions}`. The provider's key stays where it is today
(`tts.providers.<provider>.apiKey` or the environment): keys are not part of the comparison. **Do not add `auto`, a persona,
`prefsPath` or any extra field.** The agent's own voice is built from the global block with the agent block on top, so a field added
to the global block is inherited by the agent's own speech (for example voice replies on chat channels), and `auto` other than `off`
would make the engine speak replies by itself. The guard sees the merge, so a global extra does not by itself read as a mismatch: it
changes the agent's voice too, which you may not want. Verify with `GET /app/v1/status`: `voice.speak` must read `ready` and
`voice.warnings` must be empty. A copy that differs in a single character reads `mismatch` and `/speak` refuses with
`identity_mismatch` rather than speak in another voice. Also check there is no TTS preferences file that sets another provider or a
persona (`<state dir>/settings/tts.json`): it would read `mismatch` too.

### Production prerequisites

- `agents.entries.main.tts` (or the global `tts`) must name a configured provider. For OpenAI the key comes from
  `tts.providers.openai.apiKey` or `OPENAI_API_KEY`; `models.providers.openai` alone does not configure TTS. Without it the
  tool fails (`openai: not configured`) and `/speak` is 503.
- Tool path only (guard `no_global` / `global_only` / `unknown`): the `tts` tool must be reachable on `/tools/invoke` for the shared-secret caller. It
  is **not** on the gateway's default HTTP deny list, but a `tools.profile` / `tools.allow` / `tools.deny` or `gateway.tools.deny` that
  excludes it makes `/speak` 503 `tool_denied`. The link path does not need the tool: it calls the RPC `tts.speak` (the link is already
  an operator connection; `tts.speak` is on its fixed method list and takes `{text}` only).
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
  - `BASHT_BRIDGE_SIGNING_SECRET` and `BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS` are removed from `process.env` the same way.
  - A failed signature counts in the same failed-authentication limiter as a bad token.

- **Residual (review L4).** The app's API reaches the bridge over the public domain with one static bearer token. Request signing (next
  section) adds a timestamp, a one-time nonce and a body hash on top of the token, so a captured request cannot be replayed or
  reused for another body. Until signing is `required` on both sides, treat `BASHT_APP_TOKEN` as an owner credential: rotate it if it
  may have leaked. Recommended in addition: allow `http://<service>.railway.internal` for `BASHT_CORE_URL` in the API (it currently
  requires https) so the token never crosses the internet.

## Signing (`basht-bridge-v1`): `src/app-bridge-signing.js`

An optional second factor on every `/app/v1/*` request, verified in the router's auth middleware. The bearer `BASHT_APP_TOKEN` check
is unchanged and **always runs first**; signing is added on top, never instead.

**Headers** (all four, or none):

| Header | Value |
|---|---|
| `X-Basht-Timestamp` | unix seconds |
| `X-Basht-Nonce` | `[A-Za-z0-9_-]{16,64}`, never reused |
| `X-Basht-Content-SHA256` | lowercase hex sha256 of the exact request body bytes (sha256 of the empty string when there is no body) |
| `X-Basht-Signature` | `v1=` + lowercase hex `HMAC-SHA256(secret, canonical)` |

```
canonical = join("\n", ["basht-bridge-v1", METHOD (uppercase), request-target, timestamp, nonce, content-sha256])
request-target = the URL exactly as received: path and query, e.g. /app/v1/history?key=agent%3Amain%3Aapp%3Aowner&limit=50
```

The request target is `req.originalUrl` (the signer must sign the bytes it sends: do not re-encode or re-order the query).
Shared vectors, with test-only secrets and the previous-secret case, are in `src/fixtures/bridge-signing-vectors.json`; the bridge's
tests verify every one byte for byte and so should the app's.

**Verification** (malformed headers are refused before any crypto; every failure is `401 {"ok":false,"error":"bad_signature"}` in
`required`, see Modes for `optional`):

1. All four headers present and well-formed (timestamp digits, nonce shape, 64 hex chars, `v1=` + 64 hex chars).
2. `|now - timestamp| <= 60 s`.
3. **Restart fence:** the timestamp is not earlier than this process's boot time minus 2 s (reason `before_boot`). It closes the replay
   of a request captured before an engine restart (the nonce memory died with the old process). A request that was genuinely in
   flight across a restart simply fails once and is retried with a fresh timestamp.
4. The signature equals the HMAC under the current secret, else under the previous secret (rotation), compared in constant time
   (`crypto.timingSafeEqual` on equal-length buffers).
5. The nonce has not been seen: a bounded in-memory cache, TTL 180 s, at most 10,000 entries, oldest evicted first. A nonce is spent
   only by a request whose signature was genuine.
6. After the body is read, `sha256(body bytes)` must equal `X-Basht-Content-SHA256`. Every parser keeps the raw bytes it was given:
   the 64 kB JSON parser, the larger `/send` JSON parser and the raw-audio `/transcribe` body. The hash covers the bytes the parser
   hands over, i.e. **after any content decoding** (a `Content-Encoding` is undone before the hash is taken), so the signer must hash
   the decoded body it intends the server to see. GET and empty bodies hash as the empty string.

**Replay protection is NOT durable.** The nonce cache is **in memory and per process**: a restart empties it, and several replicas
would not share it (**a single replica is assumed**). What limits a replay is the timestamp window (<= 60 s) plus the boot fence above
(`signing.replayProtection: "memory+boot_fence"`). The bearer token remains the primary credential: signing is a second factor, not an
anti-replay guarantee across restarts or replicas.

**Environment** (read once at boot, then deleted from `process.env`):

| Variable | Meaning |
|---|---|
| `BASHT_BRIDGE_SIGNING_SECRET` | current secret, at least 32 characters (shorter: not a secret, one warning) |
| `BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS` | previous secret, accepted next to the current one during a rotation (never usable without a current secret) |
| `BASHT_BRIDGE_SIGNING_MODE` | `off` · `optional` · `required`. **`off` only when asked for.** Unset: `optional`. Not recognised: `optional` plus the status warning `mode_invalid` (a typo never enables `required` and never silently disables) |

**`required` never degrades.** With a missing, too-short or invalid secret (or only a previous secret) the bridge **fails closed**:
after the bearer check, every `/app/v1` route except `GET /status` answers `503 {"ok":false,"error":"signing_unavailable"}`, and nothing
is processed or accepted unsigned. `GET /status` (with the bearer) stays reachable and shows `signing: {mode: "required", active:
false, error: "secret_missing" | "secret_invalid" | "previous_only"}`. The refusal is logged loudly (throttled to once a minute) and at
boot. `optional` without a usable secret has nothing to verify: requests are accepted unsigned, and `GET /status` says so
(`signing: {mode: "optional", active: false, reason}`). With no signing variable set at all the bridge is therefore `optional`,
inactive, which behaves exactly as before.

**Modes.**

| Mode | Request with no `X-Basht-*` signing header | Request with any signing header |
|---|---|---|
| `off` (explicit only) | accepted | headers ignored |
| `optional` | accepted | verified if valid; if present but **not valid** (wrong secret, skew, before boot, replay, body hash mismatch, malformed) it is processed as an **unsigned** request, never as verified |
| `required` | 401 `bad_signature` | must verify fully, else 401 `bad_signature` |

`optional` never locks the owner out: the bearer token check still applies, and the reason of a rejected signature is logged (once a
minute per reason, no header value, no secret) and shown in `GET /status` → `signing.lastRejected {reason, at}`. Only `required`
refuses, and only `required` counts a failed signature (header phase or body hash) in the **same** limiter as a bad token: after 20
failures a minute the answer is 429 `rate_limited`. A request with a valid token and a valid signature always passes, so an
anonymous flood cannot lock the owner out. `GET /status` reports `signing` and the `signing.v1` feature.

**Compatibility matrix.**

| App | Engine | Result |
|---|---|---|
| old (no signing) | new, `optional` (default once a secret is set) | works: unsigned requests are accepted |
| new (signs) | old engine (before this feature) | works: the extra `X-Basht-*` headers are unknown headers and are ignored |
| new (signs) | new, no secret set (`optional`, inactive) | works: nothing to verify, requests accepted unsigned (`signing.active: false`) |
| new (signs) | new, `optional` | works; valid signatures are verified, an invalid one is accepted as unsigned and shows in `signing.lastRejected` |
| old (no signing) | new, `required` | **401**: switch to `required` only after the app signs |
| any | new, `required` with an unusable secret | **503 `signing_unavailable`** on everything but `GET /status`: fail closed, never unsigned acceptance |
| new (signs) | new, `required` | works; the full protection |

**Rotation runbook** (no downtime, every step reversible):

1. Engine: set `BASHT_BRIDGE_SIGNING_SECRET` (new value, ≥ 32 random characters), keep the old value in
   `BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS`, mode `optional`. Deploy (see the release rule below).
2. App: switch the signing secret to the new value. Both secrets verify meanwhile.
3. Check `signing.mode` on `/status` and that the app's calls succeed (no new `signing.lastRejected`).
4. Engine: remove `BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS` and deploy. A leaked old secret is dead from here.
5. First enablement: set the secret on both sides in `optional`, confirm signed calls work, then set `BASHT_BRIDGE_SIGNING_MODE=required`
   on the engine. To roll back, set the mode to `optional` (or `off`) or remove the variables.

## Release rule: restart the engine only when `runs` says it is idle

The gateway re-runs a turn that a restart interrupted, and that can repeat its side effects (a message sent, an invoice created).
Restart or redeploy the engine **only when** `GET /app/v1/status` reports `runs.complete === true`, `runs.total === 0` and
`runs.approvalsPending === 0`, **re-checked immediately before the restart**. `complete: false` (a source could not be read: `engine`,
`cron` or `approvalsPending` is `null`) is **not** safe: treat it like running work, wait and re-check; a pending approval is work that
resumes when answered, so it blocks too. Stop an app turn from the app if it must go. `runs` does not cover everything (work that
starts right after the check, sessionless runs, memory-flush / compaction internals unless they run in a session, and other services
such as the broker): see the list under `runs` above, and check those by other means.

## Enable and roll back

1. Generate a long random token and set `BASHT_APP_TOKEN` on the OpenClaw service. Set the same value on the app's `safwan-api` service.
2. To roll back, remove the variable. The bridge turns off on the next deploy. The chat endpoint stays enabled in the config, but it is still protected by the gateway token.

## Verified (lab: the real wrapper in front of the real OpenClaw 2026.11.10 gateway, mock model)

- `tts.speak` (lab, OpenClaw 2026.11.10): returns `{audioBase64, provider, outputFormat: "mp3", mimeType: "audio/mpeg", fileExtension: ".mp3"}`,
  strips markdown like the tool path, rejects any param except `text`, and answers a provider failure as
  `{ok: false, error: {code: "UNAVAILABLE"}}`. Without a matching global `tts` block it speaks with a different default voice and no
  instructions (why the identity guard exists). A client timeout does not stop the provider call (why `/speak` never retries).

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
  authority; `request()` refuses every method outside a fixed list (`LINK_METHODS`: the reads above, the approval lists/get/history,
  `approval.resolve` and `tts.speak`). Everything else is refused locally, before anything is sent. `tts.speak` also has a closed
  params check: exactly `{text}`, a string of 1–1500 characters, anything else is `bad_params` and never leaves the process.
  `request(method, params, {timeoutMs})` honours the timeout it is given (default 15 s, at most 120 s; `/speak` passes 60 s). A timeout only
  stops waiting: the gateway may still finish the work, so a call that costs money is never retried.
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
