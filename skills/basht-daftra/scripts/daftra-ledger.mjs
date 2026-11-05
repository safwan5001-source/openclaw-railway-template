// Local, private operation ledger + proposal store for approval-gated financial operations.
// Lives under $OPENCLAW_WORKSPACE_DIR/daftra-ledger (persistent volume), mode 0700/0600.
// Ledger lines never contain API keys, amounts, or customer names: only ids, hashes and states.
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PROPOSAL_ID = /^prop_[0-9a-f]{16}$/;
// States after which the same request hash must NOT be sent again without a human decision.
const BLOCKING_STATES = new Set(['submitting', 'submitted', 'ambiguous', 'resolved_created']);

export function ledgerDir(env = process.env) {
  return resolve(env.OPENCLAW_WORKSPACE_DIR || '/data/workspace', 'daftra-ledger');
}
async function ensure(env) {
  const dir = ledgerDir(env);
  await mkdir(join(dir, 'proposals'), { recursive: true, mode: 0o700 });
  return dir;
}
export function newProposalId() { return 'prop_' + randomBytes(8).toString('hex'); }
export function assertProposalId(id) {
  if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) throw Error('Invalid proposal id');
  return id;
}

export async function saveProposal(proposal, env = process.env) {
  const dir = await ensure(env);
  await writeFile(join(dir, 'proposals', assertProposalId(proposal.id) + '.json'), JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export async function loadProposal(id, env = process.env) {
  const dir = await ensure(env);
  try { return JSON.parse(await readFile(join(dir, 'proposals', assertProposalId(id) + '.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw Error('Proposal not found'); throw e; }
}
export async function updateProposal(id, patch, env = process.env) {
  const dir = await ensure(env);
  const file = join(dir, 'proposals', assertProposalId(id) + '.json');
  const next = { ...(await loadProposal(id, env)), ...patch };
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(tmp, file);
  return next;
}

export async function appendLedger(entry, env = process.env) {
  const dir = await ensure(env);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await appendFile(join(dir, 'ledger.jsonl'), line, { mode: 0o600 });
}
export async function readLedger(env = process.env) {
  const dir = await ensure(env);
  let raw = '';
  try { raw = await readFile(join(dir, 'ledger.jsonl'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Latest recorded state of a request hash, or null.
export function stateForHash(entries, requestHash) {
  const states = entries.filter((e) => e.request_hash === requestHash && e.state).map((e) => e.state);
  return states.length ? states[states.length - 1] : null;
}
export function isBlockedByLedger(entries, requestHash) {
  const state = stateForHash(entries, requestHash);
  return state !== null && BLOCKING_STATES.has(state) ? state : null;
}
export function writesInLastHour(entries, now = Date.now()) {
  return entries.filter((e) => e.state === 'submitting' && now - Date.parse(e.ts) < 3600_000).length;
}
