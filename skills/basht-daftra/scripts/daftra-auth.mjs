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
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonicalJson } from './daftra-canonical.mjs';

export class ApprovalConfigError extends Error {
  constructor(message) { super(message); this.name = 'ApprovalConfigError'; this.code = 'APPROVAL_NOT_CONFIGURED'; }
}

// Load a secret either from NAME (environment) or from NAME_FILE (a path). The file form is what the privileged
// broker uses so that the secret never sits in any process environment an agent could read.
// File rules (fail closed): absolute path, a REGULAR file reached WITHOUT following a symlink, and not accessible
// by group/others (mode & 0o077 === 0) unless DAFTRA_ALLOW_INSECURE_SECRET_FILE=1 (tests only). Trailing newline trimmed.
const fileCache = new Map();
export function readSecretFile(path, env = process.env) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new ApprovalConfigError('Secret file path must be absolute');
  let st;
  try { st = lstatSync(path); } catch { throw new ApprovalConfigError('Secret file is not readable'); }
  if (st.isSymbolicLink() || !st.isFile()) throw new ApprovalConfigError('Secret file must be a regular file (symlinks are refused)');
  if ((st.mode & 0o077) !== 0 && env.DAFTRA_ALLOW_INSECURE_SECRET_FILE !== '1')
    throw new ApprovalConfigError('Secret file must not be accessible by group/others (chmod 0400 or 0600)');
  const key = path + '|' + st.ino + '|' + st.mtimeMs + '|' + st.size;
  const hit = fileCache.get(path);
  if (hit && hit.key === key) return hit.value;
  let value;
  try { value = readFileSync(path, 'utf8').replace(/\r?\n$/, ''); } catch { throw new ApprovalConfigError('Secret file is not readable'); }
  fileCache.set(path, { key, value });
  return value;
}
// NAME_FILE wins over NAME. Returns undefined when neither is set.
export function readSecret(env, name) {
  const file = env[name + '_FILE'];
  if (file !== undefined && file !== '') return readSecretFile(file, env);
  return env[name];
}

export function approvalSecret(env = process.env) {
  const s = readSecret(env, 'DAFTRA_APPROVAL_SECRET');
  if (typeof s !== 'string' || s.length < 32)
    throw new ApprovalConfigError('DAFTRA_APPROVAL_SECRET or DAFTRA_APPROVAL_SECRET_FILE (at least 32 characters, held by the operator) is required for financial operations');
  return s;
}

// The Daftra tenant (host of DAFTRA_BASE_URL) a deployment is pinned to; proposals are signed for exactly one.
export function tenantOf(env) {
  try { const u = new URL(env.DAFTRA_BASE_URL || ''); return u.protocol === 'https:' ? u.host : null; } catch { return null; }
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
    acknowledged_duplicates: p.acknowledged_duplicates ?? [], ready: p.ready === true, meta: p.meta ?? null,
    tenant: p.tenant ?? null,
  };
}
export const proposalAuth = (env, proposal) => mac(env, 'proposal', signedFields(proposal));

export const approvalCode = (env, p) => mac(env, 'approve', { id: p.id, request_hash: p.request_hash, expires_at: p.expires_at, mode: p.mode }).slice(0, 16);
export const resolveCode = (env, id, created) => mac(env, 'resolve', { id, created: created === true }).slice(0, 16);

// What the human types in chat. Only derivable with the operator secret.
export function approvalPhrase(env, p) {
  return 'APPROVE ' + p.id + ' ' + p.request_hash.slice(0, 8) + ' ' + (p.mode === 'draft' ? 'DRAFT' : 'FINAL') + ' ' + approvalCode(env, p);
}
