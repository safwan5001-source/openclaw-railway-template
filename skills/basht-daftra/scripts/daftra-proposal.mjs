// Builds an APPROVAL PROPOSAL for a financial operation. Read-only against Daftra (GET only):
// validates references, taxes, permissions and duplicates, then stores the exact request that a
// human must approve by hash. It never creates anything in Daftra.
import { ACTION_TYPES, prepareFinancialAction, hashRequest } from './daftra-finance-preflight.mjs';
import { DaftraError, getOne, listPage, listRecords, fetchAllRecords } from './daftra-readonly.mjs';
import { approvalSecret, tenantOf } from './daftra-auth.mjs';
import { canonicalJson } from './daftra-canonical.mjs';
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


// Snapshot of a current value for stale-edit detection: EVERY changed field, null/arrays/odd strings included.
export const snap = (v) => (v === undefined ? '__absent__' : canonicalJson(v));
const norm = (s) => String(s ?? '').trim().toLowerCase();

// Complete, unfiltered read of a catalog/party collection for LOCAL duplicate comparison.
// Daftra's server-side search filters (keywords, barcode, product_code, parent_id) are not reliable: `keywords` on
// /products is rejected with "Invalid page", and a filter that is silently ignored would hide or fake matches.
// So no filter is sent: fetchAllRecords() walks every page and throws unless the whole collection is PROVEN
// complete (page order, stable page_count/total_results, next links, unique ids, rows == total_results) or the
// collection exceeds maxPages/maxRecords. Any throw here makes the duplicate check FAIL CLOSED (blocking).
export const DUPLICATE_SCAN_LIMITS = Object.freeze({ pageSize: 100, maxPages: 500, maxRecords: 20000 });
export async function readCompleteCollection(entity, env, fetcher) {
  const page = await fetchAllRecords(entity, { ...DUPLICATE_SCAN_LIMITS }, env, fetcher);
  if (page.complete !== true || !Array.isArray(page.records)) throw new Error('Duplicate scan blocked: the ' + entity + ' list is not proven complete');
  return page.records;
}

// Customer/supplier duplicate scan. Daftra enforces unique e-mail only; tax number, phone and name duplicates are NOT
// prevented server-side, so compare locally over ALL records. If the book cannot be read completely the scan throws
// (blocking) instead of degrading to an unreliable keyword search.
async function findPartyDuplicates(resource, values, excludeId, env, fetcher) {
  const rows = await readCompleteCollection(resource, env, fetcher);
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
  return out;
}

// Local product duplicate matching over the COMPLETE list. Same normalisation as before (trim + lower-case):
// a record only matches when it HAS the field and the normalised values are equal (a missing field never matches).
// create: barcode, product_code and name; update: only the fields being changed, never the target itself.
function findProductDuplicates(rows, body, excludeId, fields = ['barcode', 'product_code', 'name']) {
  const hits = new Map();
  for (const r of rows) {
    if (excludeId !== undefined && String(r.id) === String(excludeId)) continue;
    const reasons = fields.filter((f) => body[f] && r[f] && norm(r[f]) === norm(body[f]));
    if (reasons.length) hits.set(String(r.id), { entity: 'products', id: String(r.id), reasons });
  }
  return [...hits.values()];
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
      duplicates = await findPartyDuplicates(spec.resource, preview.party_values, type.endsWith('_update') ? preview.target_id : undefined, env, fetcher);
      if (type.endsWith('_update')) counterparty = await exists(spec.resource, preview.target_id, env, fetcher, check, spec.resource === 'clients' ? 'client' : 'supplier');
    } else if (type === 'product_create') {
      duplicates = findProductDuplicates(await readCompleteCollection('products', env, fetcher), body);
    } else if (type === 'product_update') {
      counterparty = await exists('products', preview.target_id, env, fetcher, check, 'product');
      duplicates = findProductDuplicates(await readCompleteCollection('products', env, fetcher), body, preview.target_id, ['barcode', 'product_code']);
    } else if (type === 'category_create') {
      const rows = await readCompleteCollection('product_categories', env, fetcher);
      duplicates = rows.filter((r) => norm(r.name) === norm(body.name) && String(r.parent_id ?? 0) === String(body.parent_id ?? 0)).map((r) => ({ entity: 'product_categories', id: String(r.id) }));
    } else if (type === 'category_update') {
      counterparty = await exists('product_categories', preview.target_id, env, fetcher, check, 'category');
      if (preview.parent_id) {                                                    // walk the ancestor chain: no cycles
        let cursor = String(preview.parent_id); let cycle = false;
        for (let depth = 0; depth < 12 && cursor && cursor !== '0'; depth++) {
          if (cursor === String(preview.target_id)) { cycle = true; break; }
          try { cursor = String((await getOne('product_categories', cursor, env, fetcher)).parent_id ?? 0); } catch { break; }
        }
        check(!cycle, 'no_category_cycle', cycle ? 'Setting this parent would create a category cycle' : 'No category cycle', true);
      }
    }
    const open = duplicates.filter((d) => !acknowledged.has(d.entity + '#' + d.id));
    check(open.length === 0, 'no_remote_duplicate', open.length
      ? 'Possible duplicates already in Daftra: ' + open.map((d) => d.entity + '#' + d.id + (d.reasons ? ' (' + d.reasons.join(', ') + ')' : '')).join(', ') + ' (re-propose with acknowledge_duplicates to override)'
      : (duplicates.length ? 'Possible duplicates acknowledged by the requester' : 'No duplicate found'), true);
  } catch (e) { check(false, 'no_remote_duplicate', 'Duplicate scan failed (' + e.message + ')', true); }
  if (snapshot && counterparty) {
    const changed = Object.entries(snapshot).filter(([f, v]) => snap(counterparty[f]) !== v).map(([f]) => f);
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
    snapshot = Object.fromEntries(preview.changes.map((c) => [c.field, snap(current[c.field])]));
    for (const f of preview.carried_fields ?? []) snapshot[f] = snap(current[f]);   // supplier: every carried field must also be unchanged
  }
  if (type === 'expense') {
    // Expenses support a real server-side idempotency key; derive it from the request itself.
    preview = prepareFinancialAction(type, input, { taxes, requireDate: true, idempotencyKey: 'basht-' + preview.request_hash.slice(0, 40) });
  }
  const acknowledged = new Set((input.acknowledge_duplicates ?? []).map(String));
  const collected = await collectChecks(type, preview, env, fetcher, acknowledged, { snapshot });
  const effective = [...preBlocking, ...extraBlocking, ...collected.blocking];
  const ledger = await readLedger(env);
  const ledgerState = isBlockedByLedger(ledger, preview.request_hash, { idempotent: preview.request.method === 'PUT' });
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
    tenant: tenantOf(env),
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
