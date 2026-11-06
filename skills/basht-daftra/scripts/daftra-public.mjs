// What an agent is allowed to see about a proposal. NEVER includes the approval phrase/code or auth MAC.
export function publicProposal(p) {
  return {
    ok: true, proposal_id: p.id, status: p.status, type: p.type, mode: p.mode, expires_at: p.expires_at,
    party: p.party, totals: p.totals, effects: p.effects, reversible: p.reversible,
    request: { method: p.request.method, path: p.request.path, query: p.request.query, body: p.request.body },
    checks: p.checks, blocking: p.blocking, warnings: p.warnings, duplicates: p.duplicates,
    request_hash: p.request_hash,
    next: p.status === 'READY_FOR_APPROVAL'
      ? 'NOTHING HAS BEEN SENT. Show this preview to the user and ask them to review and obtain the approval phrase from the operator tool: `node daftra-approve.mjs show ' + p.id + '` (run in a trusted shell). You cannot derive the phrase. Run execute only with the phrase the user sends you.'
      : 'BLOCKED: nothing can be executed. Fix the blocking items and propose again.',
  };
}
