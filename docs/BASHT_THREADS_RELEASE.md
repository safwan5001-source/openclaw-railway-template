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
- **Plugin:** `plugins.entries.basht-resume-guard.enabled false`, keeping the load path (see below). Never remove the path as a rollback.

## Release gate (plan §11): operator-run only

No agent statement counts as evidence; BASHT sessions never run or relay the gate. Only the operator (Railway shell / ssh into the
engine container) or the owner reading the app's "System status" screen (`/app/v1/status`, deterministic code) may supply it.

### §11.2 idle command (node; `jq` is not in the container)

```bash
# Run by the OPERATOR in the engine container's shell (never from a BASHT session). Prints counts only. Paste the output verbatim.
command -v openclaw >/dev/null || { echo "openclaw not on PATH"; echo NOT_IDLE_OR_UNKNOWN; exit 1; }
node -e '
const {execFileSync}=require("child_process");
const run=(a)=>{try{return JSON.parse(execFileSync("openclaw",a,{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:30000}))}catch{return null}};
const s=run(["gateway","call","sessions.list","--params",JSON.stringify({activeOnly:true,limit:1,includeGlobal:true,includeUnknown:true}),"--json"]);
const a=run(["approvals","pending","--json"]);
const c=run(["gateway","call","cron.list","--params",JSON.stringify({includeDisabled:true,limit:200,compact:true,includeDeliveryPreviews:false}),"--json"]);
const now=Date.now();
const active=Number.isInteger(s?.totalCount)?s.totalCount:null;
const approvals=Array.isArray(a?.approvals)?a.approvals.length:null;
const jobs=Array.isArray(c?.jobs)&&c.hasMore!==true?c.jobs:null;
const cronRunning=jobs?jobs.filter(j=>typeof j.runningAtMs==="number"||typeof j?.state?.runningAtMs==="number").length:null;
const enabled=jobs?jobs.filter(j=>j.enabled!==false):null;
const nexts=enabled?enabled.map(j=>j.nextRunAtMs??j?.state?.nextRunAtMs):null;
const nextOk=nexts!==null&&nexts.every(n=>typeof n==="number");      // a missing field is unknown, never "no job"
const minToNextCron=nextOk?(nexts.length?Math.floor((Math.min(...nexts)-now)/60000):Infinity):null;
const t=new Date(now), hm=t.getUTCHours()*60+t.getUTCMinutes();
const inBlackout=hm>=23*60+45||hm<90;   // 23:45–01:30 UTC
const out={at:t.toISOString(),activeSessions:active,pendingApprovals:approvals,cronRunning,minToNextCron:minToNextCron===Infinity?"none":minToNextCron,inBlackout};
const nulls=Object.entries(out).filter(([,v])=>v===null).map(([k])=>k);
console.log(JSON.stringify(out));
if(nulls.length) console.log("UNKNOWN_INPUTS "+nulls.join(","));
const ok=!nulls.length&&active===0&&approvals===0&&cronRunning===0&&(minToNextCron===Infinity||minToNextCron>=20)&&!inBlackout;
console.log(ok?"IDLE":"NOT_IDLE_OR_UNKNOWN");'
```

This is `lab/b4lab2/tools/gate-11.2.sh`, the plan §11.2 command run verbatim by the P2-B4-1 lab (only the first comment line is
translated). Lab-verified (L9) in a non-login clean-env shell: `IDLE`, `NOT_IDLE_OR_UNKNOWN` (busy, approval pending, cron < 20 min, gateway
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

`config set` REPLACES an array, so the load path is merged with the existing ones first (the script stops when `config get` fails, and refuses to
guess when the current value is not a JSON array or null; check `openclaw config get --help` for the output flag of your version first):

```bash
# a FAILING `config get` must stop here: never read as "no paths" (that would overwrite the existing ones)
cur=$(openclaw config get plugins.load.paths --json) || { echo "config get failed: stop, nothing written"; exit 1; }
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

Settings: **none.** The plugin always runs its built-in defaults: `approve_on_resume`, both catalog entries (Daftra
`execute_tools` writes, outbound message tools), no idempotency-key injection. Do **not** add a
`plugins.entries.basht-resume-guard.config` block: OpenClaw 2026.11.10 gives a standalone plugin file an empty config schema and
refuses it (`must not have additional properties: "mode"`, integration BUG-4); a hand-edited block would make the whole config
invalid (the BUG-3 outage class). Changing the mode means changing the code (`DEFAULT_CONFIG`) and a reviewed deploy.

**Disable (the rollback): set `enabled:false` and KEEP the load path.**

```bash
openclaw config set plugins.entries.basht-resume-guard.enabled false --strict-json
openclaw config validate          # must be valid
openclaw plugins list             # basht-resume-guard: disabled
```

It hot-reloads (no restart) and a crash then behaves exactly as without the guard (integration `s10-disabled-by-flag`).
**Never remove the path from `plugins.load.paths` while the entry exists** (and not "entry first, then path" either): the config
becomes invalid (`plugin manifest not found`), every later `config set` is refused, and the next gateway restart exits with code 78;
the wrapper's single auto-restart then fails and WhatsApp and the app stay down until a redeploy (integration BUG-3). The wrapper's
boot runs `openclaw doctor --fix` before starting the gateway, which turns such an entry into "stale config entry ignored": full
removal of the path and the entry is therefore done only together with a gated redeploy, never as a live rollback. (Wrapper
hardening, e.g. `doctor --fix` before an auto-restart, is a separate lifecycle change outside this batch.)

**Residual risk (owner acceptance, D-B4-9):** the ambiguity of a call cut mid-execution remains (the owner must check external state
before approving); tools outside the catalog are not gated; hook firing on the `claude-cli` runtime is unverified; if the plugin
fails to load there is no guard (hence the `plugins list` check).
