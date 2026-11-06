// Local operation ledger + proposal store for approval-gated financial operations.
// Lives under $OPENCLAW_WORKSPACE_DIR/daftra-ledger (persistent volume), mode 0700/0600.
// The workspace is agent-writable, so integrity comes from HMAC (daftra-auth.mjs), not from file modes:
//   - every proposal carries `auth`; every ledger line carries a MAC chained to the previous line.
// Ledger lines never contain API keys, amounts, or customer names: only ids, hashes and states.
import { mkdir, readFile, writeFile, rename, appendFile, unlink, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mac, macEqual, proposalAuth, tenantOf } from './daftra-auth.mjs';

const PROPOSAL_ID = /^prop_[0-9a-f]{16}$/;
const HASH = /^[0-9a-f]{64}$/;
// States after which the same request hash must NOT be sent again without a human decision.
const BLOCKING_STATES = new Set(['submitting', 'submitted', 'ambiguous', 'resolved_created']);
// A PUT that sets fields to given values is idempotent: once finished it must not block a later, deliberate repeat
// (e.g. a price changed back and forth). It stays blocked while in flight or unresolved.
const IN_FLIGHT_STATES = new Set(['submitting', 'ambiguous']);

export class LedgerTampered extends Error {
  constructor(message) { super(message); this.name = 'LedgerTampered'; this.code = 'LEDGER_TAMPERED'; }
}

export function ledgerDir(env = process.env) {
  return resolve(env.OPENCLAW_WORKSPACE_DIR || '/data/workspace', 'daftra-ledger');
}
async function ensure(env) {
  const dir = ledgerDir(env);
  await mkdir(join(dir, 'proposals'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'locks'), { recursive: true, mode: 0o700 });
  return dir;
}
export function newProposalId() { return 'prop_' + randomBytes(8).toString('hex'); }
export function assertProposalId(id) {
  if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) throw Error('Invalid proposal id');
  return id;
}

// ---- atomic locks (O_EXCL) --------------------------------------------------------------------
// Returns a release() function, or null when the lock is already held.
export async function acquireLock(env, name) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) throw Error('Invalid lock name');
  const file = join(await ensure(env), 'locks', name);
  try { await writeFile(file, String(process.pid) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  return async () => { try { await unlink(file); } catch { /* already gone */ } };
}
export async function forceUnlock(env, name) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) throw Error('Invalid lock name');
  try { await unlink(join(ledgerDir(env), 'locks', name)); } catch { /* already gone */ }
}
async function withLedgerLock(env, fn) {
  const file = join(await ensure(env), 'locks', 'ledger.lock');
  for (let i = 0; ; i++) {
    try { await writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - (await stat(file)).mtimeMs > 10_000) await unlink(file); } catch { /* raced */ }
      if (i > 200) throw Error('Ledger busy');
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  try { return await fn(); } finally { try { await unlink(file); } catch { /* gone */ } }
}

// ---- proposals --------------------------------------------------------------------------------
export async function saveProposal(proposal, env = process.env) {
  const dir = await ensure(env);
  const stored = { ...proposal, auth: proposalAuth(env, proposal) };
  await writeFile(join(dir, 'proposals', assertProposalId(proposal.id) + '.json'), JSON.stringify(stored, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
// Loads AND authenticates. A proposal edited by anything without the operator secret is rejected.
export async function loadProposal(id, env = process.env) {
  const dir = await ensure(env);
  let raw;
  try { raw = JSON.parse(await readFile(join(dir, 'proposals', assertProposalId(id) + '.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw Error('Proposal not found'); throw e; }
  const expected = proposalAuth(env, raw);
  if (typeof raw.auth !== 'string' || !macEqual(raw.auth, expected)) {
    const err = Error('Stored proposal failed authentication (modified or created without the operator secret)');
    err.code = 'TAMPERED'; throw err;
  }
  // Cross-tenant / replayed state from another deployment: signed for a different Daftra tenant than this one.
  const here = tenantOf(env);
  if (here && raw.tenant !== here) { const err = Error('Proposal belongs to a different Daftra tenant'); err.code = 'CROSS_TENANT'; throw err; }
  return raw;
}
// Only the informational `status` may change after creation (it is not part of the signature).
export async function updateProposal(id, patch, env = process.env) {
  const dir = await ensure(env);
  const file = join(dir, 'proposals', assertProposalId(id) + '.json');
  const allowed = {}; if (patch.status !== undefined) allowed.status = patch.status;
  for (const k of ['record_id', 'approved_by', 'approved_at']) if (patch[k] !== undefined) allowed[k] = patch[k];
  const next = { ...(await loadProposal(id, env)), ...allowed };
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(tmp, file);
  return next;
}

// ---- ledger (HMAC chain) ----------------------------------------------------------------------
function parseChain(raw, env) {
  const entries = []; let prev = 'genesis';
  for (const line of raw.split('\n').filter(Boolean)) {
    let e;
    try { e = JSON.parse(line); } catch { throw new LedgerTampered('Ledger line is not valid JSON'); }
    const { mac: given, ...body } = e;
    if (body.prev !== prev || typeof given !== 'string' || !macEqual(given, mac(env, 'ledger', body)))
      throw new LedgerTampered('Ledger chain broken: the ledger was edited or truncated mid-file');
    entries.push(e); prev = given;
  }
  return { entries, head: prev };
}
async function readRaw(env) {
  const dir = await ensure(env);
  try { return await readFile(join(dir, 'ledger.jsonl'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return ''; }
}
export async function readLedger(env = process.env) {
  return parseChain(await readRaw(env), env).entries;
}
export async function appendLedger(entry, env = process.env) {
  const dir = await ensure(env);
  await withLedgerLock(env, async () => {
    const { head } = parseChain(await readRaw(env), env);
    const body = { ts: new Date().toISOString(), ...entry, prev: head };
    await appendFile(join(dir, 'ledger.jsonl'), JSON.stringify({ ...body, mac: mac(env, 'ledger', body) }) + '\n', { mode: 0o600 });
  });
}

// Latest recorded state of a request hash, or null.
export function stateForHash(entries, requestHash) {
  if (!HASH.test(String(requestHash))) return null;
  const states = entries.filter((e) => e.request_hash === requestHash && e.state).map((e) => e.state);
  return states.length ? states[states.length - 1] : null;
}
export function isBlockedByLedger(entries, requestHash, { idempotent = false } = {}) {
  const state = stateForHash(entries, requestHash);
  const set = idempotent ? IN_FLIGHT_STATES : BLOCKING_STATES;
  return state !== null && set.has(state) ? state : null;
}
export function proposalWasUsed(entries, proposalId) {
  return entries.some((e) => e.proposal_id === proposalId && e.state === 'submitting');
}
export function writesInLastHour(entries, now = Date.now()) {
  return entries.filter((e) => e.state === 'submitting' && now - Date.parse(e.ts) < 3600_000).length;
}
