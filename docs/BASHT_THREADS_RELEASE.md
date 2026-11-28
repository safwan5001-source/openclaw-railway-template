# BASHT independent conversations: engine flags, release gate, rollback (P2-B4-1)

This is the operator document for batch 4 on the engine (this repo). The contract itself (routes, codes, keys) is in
`docs/BASHT_APP_BRIDGE.md` ("B4: independent conversations"). Nothing here was run against production; the owner approved
development only. **Merge, deploy, enabling the flag and any production config write each need the owner's own approval.**

## Flags and what they switch

| Switch | Where | Default | Effect |
|---|---|---|---|
| `BASHT_THREADS=on` | engine (Railway variable of this service) | **unset = off** | Exactly `on` turns on: the write link (a second loopback WebSocket), `/app/v1/threads/*`, the capability ids `sessions.multi.v1`, `send.ws.v1`, `events.thread.v1` and `threads` in `/status`, `thread` on approvals/events, the global one-run cap on legacy `/send` (plus `busyThread`), the typed `archived` errorCode on legacy runs, `writeLinkProfile` and `threads` in `/status`. Any other value is off |
| `BASHT_THREADS` | API (`app/config.py`, P2-B4-2) | off | The API's own switch; the app also needs `sessions.multi.v1` and `send.ws.v1` in the engine's `/status` |
| D-B4-9 plugin | gateway config `plugins.load.paths` + `plugins.entries` | **not loaded** | See "D-B4-9 plugin" below |

Always on (not behind the flag; legitimate traffic is unchanged): the wrapper-level session-key check on every bridge RPC
(`src/session-rpc-guard.js`) and the admin link's closed `sessions.describe` params.

With the flag off the engine is the batch-3 engine for every existing route (tests: "flag off …" in `src/app-bridge-threads.test.mjs`
and `src/gateway-link-threads.test.mjs`; the whole pre-existing suite passes unchanged).

## PENDING OWNER DECISION D-B4-10: the write link's scopes

`src/gateway-write-link.js` `WRITE_LINK_CONFIG` is the single place. Default (lab Option A): `[operator.write, operator.admin,
operator.approvals]`, `gateway-client`/`backend`, no caps, `suppressCommandInterpretation: true` on every `chat.send`; methods
closed to `chat.send`/`chat.abort`, params closed. Why: the lab (P2-B4-1-LAB L1 and L1-alt) found that without `operator.admin` the
turns run with `senderIsOwner:false`, memory written from them is untrusted and quarantines `MEMORY.md` (sticky), and `/model`,
`/compact` still execute; `suppressCommandInterpretation` is admin-only. This contradicts the approved §4.4 ("no `chat.send` on the
admin link"), hence the open decision. If the owner picks **Option B** instead: change `WRITE_LINK_CONFIG` to
`scopes: [operator.write, operator.approvals]`, `suppressCommandInterpretation: false`, and get a **separately approved** production
config write `commands.ownerAllowFrom += "gateway-client"` (it makes every `gateway-client` connection a command owner). Under B the
engine executes `/status`, `/model`, `/think`, `/compact` from that link; the bridge filter (leading `/` or `!` after stripping
whitespace and format marks) is then the only barrier, and the owner cannot send text that starts with `/` or `!`.

## Enable (after merge and an engine deploy with the flag off, each approved)

1. Release gate (below), then set `BASHT_THREADS=on` on the engine service (a redeploy = an engine restart, so the gate applies).
2. Check: `/status` `features` has the three ids, `writeLinkProfile` is the decided profile and `threads.writeLink` is `"up"`;
   one legacy app turn; one WhatsApp turn. While the D-B4-9 guard is required: `threads.resumeGuard.configured` is `true` **and**
   `openclaw plugins list` shows it enabled (its absence after any deploy is an incident: turn `BASHT_THREADS` off).
3. Only then the API flag (P2-B4-2/4 procedures).
4. Plan v2.2 §9.4: until the guard is verified (lab a–d, `claude-cli` proof) and enabled, `BASHT_THREADS` stays off for real use.

## Rollback

- **Flag:** remove `BASHT_THREADS` (or set anything but `on`) and redeploy (gate first). The routes go back to 404, the write link is
  not created. Conversations created meanwhile stay in the engine's SQLite; the legacy app never shows them. Sends left `unknown` in
  the API stay unknown until reconciled after re-enabling; nothing is retried in either direction.
- **Code:** Railway rollback to the batch-3 deployment. No data is written by this step (no migration, no config write).
- **Plugin:** see below; removing it from the config and reloading/restarting the gateway disables it.

## Release gate (plan §11): operator-run only

No agent statement counts as evidence; BASHT sessions never run or relay the gate. Only the operator (Railway shell / ssh into the
engine container) or the owner reading the app's "System status" screen (`/app/v1/status`, deterministic code) may supply it.

### §11.2 idle command (node; `jq` is not in the container)

```bash
# Run by the OPERATOR in the engine container's shell (never from a BASHT session). Prints counts only. Paste the output verbatim.
| L8 | `notifyOnCreate` | **ناجح**: لا أثر في `main` | — |
| L9 | البوابة | **ناجح كما كُتب**. صفوف cron المضغوطة فيها `nextRunAtMs` في المستوى الأعلى فقط | §11 |
| L10 | الاحتفاظ | **ناجح طوال حياة الجلسة**، ويسقط بالحذف | §4.3 |
| D-B4-9 | التكرار بعد الانهيار | الرسائل لا تتكرر، والأدوات ممكن. الإضافة منعته | §9.4 |

**الملفات:**
- `src/gateway-link.js`:
  - اتصال إرسال ثانٍ تُحدَّد صلاحياته بـ `writeLinkProfile` (A افتراضيًا).
  - `WRITE_METHODS={chat.send, chat.abort}` ومدققاته، وحقن `suppressCommandInterpretation:true` في A.
  - `rpc` خاصة برموز `not_written` و`ack_lost` و`ack_timeout`.
  - قيم `hello-ok` (`maxPayload` و`maxImageBytes` و`attachments.maxBytes`).
  - قراءات `chat.history` و`agent.wait` بمدققات مغلقة.
  - `thread` على الموافقات (exec **وplugin**) والأحداث، وخريطة `approvalId → sessionKey`.
- `src/app-bridge.js`:
  - مسارات `/threads/*`، والقفل والسقف العام، والفحص المسبق (`{session:null}`)، وفحص الحجم.
  - مرشح الأوامر حسب الخيار، ورموز الرد (ومنها `cold`)، والمحلل بحسب المسار.
  - النص الحي من `deltaText`، ووسم الرد المستأنف، و`runIdOf` لصفوف `<K>:user`.
- `src/app-bridge-live.js`: موافقات `kind:"plugin"` (القائمة والحسم).
- `src/app-bridge-convo.js`: `threads/search`، و`legacy/reset`.
- `src/app-bridge-status.js`: القدرات، و`writeLinkProfile` الفعلي، وحالة تحميل إضافة الحماية (قيمة منطقية فقط).
- `src/server.js`: `validateSessionRpc`.
- **جديد: إضافة الحماية** (مثلًا `plugins/basht-resume-guard/`) مع ملف قائمة الأدوات الحساسة ومطابقة `execute_tools` بالمعاملات (§9.4). تُحمَّل عبر `plugins.load.paths`، **لكن تفعيلها في الإنتاج كتابة إعداد منفصلة**.
- `docs/BASHT_APP_BRIDGE.md`: حدود العزل (D-B4-1b)، وفرق الأدوات، و`[embed]`/`<details>`.

**اختبارات تفشل بدون التغيير:**
```

Lab-verified (L9) in a non-login clean-env shell: `IDLE`, `NOT_IDLE_OR_UNKNOWN` (busy, approval pending, cron < 20 min, gateway
down: `UNKNOWN_INPUTS …`) and `openclaw not on PATH`. Compact cron rows have only top-level `nextRunAtMs`. `openclaw` on PATH in the
production container's non-login shell is supported by the Dockerfile only (not observed).

### §11.3 procedure (every engine deploy, flag flip, or engine config write)

| Step | Who | What | Required |
|---|---|---|---|
| 1 | owner | 10 min before merge, "System status": `runs.complete`, `runs.total`, `runs.approvalsPending`, `link.state`, `wrapper.commit`, read time | `true`, `0`, `0`, `up` |
| 2 | operator | 10 min before merge, the §11.2 command in the container shell; stdout pasted verbatim into the PR "Release evidence" | `IDLE` |
| 3 | coordinator | quiet window: engine Railway logs, last 10 min | no `cli turn`, no `agent turn milestone`, no incoming WhatsApp, no cron start; keep app and WhatsApp idle until step 6 |
| 4 | owner | merge, after approval | build id recorded |
| 5 | owner + operator | build finished, before the swap: repeat 1 and 2 (> 3 s after the previous read) | not idle and not swapped ⇒ cancel the deployment; already swapped ⇒ step 6 as an incident check |
| 6 | coordinator | after the swap, engine logs | `[restart-resume] shutdown … "marked":0` and `startup … "resumed":0`, no `previous Gateway run ended unexpectedly`. Any non-zero stops everything: review what was resumed and whether external actions repeated |
| 7 | owner | verify | capabilities, one legacy turn, WhatsApp |

Window: no engine deploy 23:45–01:30 UTC (Dreaming 00:00, backup 00:30, weekly Friday 01:00), nor within 20 min of any cron job.
PR record: `{step, commit, build_id, t_check1, status_screen{complete,total,approvals,link,read_at}, gate_stdout_verbatim,
gate_operator, quiet_window_ok, t_merge, t_swap_recheck, gate_stdout_swap_verbatim, shutdown{marked}, startup{resumed},
startup_unexpected:false, disk{agent_db_bytes}, smoke_ok}`. Any missing answer is `unknown`, never a re-send.

## D-B4-9 plugin: `src/plugins/basht-resume-guard.mjs` (shipped disabled)

**What:** when the engine itself resumes a turn after a restart (trigger `"event"` + the restart-resume note), a sensitive tool call
in that resumed run needs a **fresh owner approval** (critical, plugin kind, listed by `openclaw approvals pending`, resolvable from the
app). Sensitive = a closed catalog: Daftra `execute_tools` whose `calls[].name` are not all read verbs (any write word or malformed
params ⇒ sensitive), and outbound `message`/`send_message`/`sessions_send`. Optional `injectIdempotencyKey` adds a stable
`idempotency_key` (sha256 of key | anchor K | tool | canonical args) for tool servers that honour one (Daftra: **unverified**).
Lab evidence: P2-B4-1-LAB §3.2 candidate 3 (fresh approval prevented every duplicate; deny ⇒ "The tool call did not run").

**Not loaded by anything:** no wrapper file adds it (tested). It is in the image at `/app/src/plugins/basht-resume-guard.mjs`
(the Dockerfile copies `src`), and inert until the operator enables it.

**Enable (production config write: owner approval + the gate, because the gateway reloads plugins):**

`config set` REPLACES an array, so the load path is merged with the existing ones first (the script refuses to guess when the
current value is not a JSON array or null; check `openclaw config get --help` for the output flag of your version first):

```bash
cur=$(openclaw config get plugins.load.paths --json 2>/dev/null)
new=$(node -e '
const raw = process.argv[1]; let cur;
try { cur = raw && raw.trim() ? JSON.parse(raw) : null; } catch { console.error("not JSON: stop"); process.exit(1); }
if (cur !== null && !Array.isArray(cur)) { console.error("not an array: stop"); process.exit(1); }
const p = "/app/src/plugins/basht-resume-guard.mjs"; const a = cur ?? [];
console.log(JSON.stringify(a.includes(p) ? a : [...a, p]));' "$cur") || exit 1
echo "plugins.load.paths: $cur -> $new"      # read it before writing
openclaw config set plugins.load.paths "$new" --strict-json
openclaw config set plugins.entries.basht-resume-guard '{"enabled":true,"hooks":{"allowConversationAccess":true}}' --strict-json
openclaw plugins list   # must show basht-resume-guard enabled; add this check to the release gate while it is on
```

Settings: the closed defaults (`mode: approve_on_resume`, both catalog entries, no key injection) apply unless the loader passes
`plugins.entries.basht-resume-guard.config` as `api.pluginConfig` (`{mode: approve_on_resume|approve_sensitive|block_on_resume,
sensitive: [ids], injectIdempotencyKey: bool}`; anything unknown ⇒ the defaults). Whether a standalone-file plugin may carry a
`config` block is **unverified** (the gateway may require it to be empty); the defaults need none.

**Disable:** remove the path from `plugins.load.paths` (the same merge script in reverse: write the array without it), or set `plugins.entries.basht-resume-guard.enabled:false`, then
`openclaw plugins reload basht-resume-guard` or a gated restart; `plugins list` must no longer show it.

**Residual risk (owner acceptance, D-B4-9):** the ambiguity of a call cut mid-execution remains (the owner must check external state
before approving); tools outside the catalog are not gated; hook firing on the `claude-cli` runtime is unverified; if the plugin
fails to load there is no guard (hence the `plugins list` check).
