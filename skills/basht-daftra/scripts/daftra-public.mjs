// What an agent is allowed to see about a proposal. NEVER includes the approval phrase/code or auth MAC.
export function publicProposal(p) {
  return {
    ok: true, proposal_id: p.id, status: p.status, type: p.type, mode: p.mode, expires_at: p.expires_at,
    party: p.party, totals: p.totals, effects: p.effects, reversible: p.reversible,
    request: { method: p.request.method, path: p.request.path, query: p.request.query, body: p.request.body },
    checks: p.checks, blocking: p.blocking, warnings: p.warnings, duplicates: p.duplicates,
    request_hash: p.request_hash,
    meta: p.meta ?? null,
    review: formatMeta(p.meta),
    next: p.status === 'READY_FOR_APPROVAL'
      ? 'NOTHING HAS BEEN SENT. Show this preview to the user and ask them to review and obtain the approval phrase from the operator tool: `node daftra-approve.mjs show ' + p.id + '` (run in a trusted shell). You cannot derive the phrase. Run execute only with the phrase the user sends you.'
      : 'BLOCKED: nothing can be executed. Fix the blocking items and propose again.',
  };
}

// Human-readable comparison shown by the operator tool and the agent preview.
export function formatMeta(meta) {
  if (!meta) return [];
  const out = [];
  const money = (v) => (v === null || v === undefined ? '-' : String(v));
  if (meta.duplicate_of) {
    const d = meta.diff;
    out.push('DUPLICATE OF ' + meta.duplicate_of.entity + '#' + meta.duplicate_of.id + (d?.original?.number ? ' (no. ' + d.original.number + ')' : '') + ' -> a NEW document (own id/number from Daftra)');
    for (const h of d?.header ?? []) out.push('  header ' + h.field + ': ' + money(h.original) + '  =>  ' + money(h.proposed));
    for (const l of d?.lines ?? []) {
      if (l.proposed === null) out.push('  line ' + l.n + ': REMOVED (' + l.original.item + ')');
      else if (l.n === null) out.push('  line +: ADDED ' + JSON.stringify(l.proposed));
      else if (l.changed.length) out.push('  line ' + l.n + ' (' + l.original.item + '): ' + l.changed.map((k) => k + ' ' + money(l.original[k]) + ' => ' + money(l.proposed[k])).join('; '));
      else out.push('  line ' + l.n + ' (' + l.original.item + '): unchanged');
    }
    if (d?.not_copied?.length) out.push('  NOT copied: ' + d.not_copied.join(', '));
  }
  for (const c of meta.changes ?? []) out.push('  change ' + c.field + ': ' + money(typeof c.from === 'object' ? JSON.stringify(c.from) : c.from) + '  =>  ' + (typeof c.to === 'object' ? JSON.stringify(c.to) : money(c.to)));
  for (const c of meta.price_changes ?? []) out.push('  *** PRICE CHANGE ' + c.field + ': ' + money(c.from) + ' => ' + c.to + (c.change_percent === null ? '' : ' (' + (c.change_percent > 0 ? '+' : '') + c.change_percent + '%)') + ' ***');
  return out;
}
