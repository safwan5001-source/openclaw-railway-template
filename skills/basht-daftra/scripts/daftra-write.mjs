// The ONLY module that can send a non-GET request to Daftra, and only for an approved proposal.
//
// Safety layers (all must pass, in order):
//   1. Operator kill switch  : DAFTRA_WRITES_ENABLED=1 must be set in the environment (default: OFF).
//   2. Exact route allowlist : POST to six create endpoints only. No PUT/PATCH/DELETE exist anywhere.
//   3. Bound approval        : the human must type `APPROVE <proposal-id> <hash8> <DRAFT|FINAL>`; the phrase is
//                              bound to the SHA-256 of the exact request, expires after 15 minutes, single use.
//   4. Tamper check          : the stored request is re-hashed; any edit invalidates the proposal.
//   5. Duplicate prevention  : local ledger (same hash never re-sent unless resolved) + fresh remote re-check.
//   6. Rate limit            : DAFTRA_MAX_WRITES_PER_HOUR (default 20).
//   7. No blind retry        : the POST is attempted once. A network/5xx outcome is `ambiguous` and blocks
//                              re-sending until a human runs `resolve`.
import { timingSafeEqual } from 'node:crypto';
import { config, getOne } from './daftra-readonly.mjs';
import { ACTION_TYPES, hashRequest } from './daftra-finance-preflight.mjs';
import { collectChecks, approvalPhrase } from './daftra-proposal.mjs';
import { appendLedger, readLedger, loadProposal, updateProposal, isBlockedByLedger, stateForHash, writesInLastHour } from './daftra-ledger.mjs';
import { parseDecimal } from './daftra-money.mjs';

export const WRITE_ROUTES = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_TYPES).map(([type, spec]) => [type, Object.freeze({ method: 'POST', path: spec.endpoint })])));

const ALLOWED_QUERIES = new Set(['', 'send=draft']);

export class WriteRefused extends Error {
  constructor(code, message) { super(message); this.name = 'WriteRefused'; this.code = code; }
}

export function assertWriteAllowed(type, request) {
  const route = Object.hasOwn(WRITE_ROUTES, type) ? WRITE_ROUTES[type] : null;
  if (!route) throw new WriteRefused('ROUTE_DENIED', 'Unknown financial operation');
  if (request?.method !== route.method || request?.path !== route.path || !ALLOWED_QUERIES.has(request?.query ?? ''))
    throw new WriteRefused('ROUTE_DENIED', 'Method/path not on the write allowlist');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const VERIFY = {
  sales_invoice: ['invoices', 'summary_total'], estimate: ['estimates', 'summary_total'],
  expense: ['expenses', 'amount'], invoice_payment: ['invoice_payments', 'amount'], client_payment: ['client_payments', 'amount'],
};

async function verifyCreated(proposal, recordId, env, fetcher) {
  const spec = VERIFY[proposal.type];
  if (!spec) return { checked: false, reason: 'no documented read-back field for this operation' };
  try {
    const record = await getOne(spec[0], recordId, env, fetcher);
    const expected = proposal.totals.total; const actual = record[spec[1]];
    const same = parseDecimal(String(actual), 'actual', { maxDecimals: 6 }) === parseDecimal(String(expected), 'expected', { maxDecimals: 6 });
    return { checked: true, matched: same, expected, actual: String(actual) };
  } catch (e) {
    return { checked: false, reason: 'read-back failed: ' + e.message };
  }
}

export async function executeProposal({ id, phrase, actor = 'unknown' }, { env = process.env, fetcher = fetch, now = Date.now() } = {}) {
  // 1. kill switch
  if (env.DAFTRA_WRITES_ENABLED !== '1')
    throw new WriteRefused('WRITES_DISABLED', 'Financial writes are disabled. The operator must set DAFTRA_WRITES_ENABLED=1 on the server.');
  const proposal = await loadProposal(id, env);
  // 3/4. state, expiry, tamper
  if (proposal.status !== 'READY_FOR_APPROVAL') throw new WriteRefused('NOT_READY', 'Proposal status is ' + proposal.status);
  if (Date.parse(proposal.expires_at) < now) {
    await updateProposal(id, { status: 'EXPIRED' }, env);
    throw new WriteRefused('EXPIRED', 'Proposal expired; create a new one');
  }
  assertWriteAllowed(proposal.type, proposal.request);
  if (hashRequest(proposal.request) !== proposal.request_hash) throw new WriteRefused('TAMPERED', 'Stored request does not match its approved hash');
  if (!safeEqual(String(phrase ?? '').trim(), approvalPhrase(proposal))) throw new WriteRefused('PHRASE_MISMATCH', 'Approval phrase does not match this exact proposal');
  // 5/6. ledger
  const ledger = await readLedger(env);
  const blockedBy = isBlockedByLedger(ledger, proposal.request_hash);
  if (blockedBy) throw new WriteRefused('DUPLICATE', 'The identical request is already ' + blockedBy + '; resolve it first');
  const configured = Number(env.DAFTRA_MAX_WRITES_PER_HOUR);
  const limit = Number.isInteger(configured) && configured >= 1 ? configured : 20;
  if (writesInLastHour(ledger, now) >= limit) throw new WriteRefused('RATE_LIMIT', 'Write rate limit reached (' + limit + '/hour)');
  // fresh checks right before submitting (balance, duplicates, permissions may have changed)
  const preview = { ...previewFromProposal(proposal) };
  const recheck = await collectChecks(proposal.type, preview, env, fetcher, new Set(proposal.acknowledged_duplicates ?? []));
  if (recheck.blocking.length) throw new WriteRefused('RECHECK_FAILED', 'Pre-submit re-check failed: ' + recheck.blocking.join('; '));

  const { base, apiKey } = config(env);
  const url = new URL(proposal.request.path, base);
  if (proposal.request.query) url.search = proposal.request.query;
  if (url.origin !== base.origin || !url.pathname.startsWith('/api2/')) throw new WriteRefused('ROUTE_DENIED', 'Target outside tenant');

  // Record intent BEFORE sending, so a crash can never lose the fact that a send may have happened.
  await updateProposal(id, { status: 'SUBMITTING', approved_by: actor, approved_at: new Date(now).toISOString() }, env);
  const base_entry = { proposal_id: id, type: proposal.type, request_hash: proposal.request_hash, endpoint: 'POST ' + proposal.request.path + (proposal.request.query ? '?' + proposal.request.query : ''), actor };
  await appendLedger({ ...base_entry, event: 'approved', state: 'submitting' }, env);

  let response;
  try {
    response = await fetcher(url, {
      method: 'POST', redirect: 'manual',
      headers: { APIKEY: apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal.request.body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    await appendLedger({ ...base_entry, event: 'network_error', state: 'ambiguous', error: String(e.name || 'Error') }, env);
    await updateProposal(id, { status: 'AMBIGUOUS' }, env);
    return { ok: false, status: 'ambiguous', message: 'The request may or may not have reached Daftra. Check Daftra, then run resolve. It will NOT be retried automatically.' };
  }

  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON body */ }

  if (response.status >= 200 && response.status < 300) {
    const recordId = payload?.id !== undefined && payload?.id !== null ? String(payload.id) : null;
    if (!recordId) {
      await appendLedger({ ...base_entry, event: 'no_id_in_response', state: 'ambiguous', http_status: response.status }, env);
      await updateProposal(id, { status: 'AMBIGUOUS' }, env);
      return { ok: false, status: 'ambiguous', http_status: response.status, message: 'Daftra answered success but returned no record id. Verify in Daftra, then run resolve.' };
    }
    const duplicated = payload?.result === 'duplicated';
    const verification = duplicated ? { checked: false, reason: 'server reported duplicate' } : await verifyCreated(proposal, recordId, env, fetcher);
    await appendLedger({ ...base_entry, event: duplicated ? 'server_duplicate' : 'created', state: 'submitted', http_status: response.status, record_id: recordId, verification_matched: verification.matched ?? null }, env);
    await updateProposal(id, { status: duplicated ? 'DUPLICATE_ECHOED' : 'SUBMITTED', record_id: recordId }, env);
    return { ok: true, status: duplicated ? 'duplicate_echoed' : 'submitted', record_id: recordId, http_status: response.status, verification };
  }
  if (response.status >= 400 && response.status < 500) {
    const message = typeof payload?.message === 'string' ? payload.message.replace(/[^\p{L}\p{N} .,:;()_\-]/gu, '').slice(0, 300) : '';
    await appendLedger({ ...base_entry, event: 'rejected', state: 'rejected', http_status: response.status }, env);
    await updateProposal(id, { status: 'REJECTED' }, env);
    return { ok: false, status: 'rejected', http_status: response.status, message: 'Daftra rejected the request' + (message ? ': ' + message : '') + '. Nothing was created.' };
  }
  await appendLedger({ ...base_entry, event: 'server_error', state: 'ambiguous', http_status: response.status }, env);
  await updateProposal(id, { status: 'AMBIGUOUS' }, env);
  return { ok: false, status: 'ambiguous', http_status: response.status, message: 'Daftra returned a server error; the record may have been created. Check Daftra, then run resolve.' };
}

// Human decision after an ambiguous outcome. Required before the same request can ever be sent again.
export async function resolveProposal({ id, created, recordId, actor = 'unknown' }, { env = process.env } = {}) {
  const proposal = await loadProposal(id, env);
  const ledger = await readLedger(env);
  const state = stateForHash(ledger, proposal.request_hash);
  if (state !== 'ambiguous' && state !== 'submitting') throw new WriteRefused('NOT_AMBIGUOUS', 'Only ambiguous/in-flight requests can be resolved (state: ' + state + ')');
  if (typeof created !== 'boolean') throw Error('created must be true or false');
  await appendLedger({ proposal_id: id, type: proposal.type, request_hash: proposal.request_hash, actor, event: 'resolved', state: created ? 'resolved_created' : 'resolved_not_created', record_id: created && recordId ? String(recordId) : undefined }, env);
  await updateProposal(id, { status: created ? 'RESOLVED_CREATED' : 'RESOLVED_NOT_CREATED' }, env);
  return { ok: true, state: created ? 'resolved_created' : 'resolved_not_created' };
}

// Rebuild the minimal "preview" shape that collectChecks needs from a stored proposal.
function previewFromProposal(proposal) {
  const body = Object.values(proposal.request.body)[0];
  const itemsKey = proposal.request.body.InvoiceItem ? 'InvoiceItem' : proposal.request.body.PurchaseOrderItem ? 'PurchaseOrderItem' : null;
  return {
    type: proposal.type,
    date: body.date,
    client_id: proposal.party.client_id ? String(proposal.party.client_id) : undefined,
    supplier_id: proposal.party.supplier_id ? String(proposal.party.supplier_id) : undefined,
    invoice_id: proposal.party.invoice_id ? String(proposal.party.invoice_id) : undefined,
    amount: body.amount !== undefined ? String(body.amount) : undefined,
    items: itemsKey ? proposal.request.body[itemsKey] : [],
    totals: proposal.totals,
    request: proposal.request,
  };
}

