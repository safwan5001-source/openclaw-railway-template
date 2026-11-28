// BASHT app bridge: how much work is running right now, for GET /app/v1/status `runs` (deploy tooling reads it before a restart).
//
// A restart makes the gateway re-run interrupted turns, which can repeat side effects, so "is anything running?" has to look beyond
// this bridge's own app turns. Sources, all read-only, over the existing persistent gateway link, counts only:
//   active            the app turns this bridge holds right now (in memory, always known)
//   engine            sessions.list {activeOnly: true} -> `totalCount`: every session with a queued or running turn, across ALL sessions
//                     (WhatsApp chats, the app, subagents: the gateway's live-run projection, before pagination). Isolated cron-run sessions are NOT
//                     in this list (the gateway filters them out): they are covered only by `cron` below.
//   cron              cron.list (compact) -> jobs whose `runningAtMs` is set; a truncated list (hasMore) is unknown, never a guess
//   approvalsPending  the approvals this link is tracking (events + resync); unknown while the link is down OR until every approval list
//                     was read on the current connection (`link.approvalsSynced()`): an empty, not-yet-synced map is never reported as zero
//   total             active + engine + cron (known parts only). The parts overlap (the app's own turn is also an active session, a
//                     running cron job also has a session): use `total` only as "is it zero", never as a number of runs.
//   complete          true only when engine, cron and approvalsPending were all obtained
// A source that cannot be read is null and makes `complete` false. Nothing here carries a session key, a phone number, a job id or a
// path: the rows are counted and dropped. Not covered (see docs/BASHT_APP_BRIDGE.md): work that starts right after the check,
// runs outside the session index (sessionless/internal runs, background exec, media generation, memory flush / compaction internals),
// and other services (e.g. a broker).
import { CRON_RUNNING_PARAMS, SESSIONS_ACTIVE_PARAMS } from "./gateway-link.js";

export const RUNS_CACHE_MS = 3_000; // one pair of reads serves every status poll within this window
const READ_TIMEOUT_MS = 4_000;

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Running sessions from a `sessions.list` answer, or null when it is not the shape we asked for. */
export function engineCount(r) {
  return r && typeof r === "object" ? count(r.totalCount) : null;
}

/** Running cron jobs from a compact `cron.list` answer, or null (not the expected shape, or more jobs than one page: unknown). */
export function cronCount(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.jobs) || r.hasMore === true) return null;
  return r.jobs.filter((j) => j && typeof j === "object" && (typeof j.runningAtMs === "number" || typeof j.state?.runningAtMs === "number")).length;
}

/**
 * @param {{ link?: { isUp(): boolean, request(m: string, p: object, o?: object): Promise<any>, status(): { pendingApprovals?: number } } | null,
 *           now?: () => number, ttlMs?: number }} o
 * @returns {{ read(activeApp: number): Promise<{ active: number, engine: number | null, cron: number | null, approvalsPending: number | null, total: number, complete: boolean }> }}
 */
export function createRunsProbe({ link, now = Date.now, ttlMs = RUNS_CACHE_MS } = {}) {
  let cached = null; // { at, engine, cron }
  let pending = null;

  async function readSources() {
    if (!link?.isUp?.()) return { engine: null, cron: null };
    const ask = (method, params, parse) => link.request(method, params, { timeoutMs: READ_TIMEOUT_MS }).then(parse, () => null);
    const [engine, cron] = await Promise.all([
      ask("sessions.list", { ...SESSIONS_ACTIVE_PARAMS }, engineCount),
      ask("cron.list", { ...CRON_RUNNING_PARAMS }, cronCount),
    ]);
    return { engine, cron };
  }

  async function sources() {
    if (cached && now() - cached.at < ttlMs) return cached;
    // stamped when the reads START: the answer is never presented as fresher than the moment it was asked for
    const at = now();
    pending ??= readSources().then((r) => { cached = { at, ...r }; return cached; }).finally(() => { pending = null; });
    return pending;
  }

  return {
    async read(activeApp) {
      const { engine, cron } = await sources();
      const up = link?.isUp?.() === true;
      // The approval map is only authoritative once every list was read on this connection; before that (or after a failed read) it is unknown.
      const approvals = up && link.approvalsSynced?.() === true ? count(link.status()?.pendingApprovals) : null;
      return {
        active: activeApp, engine, cron, approvalsPending: approvals,
        total: activeApp + (engine ?? 0) + (cron ?? 0),
        complete: engine !== null && cron !== null && approvals !== null,
      };
    },
  };
}
