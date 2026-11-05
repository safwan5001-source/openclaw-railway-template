// Builds an APPROVAL PROPOSAL for a financial operation. Read-only against Daftra (GET only):
// validates references, taxes, permissions and duplicates, then stores the exact request that a
// human must approve by hash. It never creates anything in Daftra.
import { ACTION_TYPES, prepareFinancialAction, hashRequest } from './daftra-finance-preflight.mjs';
import { DaftraError, getOne, listPage, listRecords, fetchAllRecords } from './daftra-readonly.mjs';
import { approvalSecret } from './daftra-auth.mjs';
import { newProposalId, saveProposal, readLedger, isBlockedByLedger } from './daftra-ledger.mjs';
import { parseDecimal, format } from './daftra-money.mjs';

export const PROPOSAL_TTL_MS = 15 * 60 * 1000;


const num = (v) => { try { return parseDecimal(String(v ?? ''), 'n', { maxDecimals: 6 }); } catch { return null; } };

async function probe(entity, env, fetcher, check, query = { limit: 1 }) {
  try {
    await listRecords(entity, env, fetcher, query);
    check(true, 'api_key_can_read_' + entity, 'API key role allows reading ' + entity);
  } catch (e) {
    const forbidden = e instanceof DaftraError && (e.status === 401 || e.status === 403);
    check(false, 'api_key_can_read_' + entity, forbidden ? 'API key role does not allow ' + entity + ' (HTTP ' + e.status + ')' : 'Cannot reach ' + entity + ': ' + e.message, true);
  }
}
async function exists(entity, id, env, fetcher, check, label) {
  try {
    const record = await getOne(entity, id, env, fetcher);
    check(true, label + '_exists', label + ' ' + id + ' found');
    return record;
  } catch (e) {
    check(false, label + '_exists', label + ' ' + id + ' not accessible (' + e.message + ')', true);
    return null;
  }
}

// Remote duplicate scan (GET only). Returns [{entity,id}] candidates.
async function findDuplicates(type, preview, env, fetcher) {
  const out = [];
  const total = preview.totals.total;
  const near = (v) => { const a = num(v); const b = num(total); return a !== null && b !== null && (a > b ? a - b : b - a) <= 10_000n; }; // <= 0.01
  if (type === 'sales_invoice' || type === 'estimate') {
    const entity = type === 'sales_invoice' ? 'invoices' : 'estimates';
    const page = await fetchAllRecords(entity, { query: { client_id: preview.client_id, date_from: preview.date, date_to: preview.date } }, env, fetcher);
    for (const r of page.records) if (near(r.summary_total)) out.push({ entity, id: String(r.id) });
  } else if (type === 'expense') {
    const page = await fetchAllRecords('expenses', { query: { date_from: preview.date, date_to: preview.date, amount_from: total, amount_to: total } }, env, fetcher);
    for (const r of page.records) out.push({ entity: 'expenses', id: String(r.id) });
  } else if (type === 'client_payment') {
    const page = await fetchAllRecords('client_payments', { query: { client_id: preview.client_id, date_from: preview.date, date_to: preview.date, amount_from: total, amount_to: total } }, env, fetcher);
    for (const r of page.records) out.push({ entity: 'client_payments', id: String(r.id) });
  } else if (type === 'invoice_payment') {
    const page = await fetchAllRecords('invoice_payments', { query: { date_from: preview.date, date_to: preview.date, amount_from: total, amount_to: total } }, env, fetcher);
    for (const r of page.records) if (String(r.invoice_id) === String(preview.invoice_id)) out.push({ entity: 'invoice_payments', id: String(r.id) });
  }
  return out;
}

// Checks that must hold both when proposing and again right before submitting.
export async function collectChecks(type, preview, env, fetcher, acknowledged = new Set()) {
  const checks = []; const blocking = []; const warnings = [];
  const check = (ok, name, detail, isBlocking = false) => {
    checks.push({ name, ok, detail });
    if (!ok && isBlocking) blocking.push(detail);
  };
  const spec = ACTION_TYPES[type];
  await probe(spec.resource, env, fetcher, check);
  let counterparty = null;
  if (preview.client_id) counterparty = await exists('clients', preview.client_id, env, fetcher, check, 'client');
  if (preview.supplier_id) counterparty = await exists('suppliers', preview.supplier_id, env, fetcher, check, 'supplier');
  for (const item of preview.items ?? []) {
    if (item.product_id) await exists('products', item.product_id, env, fetcher, check, 'product ' + item.product_id);
  }
  if (type === 'invoice_payment') {
    const invoice = await exists('invoices', preview.invoice_id, env, fetcher, check, 'invoice');
    if (invoice) {
      counterparty = invoice;
      check(!invoice.draft || String(invoice.draft) === '0', 'invoice_not_draft', 'Invoice is final (payments cannot be applied to a draft)', true);
      const unpaid = num(invoice.summary_unpaid); const amount = num(preview.amount);
      if (unpaid === null) warnings.push('Invoice unpaid balance unavailable; overpayment not checked');
      else check(amount <= unpaid, 'no_overpayment', 'Payment ' + preview.amount + ' does not exceed unpaid balance ' + format(unpaid), true);
    }
  }
  let duplicates = [];
  try {
    duplicates = await findDuplicates(type, preview, env, fetcher);
    const open = duplicates.filter((d) => !acknowledged.has(d.entity + '#' + d.id));
    check(open.length === 0, 'no_remote_duplicate', open.length
      ? 'Possible duplicates already in Daftra: ' + open.map((d) => d.entity + '#' + d.id).join(', ') + ' (re-propose with acknowledge_duplicates to override)'
      : (duplicates.length ? 'Possible duplicates acknowledged by the requester' : 'No matching record found in Daftra for the same party/date/amount'), true);
  } catch (e) {
    if (type === 'purchase_invoice') warnings.push('No server-side duplicate search is documented for purchase invoices: check manually');
    else check(false, 'no_remote_duplicate', 'Duplicate scan failed (' + e.message + ')', true);
  }
  return { checks, blocking, warnings, duplicates, counterparty };
}

export async function createProposal(type, input, { env = process.env, fetcher = fetch, actor = 'unknown', now = Date.now() } = {}) {
  if (!Object.hasOwn(ACTION_TYPES, type)) throw Error('Unsupported financial action');
  approvalSecret(env); // proposals are authenticated; refuse early when the operator secret is not configured
  // Tax table: required for invoice-like documents so every tax id is verified against this tenant.
  let taxes; const preBlocking = [];
  if (['sales_invoice', 'estimate', 'purchase_invoice'].includes(type)) {
    try {
      const page = await listPage('taxes', {}, env, fetcher);
      if (page.complete) taxes = page.records; else preBlocking.push('Tax table could not be proven complete');
    } catch (e) { preBlocking.push('Tax table unavailable: ' + e.message); }
  }
  let preview = prepareFinancialAction(type, input, { taxes, requireDate: true });
  if (type === 'expense') {
    // Expenses support a real server-side idempotency key; derive it from the request itself.
    preview = prepareFinancialAction(type, input, { taxes, requireDate: true, idempotencyKey: 'basht-' + preview.request_hash.slice(0, 40) });
  }
  const acknowledged = new Set((input.acknowledge_duplicates ?? []).map(String));
  const collected = await collectChecks(type, preview, env, fetcher, acknowledged);
  const effective = [...preBlocking, ...collected.blocking];
  const ledger = await readLedger(env);
  const ledgerState = isBlockedByLedger(ledger, preview.request_hash);
  if (ledgerState) effective.push('The identical request was already ' + ledgerState + ' (see ledger); resolve it before proposing again');

  const proposal = {
    id: newProposalId(),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    actor,
    type,
    ready: effective.length === 0,
    status: effective.length ? 'BLOCKED' : 'READY_FOR_APPROVAL',
    mode: preview.mode,
    effects: preview.effects,
    reversible: preview.reversible,
    totals: preview.totals,
    party: summariseParty(preview, collected.counterparty),
    request: preview.request,
    request_hash: preview.request_hash,
    checks: collected.checks,
    blocking: effective,
    warnings: [...preview.warnings, ...collected.warnings],
    duplicates: collected.duplicates,
    acknowledged_duplicates: [...acknowledged],
  };
  if (hashRequest(proposal.request) !== proposal.request_hash) throw Error('Internal hash mismatch');
  await saveProposal(proposal, env);
  return proposal;
}

function summariseParty(preview, record) {
  const name = record?.business_name || record?.name || record?.first_name || null;
  return { client_id: preview.client_id ?? null, supplier_id: preview.supplier_id ?? null, invoice_id: preview.invoice_id ?? null, name };
}
