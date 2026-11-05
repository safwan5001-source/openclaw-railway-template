// The ONLY module that can send a non-GET request to Daftra, and only for an approved proposal.
//
// Safety layers (all must pass, in order):
//   1. Operator kill switch  : DAFTRA_WRITES_ENABLED=1 must be set in the environment (default: OFF).
//   2. Operator secret       : DAFTRA_APPROVAL_SECRET (>=32 chars). Proposals, the ledger and approval codes are
//                              HMAC-authenticated with it, so an agent that can write the workspace cannot forge them.
//   3. Authenticated proposal: stored fields are verified by MAC; expiry fails closed; `ready` is fixed at creation.
//   4. Human approval        : `APPROVE <id> <hash8> <DRAFT|FINAL> <code>` where <code> is an HMAC only the operator
//                              tool (`daftra-approve.mjs`) can produce. Bound to this proposal, expires in 15 minutes.
//   5. Exact route allowlist : six POST create endpoints + strict body-shape allowlist. No PUT/PATCH/DELETE code exists.
//   6. Atomic claims         : O_EXCL locks per proposal and per request hash, so parallel `execute` calls cannot double-send.
//   7. Duplicate prevention  : HMAC-chained ledger (same hash never re-sent unless a human resolves it) + fresh re-check.
//   8. Rate limit            : DAFTRA_MAX_WRITES_PER_HOUR (default 20).
//   9. No blind retry        : one attempt. Network/5xx/no-id outcomes are `ambiguous` and block re-sending until
//                              a human runs `resolve` (which also needs an operator-derived code).
import { config, getOne } from './daftra-readonly.mjs';
import { ACTION_TYPES, hashRequest, assertBodyShape } from './daftra-finance-preflight.mjs';
import { collectChecks } from './daftra-proposal.mjs';
import { approvalSecret, approvalPhrase, resolveCode, macEqual } from './daftra-auth.mjs';
import { acquireLock, forceUnlock, appendLedger, readLedger, loadProposal, updateProposal, isBlockedByLedger, proposalWasUsed, stateForHash, writesInLastHour } from './daftra-ledger.mjs';
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
  try { assertBodyShape(type, request.body); } catch (e) { throw new WriteRefused('BODY_DENIED', e.message); }
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

// Everything the pre-submit checks need is derived from the authenticated request body, never from side fields.
function previewFromRequest(proposal) {
  const b = proposal.request.body;
  const head = b.Invoice ?? b.PurchaseOrder ?? b.Expense ?? b.InvoicePayment ?? b.ClientPayment;
  const str = (v) => (v === undefined || v === null ? undefined : String(v));
  const amount = str(b.Expense?.amount ?? b.InvoicePayment?.amount ?? b.ClientPayment?.amount);
  return {
    type: proposal.type, date: head.date,
    client_id: str(head.client_id), supplier_id: str(b.PurchaseOrder?.supplier_id),
    invoice_id: str(b.InvoicePayment?.invoice_id), amount,
    items: b.InvoiceItem ?? b.PurchaseOrderItem ?? [],
    totals: { total: amount ?? proposal.totals.total },
    request: proposal.request,
  };
}

export async function executeProposal({ id, phrase, actor = 'unknown' }, { env = process.env, fetcher = fetch, now = Date.now() } = {}) {
  // 1-2. operator switches
  if (env.DAFTRA_WRITES_ENABLED !== '1')
    throw new WriteRefused('WRITES_DISABLED', 'Financial writes are disabled. The operator must set DAFTRA_WRITES_ENABLED=1 on the server.');
  approvalSecret(env);
  // 3. authenticated proposal (throws TAMPERED on any unauthorised edit)
  const proposal = await loadProposal(id, env);
  if (proposal.ready !== true) throw new WriteRefused('NOT_READY', 'Proposal was blocked at creation');
  const expires = Date.parse(proposal.expires_at);
  if (!(expires >= now)) throw new WriteRefused('EXPIRED', 'Proposal expired; create a new one');   // NaN fails closed
  assertWriteAllowed(proposal.type, proposal.request);
  if (hashRequest(proposal.request) !== proposal.request_hash) throw new WriteRefused('TAMPERED', 'Stored request does not match its hash');
  // 4. human approval code
  if (!macEqual(String(phrase ?? '').trim(), approvalPhrase(env, proposal))) throw new WriteRefused('PHRASE_MISMATCH', 'Approval phrase does not match this exact proposal');
  // 6. atomic claims: only one caller can ever proceed for this proposal / this request
  const claimed = await acquireLock(env, proposal.id + '.claim');
  if (!claimed) throw new WriteRefused('ALREADY_USED', 'This proposal was already executed or is executing');
  const releaseHash = await acquireLock(env, proposal.request_hash + '.lock');
  if (!releaseHash) throw new WriteRefused('DUPLICATE', 'The identical request is being or has been sent; resolve it first');
  let keepHashLock = false;
  try {
    // 7-8. ledger (authenticated chain), rate limit
    const ledger = await readLedger(env);
    if (proposalWasUsed(ledger, proposal.id)) throw new WriteRefused('ALREADY_USED', 'This proposal was already executed');
    const blockedBy = isBlockedByLedger(ledger, proposal.request_hash);
    if (blockedBy) throw new WriteRefused('DUPLICATE', 'The identical request is already ' + blockedBy + '; resolve it first');
    const configured = Number(env.DAFTRA_MAX_WRITES_PER_HOUR);
    const limit = Number.isInteger(configured) && configured >= 1 ? configured : 20;
    if (writesInLastHour(ledger, now) >= limit) throw new WriteRefused('RATE_LIMIT', 'Write rate limit reached (' + limit + '/hour)');
    // fresh checks right before submitting (balance, duplicates, permissions may have changed)
    const recheck = await collectChecks(proposal.type, previewFromRequest(proposal), env, fetcher, new Set(proposal.acknowledged_duplicates ?? []));
    if (recheck.blocking.length) throw new WriteRefused('RECHECK_FAILED', 'Pre-submit re-check failed: ' + recheck.blocking.join('; '));

    const { base, apiKey } = config(env);
    const url = new URL(proposal.request.path, base);
    if (proposal.request.query) url.search = proposal.request.query;
    if (url.origin !== base.origin || !url.pathname.startsWith('/api2/')) throw new WriteRefused('ROUTE_DENIED', 'Target outside tenant');

    // Record intent BEFORE sending, so a crash can never lose the fact that a send may have happened.
    const entry = { proposal_id: proposal.id, type: proposal.type, request_hash: proposal.request_hash, endpoint: 'POST ' + proposal.request.path + (proposal.request.query ? '?' + proposal.request.query : ''), actor };
    await appendLedger({ ...entry, event: 'approved', state: 'submitting' }, env);
    keepHashLock = true;                                   // from here on a send may have happened
    await updateProposal(proposal.id, { status: 'SUBMITTING', approved_by: actor, approved_at: new Date(now).toISOString() }, env);

    let response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'manual',
        headers: { APIKEY: apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(proposal.request.body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      await appendLedger({ ...entry, event: 'network_error', state: 'ambiguous', error: String(e.name || 'Error') }, env);
      await updateProposal(proposal.id, { status: 'AMBIGUOUS' }, env);
      return { ok: false, status: 'ambiguous', message: 'The request may or may not have reached Daftra. Check Daftra, then run resolve. It will NOT be retried automatically.' };
    }

    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON body */ }

    if (response.status >= 200 && response.status < 300) {
      const recordId = payload?.id !== undefined && payload?.id !== null ? String(payload.id) : null;
      if (!recordId) {
        await appendLedger({ ...entry, event: 'no_id_in_response', state: 'ambiguous', http_status: response.status }, env);
        await updateProposal(proposal.id, { status: 'AMBIGUOUS' }, env);
        return { ok: false, status: 'ambiguous', http_status: response.status, message: 'Daftra answered success but returned no record id. Verify in Daftra, then run resolve.' };
      }
      const duplicated = payload?.result === 'duplicated';
      const verification = duplicated ? { checked: false, reason: 'server reported duplicate' } : await verifyCreated(proposal, recordId, env, fetcher);
      await appendLedger({ ...entry, event: duplicated ? 'server_duplicate' : 'created', state: 'submitted', http_status: response.status, record_id: recordId, verification_matched: verification.matched ?? null }, env);
      await updateProposal(proposal.id, { status: duplicated ? 'DUPLICATE_ECHOED' : 'SUBMITTED', record_id: recordId }, env);
      return { ok: true, status: duplicated ? 'duplicate_echoed' : 'submitted', record_id: recordId, http_status: response.status, verification };
    }
    if (response.status >= 400 && response.status < 500) {
      const message = typeof payload?.message === 'string' ? payload.message.replace(/[^\p{L}\p{N} .,:;()_\-]/gu, '').slice(0, 300) : '';
      await appendLedger({ ...entry, event: 'rejected', state: 'rejected', http_status: response.status }, env);
      await updateProposal(proposal.id, { status: 'REJECTED' }, env);
      keepHashLock = false;                                // definitive: nothing was created, a corrected retry is allowed
      return { ok: false, status: 'rejected', http_status: response.status, message: 'Daftra rejected the request' + (message ? ': ' + message : '') + '. Nothing was created.' };
    }
    await appendLedger({ ...entry, event: 'server_error', state: 'ambiguous', http_status: response.status }, env);
    await updateProposal(proposal.id, { status: 'AMBIGUOUS' }, env);
    return { ok: false, status: 'ambiguous', http_status: response.status, message: 'Daftra returned a server error; the record may have been created. Check Daftra, then run resolve.' };
  } finally {
    if (!keepHashLock) await releaseHash();                // pre-send refusals and definitive rejections free the hash
    // the proposal claim is never released: a proposal is single-use
  }
}

// Human decision after an ambiguous outcome. Needs a code only the operator tool can derive.
export async function resolveProposal({ id, created, recordId, code, actor = 'unknown' }, { env = process.env } = {}) {
  approvalSecret(env);
  if (typeof created !== 'boolean') throw Error('created must be true or false');
  const proposal = await loadProposal(id, env);
  if (!macEqual(String(code ?? ''), resolveCode(env, id, created))) throw new WriteRefused('PHRASE_MISMATCH', 'Resolve code is invalid (obtain it from the operator tool)');
  const ledger = await readLedger(env);
  const state = stateForHash(ledger, proposal.request_hash);
  if (state !== 'ambiguous' && state !== 'submitting') throw new WriteRefused('NOT_AMBIGUOUS', 'Only ambiguous/in-flight requests can be resolved (state: ' + state + ')');
  await appendLedger({ proposal_id: id, type: proposal.type, request_hash: proposal.request_hash, actor, event: 'resolved', state: created ? 'resolved_created' : 'resolved_not_created', record_id: created && recordId ? String(recordId) : undefined }, env);
  await updateProposal(id, { status: created ? 'RESOLVED_CREATED' : 'RESOLVED_NOT_CREATED' }, env);
  if (!created) await forceUnlock(env, proposal.request_hash + '.lock');
  return { ok: true, state: created ? 'resolved_created' : 'resolved_not_created' };
}
