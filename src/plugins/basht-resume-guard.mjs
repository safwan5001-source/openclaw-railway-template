// BASHT resume guard (D-B4-9): a small, trusted, STANDALONE OpenClaw plugin. NOT loaded unless the operator adds it to the gateway
// config explicitly (docs/BASHT_THREADS_RELEASE.md "D-B4-9 plugin"); nothing in the wrapper loads it, and it is shipped disabled.
//
// What it does (and nothing else), mirroring the lab-verified guard (scratchpad lab b4lab2/tools/b4guard.mjs, mode
// "approve_on_resume", P2-B4-1-LAB §3.2 candidate 3 and §3.3):
//   1. before_agent_run: marks a run as RESUMED when ctx.trigger === "event" AND its prompt is the engine's restart-resume note
//      ("The previous agent run was interrupted…" / "The Gateway restarted while you were working…"). User turns are trigger "user".
//   2. before_tool_call: for a SENSITIVE tool call inside a marked run, returns `requireApproval` (critical): a FRESH owner approval,
//      listed by `openclaw approvals pending` and resolvable from the app (plugin kind). The owner decides; nothing re-runs silently.
//      Mode "approve_sensitive" asks for every sensitive call (also outside resumed runs); "block_on_resume" refuses instead of asking.
//   3. Off in the shipped defaults (no config surface, BUG-4): can inject a stable `idempotency_key` into a sensitive call's params, for tool servers that honour
//      one (the real Daftra API support is UNVERIFIED). Anchored on the chat.send id of the user turn being served.
// Sensitive tools come from a CLOSED catalog (SENSITIVE_CATALOG); DEFAULT_CONFIG turns both entries on.
// Daftra writes go through `execute_tools` {calls:[{name, arguments}]}: the inspector treats a call as a read ONLY when every
// inner tool name is a read verb; anything else (or anything malformed) is sensitive (fail closed). A thrown hook blocks the call.
// Known heuristic limit (review m9): a read-verb name with an UNLISTED write word (reset, generate, sync, upload, toggle, …) passes
// as a read, and export/download/report_gap count as reads. Replace READ_VERB with an explicit allowlist from the real Daftra
// catalog before enabling in production.
import crypto from "node:crypto";

export const PLUGIN_ID = "basht-resume-guard";
export const RESUME_RE = /The Gateway restarted while you were working|previous agent run was interrupted/;
export const MODES = Object.freeze(["approve_on_resume", "approve_sensitive", "block_on_resume"]);
const READ_VERB = /^(?:daftra_)?(?:list|get|search|find|show|view|read|count|fetch|lookup|describe|whoami|capabilities|my_connection|report_gap|list_modules|search_tools|export|download|preview|summary|stats|balance|status)(?:_|$)/;
// a write word anywhere in the name makes it sensitive even behind a read verb ("list_and_delete_x")
const WRITE_WORD = /(?:^|_)(?:create|add|new|update|edit|modify|delete|remove|void|cancel|send|email|post|record|pay|payment|refund|approve|reject|issue|convert|import|set|assign|close|reopen|archive|restore|submit|transfer|write)(?:_|$)/;
const MAX_RUNS = 500;

/** One execute_tools call list is a READ only when it is well formed and every inner tool name is a read verb. */
export function daftraCallsAreReadOnly(params) {
  const calls = params?.calls;
  if (!Array.isArray(calls) || !calls.length || calls.length > 50) return false;
  return calls.every((c) => c && typeof c === "object" && typeof c.name === "string" && c.name.length <= 255
    && READ_VERB.test(c.name.toLowerCase()) && !WRITE_WORD.test(c.name.toLowerCase()));
}

/**
 * The closed catalog: id -> { matches(toolName), sensitive(params) }. Tool names may carry a server prefix
 * (e.g. "daftra-mcp__execute_tools", "daftra__execute_tools").
 */
export const SENSITIVE_CATALOG = Object.freeze({
  "daftra.execute_tools": Object.freeze({ matches: (n) => /(?:^|__|[_-])execute_tools$/.test(n), sensitive: (p) => !daftraCallsAreReadOnly(p) }),
  "message.send": Object.freeze({ matches: (n) => n === "message" || /(?:^|__)(?:message|send_message|sessions_send)$/.test(n), sensitive: () => true }),
});
export const DEFAULT_CONFIG = Object.freeze({ mode: "approve_on_resume", sensitive: Object.freeze(["daftra.execute_tools", "message.send"]), injectIdempotencyKey: false });

/**
 * NO config surface (integration BUG-4): OpenClaw 2026.11.10 gives a standalone plugin file an empty config schema, so any
 * `plugins.entries.basht-resume-guard.config` block is refused ("must not have additional properties") and would make the gateway
 * config invalid. The plugin therefore always runs DEFAULT_CONFIG; other modes exist for tests and a future reviewed code change.
 */

export function isSensitive(config, toolName, params) {
  if (typeof toolName !== "string") return false;
  return config.sensitive.some((id) => SENSITIVE_CATALOG[id].matches(toolName) && SENSITIVE_CATALOG[id].sensitive(params));
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== "idempotency_key").map((k) => [k, canon(v[k])])) : v);
const anchorOf = (msgs) => {
  for (const m of [...(Array.isArray(msgs) ? msgs : [])].reverse()) {
    const k = m?.__openclaw?.idempotencyKey ?? m?.idempotencyKey;
    if (m?.role === "user" && typeof k === "string" && k) return k.replace(/:user$/, "");
  }
  return null;
};
/** sha256(sessionKey | anchor | tool | canonical args), 32 hex: the same call in the resumed run gets the same key. */
export function idempotencyKeyFor(sessionKey, anchor, toolName, params) {
  return crypto.createHash("sha256").update(`${sessionKey}|${anchor}|${toolName}|${JSON.stringify(canon(params))}`).digest("hex").slice(0, 32);
}

/** The hook handlers (exported for tests). `config` is the resolved config; `log` an optional (line) => void. */
export function createGuard(config, log = () => {}) {
  const resumed = new Set();
  const anchors = new Map();
  const mark = (set, k, v) => { if (set instanceof Map) set.set(k, v); else set.add(k); while (set.size > MAX_RUNS) set.delete(set.keys().next().value); };
  return {
    resumed,
    // before_agent_run is fail-closed in the engine: a throw here would block EVERY run (WhatsApp included), so it never throws
    // (review m9). A run it could not inspect is simply not marked; sensitive calls are still gated by before_tool_call's own rules.
    before_agent_run(event, ctx) {
      try {
        const runId = ctx?.runId;
        if (!runId) return undefined;
        if (ctx.trigger === "event" && RESUME_RE.test(String(event?.prompt ?? ""))) { mark(resumed, runId); log(`resumed run marked`); }
        mark(anchors, runId, ctx.trigger === "user" ? runId : anchorOf(event?.messages));
      } catch { /* never block a run from here */ }
      return undefined;
    },
    before_tool_call(event, ctx) {
      const toolName = event?.toolName;
      const params = event?.params;
      if (!isSensitive(config, toolName, params)) return undefined;
      const runId = ctx?.runId ?? event?.runId;
      const inResume = resumed.has(runId);
      const extra = config.injectIdempotencyKey && params && typeof params === "object" && !Array.isArray(params)
        ? { params: { ...params, idempotency_key: idempotencyKeyFor(ctx?.sessionKey, anchors.get(runId) ?? "no-anchor", toolName, params) } } : {};
      if (config.mode === "block_on_resume" && inResume) {
        return { block: true, blockReason: "Blocked: sensitive tool in a run the engine resumed after a restart. Ask the owner to confirm first; the earlier attempt's outcome is unknown." };
      }
      if (config.mode === "approve_sensitive" || (config.mode === "approve_on_resume" && inResume)) {
        return { ...extra, requireApproval: {
          title: inResume ? "تشغيل مستأنف بعد إعادة التشغيل" : "أداة حساسة",
          description: `${inResume ? "RESUMED RUN after a gateway restart: the earlier attempt's outcome is unknown. Check the external state first. " : ""}Allow ${String(toolName).slice(0, 80)}?`,
          severity: "critical", timeoutMs: 30 * 60_000, allowedDecisions: ["allow-once", "deny"],
        } };
      }
      return Object.keys(extra).length ? extra : undefined;
    },
  };
}

export default {
  id: PLUGIN_ID,
  name: "BASHT resume guard",
  description: "Fresh owner approval for sensitive tools in runs the engine resumed after a restart (D-B4-9).",
  register(api) {
    const config = DEFAULT_CONFIG; // never api.pluginConfig (see above)
    const log = (line) => api?.logger?.info?.(`[${PLUGIN_ID}] ${line}`);
    const g = createGuard(config, log);
    api.on("before_agent_run", (event, ctx) => g.before_agent_run(event, ctx));
    api.on("before_tool_call", (event, ctx) => g.before_tool_call(event, ctx));
  },
};
