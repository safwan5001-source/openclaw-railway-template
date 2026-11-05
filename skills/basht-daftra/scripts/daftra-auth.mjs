// Operator-held approval secret + HMAC helpers.
//
// Threat model: the agent (LLM) controls CLI arguments and can read/write the workspace, so proposals,
// the ledger and any approval phrase it can see or derive are untrusted. The ONLY thing it must not have
// is DAFTRA_APPROVAL_SECRET. Everything security-relevant is therefore authenticated with HMAC-SHA256
// under that secret:
//   - proposals   : `auth` MAC over every field that influences what is sent or checked
//   - ledger      : each line carries a MAC chained to the previous line (edits are detected)
//   - approval    : a per-proposal code the HUMAN obtains from the operator tool `daftra-approve.mjs`
//                   (run in a trusted shell), never printed by the agent-facing CLI
// Limit: if the agent can read the server's environment it can compute these itself. Keep the secret out of
// the agent's exec environment (operator shell / separate service) where the platform allows it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './daftra-finance-preflight.mjs';

export class ApprovalConfigError extends Error {
  constructor(message) { super(message); this.name = 'ApprovalConfigError'; this.code = 'APPROVAL_NOT_CONFIGURED'; }
}

export function approvalSecret(env = process.env) {
  const s = env.DAFTRA_APPROVAL_SECRET;
  if (typeof s !== 'string' || s.length < 32)
    throw new ApprovalConfigError('DAFTRA_APPROVAL_SECRET (at least 32 characters, held by the operator) is required for financial operations');
  return s;
}

export function mac(env, label, value) {
  return createHmac('sha256', approvalSecret(env)).update(label + '\n' + canonicalJson(value)).digest('hex');
}

export function macEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Everything that decides WHAT is sent and WHETHER it may be sent. `status` is deliberately excluded
// (it changes during execution); eligibility comes from `ready` (fixed at creation) and the ledger.
export function signedFields(p) {
  return {
    id: p.id, type: p.type, created_at: p.created_at, expires_at: p.expires_at, actor: p.actor, mode: p.mode,
    effects: p.effects, totals: p.totals, party: p.party, request: p.request, request_hash: p.request_hash,
    acknowledged_duplicates: p.acknowledged_duplicates ?? [], ready: p.ready === true,
  };
}
export const proposalAuth = (env, proposal) => mac(env, 'proposal', signedFields(proposal));

export const approvalCode = (env, p) => mac(env, 'approve', { id: p.id, request_hash: p.request_hash, expires_at: p.expires_at, mode: p.mode }).slice(0, 16);
export const resolveCode = (env, id, created) => mac(env, 'resolve', { id, created: created === true }).slice(0, 16);

// What the human types in chat. Only derivable with the operator secret.
export function approvalPhrase(env, p) {
  return 'APPROVE ' + p.id + ' ' + p.request_hash.slice(0, 8) + ' ' + (p.mode === 'draft' ? 'DRAFT' : 'FINAL') + ' ' + approvalCode(env, p);
}
