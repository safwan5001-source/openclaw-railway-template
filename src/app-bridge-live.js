// BASHT app bridge, live part (B0 events + B3 approvals). Mounted by src/app-bridge.js under /app/v1 (same Bearer gate).
//
//   GET  /app/v1/events?after=<id>&wait=<s>  -> ring records newer than `after` (oldest first, ≤100); `wait` ≤ 25 s long-polls
//   GET  /app/v1/approvals                   -> pending approvals (exec, plugin, system-agent) in a fixed shape
//   GET  /app/v1/approvals/history?limit=N   -> recent decided approvals (≤50), fixed shape
//   POST /app/v1/approvals/:id {decision}    -> "allow-once" | "deny" only; approval.resolve over the link (first answer wins)
//
// Everything goes through the persistent gateway link (src/gateway-link.js). When the link is not up, these routes say so
// (503 link_down) instead of guessing; nothing falls back to answering on the owner's behalf.
import express from "express";
import { APP_SESSION_KEY, APPROVAL_KINDS, MAX_SUMMARY, approvalView, sessionKind } from "./gateway-link.js";

export const DECISIONS = Object.freeze(["allow-once", "deny"]); // never "allow-always": that would mint a standing grant
export const APPROVAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const KINDS = Object.values(APPROVAL_KINDS);
const LIST = [["exec.approval.list", "exec"], ["plugin.approval.list", "plugin"], ["openclaw.approval.list", "system-agent"]];
const MAX_WAIT_S = 25;
const MAX_HISTORY = 50;

const str = (v, max = 200) => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null;
};
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const kindOf = (v) => (KINDS.includes(v) ? v : v === "openclaw" ? "system-agent" : null);

/** One approval.history / approval.resolve projection in a fixed shape. */
export function decidedView(a) {
  const id = str(a?.id, 128);
  if (!id) return null;
  const p = a.presentation && typeof a.presentation === "object" ? a.presentation : {};
  const r = a.resolver && typeof a.resolver === "object" ? a.resolver : {};
  return {
    id, kind: kindOf(p.kind), summary: str(p.commandPreview, MAX_SUMMARY) ?? str(p.commandText, MAX_SUMMARY) ?? str(p.title, MAX_SUMMARY),
    status: str(a.status, 20), decision: ["allow-once", "allow-always", "deny"].includes(a.decision) ? a.decision : null,
    reason: str(a.reason, 40), session: sessionKind(a.source?.sessionKey),
    by: r.kind === "system" ? "system" : r.kind === "runtime" && r.id === "gateway-client" ? "app" : r.kind ? "other" : null,
    createdAt: int(a.createdAtMs), resolvedAt: int(a.resolvedAtMs), expiresAt: int(a.expiresAtMs),
  };
}

/**
 * @param {{ link: ReturnType<import("./gateway-link.js").createGatewayLink> | null | undefined, log?: any }} o
 */
export function createLiveRoutes({ link, log }) {
  const router = express.Router();
  const linkStatus = () => (link ? link.status() : { state: "off" });
  const linkDown = (res) => res.status(503).json({ ok: false, error: link ? "link_down" : "not_available", link: linkStatus() });
  const need = (res) => { if (link?.isUp()) return false; linkDown(res); return true; };
  const fail = (res, err, what) => {
    if (err?.code === "link_down") return linkDown(res);
    log?.warn?.("app-bridge", `${what}: ${err?.code ?? err?.message ?? err}`);
    return res.status(502).json({ ok: false, error: "engine_unavailable" });
  };

  router.get("/events", async (req, res) => {
    if (!link) return linkDown(res);
    const after = Number.parseInt(String(req.query.after ?? "0"), 10);
    const a = Number.isSafeInteger(after) && after > 0 ? after : 0;
    const wait = Math.min(Math.max(Number.parseInt(String(req.query.wait ?? "0"), 10) || 0, 0), MAX_WAIT_S);
    if (wait > 0) {
      const ctl = new AbortController();
      res.on("close", () => ctl.abort());
      await link.waitForEvents(a, wait * 1000, ctl.signal);
      if (ctl.signal.aborted && res.writableEnded) return;
    }
    const r = link.events(a, 100);
    res.json({ ok: true, ...r, link: linkStatus() });
  });

  router.get("/approvals", async (_req, res) => {
    if (need(res)) return;
    const results = await Promise.allSettled(LIST.map(([m]) => link.request(m, {})));
    if (results.every((r) => r.status === "rejected")) return fail(res, results[0].reason, "approvals");
    const approvals = [];
    results.forEach((r, i) => {
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) return;
      for (const row of r.value) { const v = approvalView(row, LIST[i][1]); if (v) approvals.push(v); }
    });
    approvals.sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
    res.json({ ok: true, approvals, partial: results.some((r) => r.status === "rejected"), link: linkStatus() });
  });

  router.get("/approvals/history", async (req, res) => {
    if (need(res)) return;
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), MAX_HISTORY);
    try {
      const h = await link.request("approval.history", {});
      const items = (Array.isArray(h?.items) ? h.items : []).map(decidedView).filter(Boolean).slice(0, limit);
      res.json({ ok: true, items });
    } catch (err) { fail(res, err, "approval history"); }
  });

  router.post("/approvals/:id", async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!APPROVAL_ID_RE.test(id)) return res.status(400).json({ ok: false, error: "bad_id" });
    const decision = req.body?.decision;
    if (!DECISIONS.includes(decision)) return res.status(400).json({ ok: false, error: "bad_decision" });
    if (need(res)) return;
    try {
      // the kind comes from the gateway's own record (live event or approval.get), never from the caller
      let kind = link.pendingKind(id);
      if (!kind) {
        const g = await link.request("approval.get", { id }).catch((e) => { if (e?.refused) return null; throw e; });
        kind = kindOf(g?.approval?.presentation?.kind);
        if (!kind) return res.status(404).json({ ok: false, error: "not_found" });
        if (g.approval.status && g.approval.status !== "pending") {
          return res.json({ ok: true, applied: false, approval: decidedView(g.approval) });
        }
      }
      const r = await link.request("approval.resolve", { id, kind, decision });
      link.forgetApproval(id);
      res.json({ ok: true, applied: r?.applied === true, approval: decidedView(r?.approval) });
    } catch (err) {
      if (err?.refused) {
        const notFound = err.reason === "APPROVAL_NOT_FOUND" || /not found|expired/i.test(err.message ?? "");
        return res.status(notFound ? 404 : 400).json({ ok: false, error: notFound ? "not_found" : "rejected" });
      }
      fail(res, err, "approval resolve");
    }
  });

  return router;
}

export { APP_SESSION_KEY };
