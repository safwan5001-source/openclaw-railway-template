// Builds an APPROVAL PROPOSAL for a financial operation. Read-only against Daftra (GET only):
// validates references, taxes, permissions and duplicates, then stores the exact request that a
// human must approve by hash. It never creates anything in Daftra.
import { ACTION_TYPES, prepareFinancialAction, hashRequest } from './daftra-finance-preflight.mjs';
import { DaftraError, getOne, listPage, listRecords, fetchAllRecords } from './daftra-readonly.mjs';
import { approvalSecret } from './daftra-auth.mjs';
import { normName, normEmail, digitsOnly, normTax } from './daftra-parties.mjs';
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


const norm = (s) => String(s ?? '').trim().toLowerCase();
const sameValue = (a, b) => { const x = num(a); const y = num(b); return x !== null && y !== null ? x === y : String(a ?? '') === String(b ?? ''); };

// Customer/supplier duplicate scan. Daftra enforces unique e-mail only; tax number, phone and name duplicates are NOT
// prevented server-side, so compare locally over ALL records (falls back to a keyword search for very large books).
async function findPartyDuplicates(resource, values, excludeId, env, fetcher, warnings) {
  let rows; let scope = 'all';
  try { rows = (await fetchAllRecords(resource, { pageSize: 200, maxRecords: 3000 }, env, fetcher)).records; }
  catch (e) {
    if (!/exceeds limit|more than/.test(e.message)) throw e;
    scope = 'keyword';
    const seen = new Map();
    for (const v of [values.bn1, values.email, values.business_name].filter(Boolean))
      for (const r of (await fetchAllRecords(resource, { query: { keywords: String(v).slice(0, 100) } }, env, fetcher)).records) seen.set(String(r.id), r);
    rows = [...seen.values()];
    warnings.push('The ' + resource + ' book is large: duplicates were searched by keyword only (tax number match depends on Daftra search); verify manually');
  }
  const out = [];
  for (const r of rows) {
    if (excludeId !== undefined && String(r.id) === String(excludeId)) continue;
    const reasons = [];
    if (values.bn1 && r.bn1 && normTax(r.bn1) === normTax(values.bn1)) reasons.push('same tax number');
    if (values.email && r.email && normEmail(r.email) === normEmail(values.email)) reasons.push('same email');
    for (const f of ['phone1', 'phone2']) for (const g of ['phone1', 'phone2']) {
      const a = digitsOnly(values[f]); const b = digitsOnly(r[g]);
      if (a.length >= 7 && a === b && !reasons.includes('same phone')) reasons.push('same phone');
    }
    if (values.business_name && r.business_name && normName(r.business_name) === normName(values.business_name)) reasons.push('same name');
    if (reasons.length) out.push({ entity: resource, id: String(r.id), reasons });
  }
  void scope;
  return out;
}

// Product / category checks (GET only). `snapshot` = the current values seen when the preview was built;
// if the live record differs at approval time the change is blocked (someone edited it meanwhile).
async function collectCatalogChecks(type, preview, env, fetcher, acknowledged, snapshot) {
  const checks = []; const blocking = []; const warnings = [];
  const check = (ok, name, detail, isBlocking = false) => { checks.push({ name, ok, detail }); if (!ok && isBlocking) blocking.push(detail); };
  const spec = ACTION_TYPES[type];
  await probe(spec.resource, env, fetcher, check);
  const body = Object.values(preview.request.body)[0];
  let counterparty = null; let duplicates = [];
  const singleEntity = spec.resource;                         // 'products' | 'product_categories'
  if (preview.tax_ids?.length) {
    try {
      const page = await listPage('taxes', {}, env, fetcher);
      const table = new Map(page.records.map((r) => [String(r.id), r]));
      for (const taxId of preview.tax_ids) {
        const tax = table.get(String(taxId));
        check(Boolean(tax) && Number(tax.is_active) !== 0, 'tax_' + taxId + '_valid', tax ? (Number(tax.is_active) === 0 ? 'Tax ' + taxId + ' is inactive' : 'Tax ' + taxId + ' valid') : 'Tax ' + taxId + ' does not exist in this tenant', true);
      }
    } catch (e) { check(false, 'tax_table', 'Tax table unavailable: ' + e.message, true); }
  }
  if (preview.supplier_id) await exists('suppliers', preview.supplier_id, env, fetcher, check, 'supplier');
  for (const cid of preview.categories_id ?? []) await exists('product_categories', cid, env, fetcher, check, 'category ' + cid);
  if (preview.parent_id) await exists('product_categories', preview.parent_id, env, fetcher, check, 'parent category');
  const q = (o) => ({ query: o });
  try {
    if (preview.party_values) {
      duplicates = await findPartyDuplicates(spec.resource, preview.party_values, type.endsWith('_update') ? preview.target_id : undefined, env, fetcher, warnings);
      if (type.endsWith('_update')) counterparty = await exists(spec.resource, preview.target_id, env, fetcher, check, spec.resource === 'clients' ? 'client' : 'supplier');
    } else if (type === 'product_create') {
      const hits = new Map();
      if (body.barcode) for (const r of (await fetchAllRecords('products', q({ barcode: body.barcode }), env, fetcher)).records) if (!r.barcode || String(r.barcode) === String(body.barcode)) hits.set(String(r.id), r);
      if (body.product_code) for (const r of (await fetchAllRecords('products', q({ product_code: body.product_code }), env, fetcher)).records) if (!r.product_code || norm(r.product_code) === norm(body.product_code)) hits.set(String(r.id), r);
      for (const r of (await fetchAllRecords('products', q({ keywords: body.name }), env, fetcher)).records) if (norm(r.name) === norm(body.name)) hits.set(String(r.id), r);
      duplicates = [...hits.keys()].map((id) => ({ entity: 'products', id }));
    } else if (type === 'product_update') {
      counterparty = await exists('products', preview.target_id, env, fetcher, check, 'product');
      for (const f of ['barcode', 'product_code']) if (body[f]) {
        const rows = (await fetchAllRecords('products', q({ [f]: body[f] }), env, fetcher)).records;
        for (const r of rows) if (String(r.id) !== String(preview.target_id) && (!r[f] || norm(r[f]) === norm(body[f]))) duplicates.push({ entity: 'products', id: String(r.id) });
      }
    } else if (type === 'category_create') {
      const rows = (await fetchAllRecords('product_categories', q(body.parent_id ? { parent_id: String(body.parent_id) } : {}), env, fetcher)).records;
      duplicates = rows.filter((r) => norm(r.name) === norm(body.name) && String(r.parent_id ?? 0) === String(body.parent_id ?? 0)).map((r) => ({ entity: 'product_categories', id: String(r.id) }));
    } else if (type === 'category_update') {
      counterparty = await exists('product_categories', preview.target_id, env, fetcher, check, 'category');
    }
    const open = duplicates.filter((d) => !acknowledged.has(d.entity + '#' + d.id));
    check(open.length === 0, 'no_remote_duplicate', open.length
      ? 'Possible duplicates already in Daftra: ' + open.map((d) => d.entity + '#' + d.id + (d.reasons ? ' (' + d.reasons.join(', ') + ')' : '')).join(', ') + ' (re-propose with acknowledge_duplicates to override)'
      : (duplicates.length ? 'Possible duplicates acknowledged by the requester' : 'No duplicate found'), true);
  } catch (e) { check(false, 'no_remote_duplicate', 'Duplicate scan failed (' + e.message + ')', true); }
  if (snapshot && counterparty) {
    const changed = Object.entries(snapshot).filter(([f, v]) => counterparty[f] !== undefined && !sameValue(counterparty[f], v)).map(([f]) => f);
    check(changed.length === 0, 'unchanged_since_preview', changed.length ? 'Changed in Daftra since the preview: ' + changed.join(', ') + ' (create a new proposal)' : 'Record unchanged since the preview', true);
  }
  return { checks, blocking, warnings, duplicates, counterparty };
}

// Checks that must hold both when proposing and again right before submitting.
export async function collectChecks(type, preview, env, fetcher, acknowledged = new Set(), extra = {}) {
  if (ACTION_TYPES[type]?.catalog) return collectCatalogChecks(type, preview, env, fetcher, acknowledged, extra.snapshot);
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

export async function createProposal(type, input, { env = process.env, fetcher = fetch, actor = 'unknown', now = Date.now(), meta = null, extraBlocking = [], extraWarnings = [] } = {}) {
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
  let current; let snapshot = null;
  if (type.endsWith('_update') && ACTION_TYPES[type].catalog) {
    const entity = ACTION_TYPES[type].resource; const key = input.product_id ?? input.category_id ?? input.client_id ?? input.supplier_id;
    try { current = await getOne(entity, key, env, fetcher); } catch (e) { preBlocking.push('Target record not accessible (' + e.message + ')'); }
  }
  let preview = prepareFinancialAction(type, input, { taxes, requireDate: true, current });
  if (current && preview.changes) {
    snapshot = Object.fromEntries(preview.changes.filter((c) => typeof c.from !== 'object' && !String(c.from).startsWith('(')).map((c) => [c.field, c.from]));
    for (const f of preview.carried_fields ?? []) if (current[f] !== undefined) snapshot[f] = current[f];   // supplier: every carried field must also be unchanged
  }
  if (type === 'expense') {
    // Expenses support a real server-side idempotency key; derive it from the request itself.
    preview = prepareFinancialAction(type, input, { taxes, requireDate: true, idempotencyKey: 'basht-' + preview.request_hash.slice(0, 40) });
  }
  const acknowledged = new Set((input.acknowledge_duplicates ?? []).map(String));
  const collected = await collectChecks(type, preview, env, fetcher, acknowledged, { snapshot });
  const effective = [...preBlocking, ...extraBlocking, ...collected.blocking];
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
    warnings: [...preview.warnings, ...extraWarnings, ...collected.warnings],
    duplicates: collected.duplicates,
    acknowledged_duplicates: [...acknowledged],
    meta: { ...(meta ?? {}), ...(snapshot ? { snapshot } : {}), ...(preview.changes ? { changes: preview.changes, price_changes: preview.price_changes, highlights: preview.highlights, carried_fields: preview.carried_fields } : {}) },
  };
  if (hashRequest(proposal.request) !== proposal.request_hash) throw Error('Internal hash mismatch');
  await saveProposal(proposal, env);
  return proposal;
}

function summariseParty(preview, record) {
  const name = record?.business_name || record?.name || record?.first_name || null;
  return { client_id: preview.client_id ?? null, supplier_id: preview.supplier_id ?? null, invoice_id: preview.invoice_id ?? null, target_id: preview.target_id ?? null, name };
}
