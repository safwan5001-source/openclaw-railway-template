// What an agent is allowed to see about a proposal. NEVER includes the approval phrase/code or auth MAC.
export function publicProposal(p, { service = false } = {}) {
  return {
    ok: true, proposal_id: p.id, status: p.status, type: p.type, mode: p.mode, expires_at: p.expires_at,
    party: p.party, totals: p.totals, effects: p.effects, reversible: p.reversible,
    request: { method: p.request.method, path: p.request.path, query: p.request.query, body: p.request.body },
    checks: p.checks, blocking: p.blocking, warnings: p.warnings, duplicates: p.duplicates,
    request_hash: p.request_hash,
    meta: p.meta ?? null,
    review: formatMeta(p.meta),
    next: service ? (p.status === 'READY_FOR_APPROVAL'
      ? 'NOTHING HAS BEEN SENT. Only the operator can approve this proposal, in the approval console on a separate device. You cannot approve or execute it and there is no phrase to relay. Poll `status <proposal-id>` for the outcome.'
      : 'BLOCKED: nothing can be executed. Fix the blocking items and propose again.')
    : p.status === 'READY_FOR_APPROVAL'
      ? 'NOTHING HAS BEEN SENT. Show this preview to the user and ask them to review and obtain the approval phrase from the operator tool: `node daftra-approve.mjs show ' + p.id + '` (run in a trusted shell). You cannot derive the phrase. Run execute only with the phrase the user sends you.'
      : 'BLOCKED: nothing can be executed. Fix the blocking items and propose again.',
  };
}

// Everything printed to a human/terminal passes through here: control characters (ESC, CR, LF, C1 incl. CSI),
// zero-width and bidi-override characters are shown as visible \uXXXX escapes so no value can forge or hide lines.
export function safeText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu,
    (c) => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));
}

// Human-readable comparison shown by the operator tool and the agent preview.
export function formatMeta(meta) {
  if (!meta) return [];
  const out = [];
  const money = (v) => (v === null || v === undefined ? '-' : safeText(v));
  if (meta.duplicate_of) {
    const d = meta.diff;
    out.push('DUPLICATE OF ' + safeText(meta.duplicate_of.entity) + '#' + safeText(meta.duplicate_of.id) + (d?.original?.number ? ' (no. ' + safeText(d.original.number) + ')' : '') + ' -> a NEW document (own id/number from Daftra)');
    for (const h of d?.header ?? []) out.push('  header ' + safeText(h.field) + ': ' + money(h.original) + '  =>  ' + money(h.proposed));
    for (const l of d?.lines ?? []) {
      if (l.proposed === null) out.push('  line ' + l.n + ': REMOVED (' + safeText(l.original.item) + ')');
      else if (l.n === null) out.push('  line +: ADDED ' + safeText(JSON.stringify(l.proposed)));
      else if (l.changed.length) out.push('  line ' + l.n + ' (' + safeText(l.original.item) + '): ' + l.changed.map((k) => safeText(k) + ' ' + money(l.original[k]) + ' => ' + money(l.proposed[k])).join('; '));
      else out.push('  line ' + l.n + ' (' + safeText(l.original.item) + '): unchanged');
    }
    if (d?.not_copied?.length) out.push('  NOT copied: ' + safeText(d.not_copied.join(', ')));
  }
  for (const c of meta.changes ?? []) out.push('  change ' + safeText(c.field) + ': ' + money(typeof c.from === 'object' && c.from !== null ? JSON.stringify(c.from) : c.from) + '  =>  ' + (typeof c.to === 'object' && c.to !== null ? safeText(JSON.stringify(c.to)) : money(c.to)));
  for (const h of meta.highlights ?? []) out.push('  *** KEY FIELD CHANGE ' + safeText(h.field) + ': ' + money(h.from) + ' => ' + money(h.to) + ' ***');
  if (meta.carried_fields?.length) out.push('  (full record is sent; unchanged fields carried over: ' + safeText(meta.carried_fields.join(', ')) + ')');
  for (const c of meta.price_changes ?? []) out.push('  *** PRICE CHANGE ' + safeText(c.field) + ': ' + money(c.from) + ' => ' + money(c.to) + (c.change_percent === null ? '' : ' (' + (c.change_percent > 0 ? '+' : '') + c.change_percent + '%)') + ' ***');
  return out;
}
