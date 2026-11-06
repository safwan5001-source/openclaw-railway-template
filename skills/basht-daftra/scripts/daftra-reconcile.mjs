// Client invoice <-> payment reconciliation (READ ONLY: GET only, nothing is written to Daftra, no journal entries).
//
// Why: the invoice_payments LIST can omit settlements that Daftra itself applied to an invoice (observed: client_credit
// payments that appear in the invoice detail and in the single-record GET but not in the list). A list that is page-complete
// is therefore NOT proof that every kind of settlement is covered. This module cross-checks three sources and refuses to
// guess:
//   1. invoices LIST (period, client)         -> invoice ids, summary_total / summary_paid / summary_unpaid
//   2. invoice_payments LIST (client)         -> payments (page-complete is proven by fetchAllRecords, which says nothing about coverage)
//   3. invoice DETAIL (GET invoices/<id>)     -> payments embedded in the invoice (`data.Payment`, assumed shape, see docs)
//   4. invoice_payments/<id> (single GET)     -> identity / invoice / amount / status confirmation, ONLY when needed
// Payments are merged by their stable Daftra id. Any disagreement between sources, a missing id, an unreadable record or an
// unknown status leaves the payment (and its invoice) UNRESOLVED; amounts are never chosen silently or inferred.
//
// Output is a locally computed working paper (`official: false`), not a Daftra statement, and `client_credit` settlements are
// reported as "credit applied, source of the customer balance NOT verified": the origin and journal entry of a client credit
// need an independent check.
import { fetchAllRecords, getOne, getRecord } from './daftra-readonly.mjs';
import { isCalendarDate } from './daftra-entities.mjs';
import { format, ZERO } from './daftra-money.mjs';
import { money } from './daftra-statements.mjs';

const POSITIVE_ID = /^[1-9][0-9]{0,14}$/;
export const SUCCESS_STATUS = new Set(['1', 'completed', 'success', 'successful']);
export const NOT_SUCCESS_STATUS = new Set(['0', 'failed', 'failure', 'cancelled', 'canceled', 'void', 'voided']);
export const CLIENT_CREDIT_METHOD = 'client_credit';
export const MAX_INVOICES = 300;
export const MAX_INDIVIDUAL_GETS = 200;
const isTrue = (v) => v === true || v === 1 || v === '1';
const str = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const idOf = (v) => { const s = str(v); return s !== null && POSITIVE_ID.test(s) ? s : null; };
const tryMoney = (v) => { if (str(v) === null) return null; try { return money(v, 'amount'); } catch { return undefined; } };   // null = absent, undefined = invalid

// One observation of a payment from one source, with the fields we compare.
export function normalizePayment(raw, source, containerInvoiceId = null) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.InvoicePayment ?? raw.Payment ?? raw) : {};
  const own = idOf(r.invoice_id);
  const problems = [];
  if (str(r.invoice_id) !== null && own === null) problems.push('invoice_id_invalid');
  if (containerInvoiceId !== null && own !== null && own !== containerInvoiceId) problems.push('invoice_id_differs_from_container');
  const amount = tryMoney(r.amount);
  if (amount === undefined) problems.push('amount_invalid');
  const status = str(r.status);
  return {
    source, container: containerInvoiceId, id: idOf(r.id), raw_id: str(r.id), invoice_id: own ?? containerInvoiceId, claimed_invoice_id: own,
    amount: amount === undefined ? null : amount, amount_text: str(r.amount), status: status === null ? null : status.toLowerCase(),
    method: str(r.payment_method ?? r.method)?.toLowerCase() ?? null, date: str(r.date)?.slice(0, 10) ?? null, problems,
  };
}

// Payments embedded in an invoice detail. `present` is false when the response has no recognisable payments section at all.
export function embeddedPayments(payload) {
  const data = payload?.data;
  const section = Array.isArray(data?.Payment) ? data.Payment : Array.isArray(data?.InvoicePayment) ? data.InvoicePayment : null;
  return { present: section !== null, rows: section ?? [] };
}

const FIELDS = ['amount', 'invoice_id', 'status', 'method'];
const show = (f, v) => (f === 'amount' ? format(v) : String(v));

// Merge observations that share a stable id. Returns one record per id with conflicts listed (never resolved by choice).
export function mergeObservations(observations) {
  const byId = new Map();
  for (const o of observations) {
    if (!byId.has(o.id)) byId.set(o.id, { id: o.id, observations: [] });
    byId.get(o.id).observations.push(o);
  }
  return [...byId.values()].map((rec) => {
    const conflicts = [];
    const values = {};
    for (const f of FIELDS) {
      const seen = new Map();
      for (const o of rec.observations) {
        const v = f === 'invoice_id' ? o.claimed_invoice_id ?? o.invoice_id : o[f];
        if (v === null || v === undefined) continue;
        const key = String(v);
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(o.source);
      }
      if (seen.size > 1) conflicts.push({ field: f, values: [...seen.entries()].map(([k, srcs]) => ({ value: f === 'amount' ? format(BigInt(k)) : k, sources: [...new Set(srcs)] })) });
      values[f] = seen.size === 1 ? [...seen.keys()][0] : null;
    }
    const sources = [...new Set(rec.observations.map((o) => o.source))];
    const duplicates = rec.observations.length - sources.length > 0 && sources.some((s) => rec.observations.filter((o) => o.source === s).length > 1);
    const problems = [...new Set(rec.observations.flatMap((o) => o.problems))];
    return { id: rec.id, sources, conflicts, duplicate_in_source: duplicates, problems, observations: rec.observations,
      amount: values.amount === null ? null : BigInt(values.amount), invoice_id: values.invoice_id, status: values.status, method: values.method,
      date: rec.observations.find((o) => o.date)?.date ?? null };
  });
}

function classifyStatus(status) {
  if (status === null) return 'unknown';
  if (SUCCESS_STATUS.has(status)) return 'success';
  if (NOT_SUCCESS_STATUS.has(status)) return 'not_success';
  return 'unrecognised';
}

// Pure core: everything already fetched. `individual` = Map(paymentId -> observation | { error }).
export function reconcile({ clientId, from, to, invoices, listPayments, details, individual = new Map(), listComplete = true }) {
  const warnings = [];
  const periodInvoices = [];
  const skipped = [];
  for (const inv of invoices) {
    const type = Number(inv.type ?? 0);
    if (isTrue(inv.draft)) skipped.push({ id: String(inv.id), no: str(inv.no), reason: 'draft' });
    else if (type !== 0 && type !== 16) skipped.push({ id: String(inv.id), no: str(inv.no), reason: 'document type ' + type + ' is not an invoice/debit note' });
    else periodInvoices.push(inv);
  }
  const invoiceIds = new Set(periodInvoices.map((i) => String(i.id)));

  // 1. observations
  const observations = []; const unidentified = []; const globalProblems = [];
  const listIds = new Set();
  for (const p of listPayments) {
    const o = normalizePayment(p, 'list');
    if (o.id === null) { unidentified.push({ source: 'list', raw_id: o.raw_id, invoice_id: o.invoice_id, amount: o.amount_text }); continue; }
    listIds.add(o.id); observations.push(o);
  }
  const detailState = new Map();       // invoiceId -> { ok, present, error }
  for (const [invId, d] of details) {
    if (d.error) { detailState.set(invId, { ok: false, error: d.error }); continue; }
    const { present, rows } = embeddedPayments(d.payload);
    detailState.set(invId, { ok: true, present, header: d.header });
    for (const row of rows) {
      const o = normalizePayment(row, 'detail', invId);
      if (o.id === null) { unidentified.push({ source: 'detail', raw_id: o.raw_id, invoice_id: invId, amount: o.amount_text }); continue; }
      observations.push(o);
    }
  }
  for (const [pid, o] of individual) if (!o.error) observations.push(o);
  const merged = mergeObservations(observations);

  // 2. per-payment state
  const payments = merged.map((m) => {
    const reasons = [];
    const failedGet = individual.get(m.id)?.error;
    if (m.conflicts.length) reasons.push('conflict:' + m.conflicts.map((c) => c.field).join('/'));
    if (m.problems.length) reasons.push(...m.problems);
    if (failedGet) reasons.push('individual_get_failed');
    const crossChecked = m.sources.includes('individual') || m.sources.filter((s) => s !== 'individual').length >= 2;
    if (!crossChecked && !failedGet) reasons.push('single_source_unverified');
    if (m.amount === null && !m.conflicts.some((c) => c.field === 'amount')) reasons.push('amount_missing');
    if (m.invoice_id === null && !m.conflicts.some((c) => c.field === 'invoice_id')) reasons.push('invoice_id_missing');
    const kind = classifyStatus(m.status);
    if (kind === 'unknown' && !m.conflicts.some((c) => c.field === 'status')) reasons.push('status_missing');
    if (kind === 'unrecognised') reasons.push('status_unrecognised:' + m.status);
    if (m.amount !== null && m.amount <= ZERO && kind === 'success') reasons.push('non_positive_amount');
    const resolved = reasons.length === 0;
    const state = resolved ? (kind === 'success' ? 'verified' : 'not_counted') : 'unresolved';
    const category = m.method === null ? 'unclassified' : m.method === CLIENT_CREDIT_METHOD ? 'client_credit' : 'cash_bank';
    const candidateInvoices = [...new Set([m.invoice_id, ...m.conflicts.filter((c) => c.field === 'invoice_id').flatMap((c) => c.values.map((v) => v.value)), ...m.observations.flatMap((o) => [o.invoice_id, o.container])].filter(Boolean))];
    return {
      id: m.id, invoice_id: m.invoice_id, candidate_invoices: candidateInvoices, amount: m.amount, status: m.status, method: m.method, category, date: m.date,
      sources: m.sources, in_list: m.sources.includes('list'), conflicts: m.conflicts, duplicate_in_source: m.duplicate_in_source, state, reasons,
      credit_source: category === 'client_credit' ? 'unverified' : undefined,
    };
  });

  // 3. per-invoice reconciliation
  const rows = periodInvoices.map((inv) => {
    const id = String(inv.id); const reasons = [];
    const ds = detailState.get(id);
    const header = ds?.header ?? null;
    let total; let paid; let unpaid;
    const read = (name) => {
      const a = tryMoney(inv[name]); const b = header ? tryMoney(header[name]) : null;
      if (a === undefined || b === undefined) { reasons.push('summary_invalid:' + name); return null; }
      if (a !== null && b !== null && a !== b) reasons.push('summary_conflict:' + name + ' list ' + format(a) + ' vs detail ' + format(b));
      const v = a ?? b;
      if (v === null) reasons.push('summary_missing:' + name);
      return v;
    };
    total = read('summary_total'); paid = read('summary_paid'); unpaid = read('summary_unpaid');
    if (total !== null && paid !== null && unpaid !== null && total - paid !== unpaid) reasons.push('summary_inconsistent: total - paid != unpaid');
    if (!ds || !ds.ok) reasons.push('detail_unavailable' + (ds?.error ? ' (' + ds.error + ')' : ''));
    else if (!ds.present && !(paid === ZERO)) reasons.push('payments_section_not_found_in_detail');
    const mine = payments.filter((p) => p.candidate_invoices.includes(id));
    for (const u of unidentified) if (u.invoice_id === id) reasons.push('payment_without_stable_id(' + u.source + ')');
    const unresolvedPayments = mine.filter((p) => p.state === 'unresolved');
    if (unresolvedPayments.length) reasons.push('unresolved_payments:' + unresolvedPayments.map((p) => p.id).join(','));
    const counted = mine.filter((p) => p.state === 'verified' && p.invoice_id === id);
    const proven = counted.reduce((s, p) => s + p.amount, ZERO);
    const byCat = { cash_bank: ZERO, client_credit: ZERO, unclassified: ZERO };
    for (const p of counted) byCat[p.category] += p.amount;
    let state;
    if (reasons.length) state = 'unresolved';
    else if (proven !== paid) { state = 'mismatch'; reasons.push('proven payments ' + format(proven) + ' != summary_paid ' + format(paid)); }
    else state = 'matched';
    const notCounted = mine.filter((p) => p.state === 'not_counted');
    return {
      id, no: str(inv.no), date: str(inv.date)?.slice(0, 10), state, reasons,
      summary_total: total === null ? null : format(total), summary_paid: paid === null ? null : format(paid), summary_unpaid: unpaid === null ? null : format(unpaid),
      proven_paid: format(proven), cash_bank: format(byCat.cash_bank), client_credit: format(byCat.client_credit), unclassified: format(byCat.unclassified),
      partially_paid: paid !== null && total !== null && paid > ZERO && paid < total,
      payments: mine.map((p) => p.id), not_counted_payments: notCounted.map((p) => ({ id: p.id, status: p.status, amount: p.amount === null ? null : format(p.amount) })),
      missing_from_list: counted.filter((p) => !p.in_list).map((p) => p.id),
    };
  });

  // 4. totals
  const sum = (f) => rows.reduce((s, r) => s + (r[f] === null ? ZERO : money(r[f], f)), ZERO);
  const verified = payments.filter((p) => p.state === 'verified' && invoiceIds.has(p.invoice_id));
  const cat = (c) => verified.filter((p) => p.category === c).reduce((s, p) => s + p.amount, ZERO);
  const unresolvedAmount = payments.filter((p) => p.state === 'unresolved' && p.amount !== null).reduce((s, p) => s + p.amount, ZERO);
  const stateCounts = { matched: 0, mismatch: 0, unresolved: 0 };
  for (const r of rows) stateCounts[r.state]++;
  const outside = payments.filter((p) => !p.candidate_invoices.some((i) => invoiceIds.has(i)));
  const listMissing = verified.filter((p) => !p.in_list);
  const resolved = stateCounts.mismatch === 0 && stateCounts.unresolved === 0 && unidentified.length === 0 && rows.length > 0;
  const totals = {
    invoices: rows.length, summary_total: format(sum('summary_total')), summary_paid: format(sum('summary_paid')), summary_unpaid: format(sum('summary_unpaid')),
    proven_paid: format(verified.reduce((s, p) => s + p.amount, ZERO)),
    proven_cash_bank: format(cat('cash_bank')), proven_client_credit: format(cat('client_credit')), proven_unclassified: format(cat('unclassified')),
    list_only_payments_total: format(verified.filter((p) => p.in_list).reduce((s, p) => s + p.amount, ZERO)),
    not_in_list_total: format(listMissing.reduce((s, p) => s + p.amount, ZERO)),
    unresolved_payments_amount: format(unresolvedAmount),
    gap_summary_paid_minus_proven: format(sum('summary_paid') - verified.reduce((s, p) => s + p.amount, ZERO)),
  };
  if (listMissing.length) warnings.push(listMissing.length + ' payment(s) are applied to invoices but ABSENT from the invoice_payments list (' + listMissing.map((p) => p.id + ' ' + p.category).join(', ') + '): a page-complete list does not cover every settlement type.');
  if (verified.some((p) => p.category === 'client_credit')) warnings.push('client_credit payments were found. They prove only that Daftra applied customer credit to the invoice; the SOURCE of that credit and its journal entry are NOT verified and need an independent check (client balance / ledger).');
  if (verified.some((p) => p.category === 'unclassified')) warnings.push('Some verified payments have no payment_method, so they cannot be split between cash/bank and client_credit.');
  if (skipped.length) warnings.push(skipped.length + ' document(s) in the period were skipped (drafts / non-invoice types): ' + skipped.map((s) => s.id + ' ' + s.reason).join('; '));
  if (unidentified.length) warnings.push(unidentified.length + ' payment record(s) have no stable id and cannot be merged or counted.');
  if (payments.some((p) => p.duplicate_in_source)) warnings.push('The same payment id appears more than once in one source; it was counted once.');
  if (outside.length) warnings.push(outside.length + ' payment(s) of this client are not linked to a period invoice (other period or on-account) and were not counted.');
  if (!rows.length) warnings.push('No invoices were found for this client and period, so nothing could be reconciled.');
  warnings.push('Computed locally from Daftra reads; not an official statement and no accounting entry was made or checked.');
  return {
    client_id: String(clientId), from, to, official: false,
    // Two different questions: did we READ every page, and do the sources prove EVERY settlement?
    listing_complete: listComplete === true,
    accounting_coverage: resolved ? 'complete' : 'unresolved',
    coverage_note: 'listing_complete only says every page of the lists was read. accounting_coverage is "complete" only when every invoice\'s summary_paid is explained by payments verified by id across independent sources, with no conflict, missing id or unreadable record.',
    state_counts: stateCounts, totals,
    invoices: rows,
    payments: payments.map((p) => ({ id: p.id, invoice_id: p.invoice_id, candidate_invoices: p.candidate_invoices.length > 1 ? p.candidate_invoices : undefined, amount: p.amount === null ? null : format(p.amount), status: p.status, method: p.method, category: p.category, date: p.date,
      sources: p.sources, in_list: p.in_list, state: p.state, reasons: p.reasons, conflicts: p.conflicts.length ? p.conflicts : undefined, credit_source: p.credit_source })),
    unidentified_payments: unidentified, outside_period_payments: outside.map((p) => p.id), skipped_documents: skipped,
    warnings,
  };
}

const sleepless = async () => {};
// Orchestrator (GET only). fetchAllRecords proves page-completeness or throws; any failure of a LIST aborts (nothing partial is reported).
export async function reconcileClientPayments({ clientId, from, to }, env, fetcher, options = {}) {
  if (!POSITIVE_ID.test(String(clientId))) throw Error('Invalid client id');
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw Error('from/to must be valid YYYY-MM-DD dates with from <= to');
  const opts = { sleep: options.sleep ?? sleepless };
  const invoicesPage = await fetchAllRecords('invoices', { ...opts, query: { client_id: String(clientId), date_from: from, date_to: to } }, env, fetcher);
  // Daftra may silently ignore client/date filters. Never compute a client report from out-of-scope or
  // unidentifiable list rows. Reject the entire result instead of dropping rows and claiming completeness.
  for (const inv of invoicesPage.records) {
    const id = idOf(inv.id);
    const party = idOf(inv.client_id);
    const date = str(inv.date)?.slice(0, 10);
    if (!id || party !== String(clientId) || !date || !isCalendarDate(date) || date < from || date > to)
      throw Error('Invoice list scope mismatch: unexpected/missing invoice id, client_id or date (invoice ' + String(inv.id ?? 'unknown') + '); Daftra may have ignored its filters; reconciliation blocked');
  }
  if (invoicesPage.records.length > MAX_INVOICES) throw Error('Too many invoices (' + invoicesPage.records.length + ' > ' + MAX_INVOICES + '); narrow the period');
  // No status filter and no date filter on the payments list: cancelled/failed payments and payments dated after the period must stay visible.
  const paymentsPage = await fetchAllRecords('invoice_payments', { ...opts, query: { client_id: String(clientId) } }, env, fetcher);
  const listComplete = invoicesPage.complete === true && paymentsPage.complete === true;

  const details = new Map();
  const targets = invoicesPage.records.filter((i) => !isTrue(i.draft) && [0, 16].includes(Number(i.type ?? 0)));
  for (let i = 0; i < targets.length; i += 4) {
    await Promise.all(targets.slice(i, i + 4).map(async (inv) => {
      const id = String(inv.id);
      try {
        const payload = await getRecord('invoices', id, env, fetcher);
        const header = payload?.data?.Invoice;
        if (!header || typeof header !== 'object' || String(header.id) !== id) throw Error('detail has no Invoice with id ' + id);
        if (idOf(header.client_id) !== String(clientId) || str(header.date)?.slice(0, 10) !== str(inv.date)?.slice(0, 10))
          throw Error('detail scope mismatch for invoice ' + id + ': client/date differs from the list');
        details.set(id, { payload, header });
      } catch (e) { details.set(id, { error: String(e.message).slice(0, 120) }); }
    }));
  }

  // First pass without single GETs, to decide which payments need an independent confirmation.
  const first = reconcile({ clientId, from, to, invoices: invoicesPage.records, listPayments: paymentsPage.records, details, listComplete });
  const need = first.payments.filter((p) => p.reasons.some((r) => r === 'single_source_unverified' || r.startsWith('conflict') || r === 'status_missing' || r === 'amount_missing' || r === 'invoice_id_missing')).map((p) => p.id);
  const individual = new Map();
  const todo = need.slice(0, MAX_INDIVIDUAL_GETS);
  for (const id of need.slice(MAX_INDIVIDUAL_GETS)) individual.set(id, { error: 'verification limit reached' });
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async (id) => {
      try {
        const rec = await getOne('invoice_payments', id, env, fetcher);
        if (String(rec?.id) !== id) throw Error('single GET returned id ' + String(rec?.id));
        individual.set(id, normalizePayment(rec, 'individual'));
      } catch (e) { individual.set(id, { error: String(e.message).slice(0, 120) }); }
    }));
  }
  const result = reconcile({ clientId, from, to, invoices: invoicesPage.records, listPayments: paymentsPage.records, details, individual, listComplete });
  return { ...result, provenance: { source: 'Daftra API (GET only)', counts: { invoices_listed: invoicesPage.count, payments_listed: paymentsPage.count, invoice_details_read: [...details.values()].filter((d) => !d.error).length, individual_payment_reads: [...individual.values()].filter((o) => !o.error).length }, fetched_at: new Date().toISOString() } };
}
