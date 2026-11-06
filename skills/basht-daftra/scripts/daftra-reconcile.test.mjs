// Invoice <-> payment reconciliation. All data is SYNTHETIC; the fetcher is GET-only and records every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcileClientPayments, reconcile, normalizePayment, embeddedPayments, EMBEDDED_PATHS, CASH_BANK_METHODS } from './daftra-reconcile.mjs';
import { normalizeDaftraDate } from './daftra-entities.mjs';
import { run } from './daftra-cli.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'dummy' };
const noSleep = async () => {};
const R = (o) => reconcileClientPayments({ clientId: 48, from: '2026-10-01', to: '2026-11-06' }, env, o.fetcher, { sleep: noSleep });

const inv = (id, total, paid, extra = {}) => ({ id, no: String(id), date: '2026-10-15', client_id: 48, type: 0, draft: 0, summary_total: total, summary_paid: paid, summary_unpaid: (Number(total) - Number(paid)).toFixed(2), ...extra });
const pay = (id, invoice_id, amount, extra = {}) => ({ id, invoice_id, amount, status: 1, payment_method: 'bank', date: '2026-10-20', client_id: 48, ...extra });

// world({ invoices, list, embedded: {invoiceId: [payments] | undefined}, singles: {paymentId: record | number(HTTP status)}, ... })
function world({ invoices, list = [], embedded = {}, embeddedAt = {}, singles = {}, detailHeader = {}, detailFail = {}, listFail = null, listTotalOverride = null, invoiceListFail = null, pageSize }) {
  const calls = [];
  const page = (rows, model, url, total = rows.length) => {
    const limit = Number(url.searchParams.get('limit') || 100); const p = Number(url.searchParams.get('page') || 1);
    const pageCount = Math.max(1, Math.ceil(total / limit));
    return new Response(JSON.stringify({ code: 200, data: rows.slice((p - 1) * limit, p * limit).map((r) => ({ [model]: r })),
      pagination: { prev: p > 1 ? 'p' : null, next: p < pageCount ? 'n' : null, page: p, page_count: pageCount, total_results: total } }), { status: 200 });
  };
  const fetcher = async (url, o = {}) => {
    calls.push({ method: o.method ?? 'GET', path: url.pathname, search: url.search });
    let m;
    if (url.pathname === '/api2/invoices.json') return invoiceListFail ? new Response('{}', { status: invoiceListFail }) : page(invoices, 'Invoice', url, invoiceListFail === null ? undefined : 0);
    if (url.pathname === '/api2/invoice_payments.json') {
      if (listFail && Number(url.searchParams.get('page')) === listFail.page) return new Response('{}', { status: listFail.status });
      return page(list, 'InvoicePayment', url, listTotalOverride ?? list.length);
    }
    if ((m = url.pathname.match(/^\/api2\/invoices\/(\d+)\.json$/))) {
      const id = m[1]; const row = invoices.find((i) => String(i.id) === id);
      if (detailFail[id]) return new Response('{}', { status: detailFail[id] });
      if (!row) return new Response('{}', { status: 404 });
      const data = { Invoice: { ...row, ...(detailHeader[id] ?? {}) }, InvoiceItem: [] };
      if (embedded[id] !== undefined) data.Payment = embedded[id];
      if (embeddedAt.InvoicePayment?.[id] !== undefined) data.InvoicePayment = embeddedAt.InvoicePayment[id];
      if (embeddedAt['Invoice.InvoicePayment']?.[id] !== undefined) data.Invoice.InvoicePayment = embeddedAt['Invoice.InvoicePayment'][id];
      return new Response(JSON.stringify({ code: 200, data }), { status: 200 });
    }
    if ((m = url.pathname.match(/^\/api2\/invoice_payments\/(\d+)\.json$/))) {
      const s = singles[m[1]];
      if (typeof s === 'number') return new Response('{}', { status: s });
      return s ? new Response(JSON.stringify({ code: 200, data: { InvoicePayment: s } }), { status: 200 }) : new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls };
}
const one = (r, id) => r.invoices.find((i) => i.id === String(id));
const payment = (r, id) => r.payments.find((p) => p.id === String(id));
const singleGets = (w) => w.calls.filter((c) => /^\/api2\/invoice_payments\/\d+\.json$/.test(c.path)).map((c) => c.path.match(/payments\/(\d+)/)[1]);

test('payment in the LIST and in the invoice DETAIL: cross-checked by id, matched, no single GET needed', async () => {
  const p = pay(1001, 10, '500.00');
  const w = world({ invoices: [inv(10, '500.00', '500.00')], list: [p], embedded: { 10: [p] } });
  const r = await R(w);
  assert.equal(one(r, 10).state, 'matched'); assert.deepEqual(payment(r, 1001).sources, ['list', 'detail']);
  assert.equal(r.accounting_coverage, 'complete'); assert.equal(r.listing_complete, true); assert.equal(r.official, false);
  assert.deepEqual(singleGets(w), []);
  assert.equal(r.totals.proven_paid, '500.00');
});

test('payment ONLY in the invoice detail: confirmed by the single GET, reported as missing from the list', async () => {
  const p = pay(2001, 11, '750.00', { payment_method: 'cash' });
  const w = world({ invoices: [inv(11, '750.00', '750.00')], list: [], embedded: { 11: [p] }, singles: { 2001: p } });
  const r = await R(w);
  assert.deepEqual(singleGets(w), ['2001']);
  assert.equal(one(r, 11).state, 'matched'); assert.deepEqual(one(r, 11).missing_from_list, ['2001']);
  assert.equal(r.totals.not_in_list_total, '750.00');
  assert.ok(r.warnings.some((x) => /ABSENT from the invoice_payments list/.test(x)));
  assert.equal(r.accounting_coverage, 'complete');
});

test('client_credit payment is separated from cash/bank and its credit source is reported as UNVERIFIED', async () => {
  const cash = pay(3001, 12, '100.00'); const credit = pay(3002, 12, '400.00', { payment_method: 'client_credit' });
  const w = world({ invoices: [inv(12, '500.00', '500.00')], list: [cash], embedded: { 12: [cash, credit] }, singles: { 3002: credit } });
  const r = await R(w);
  assert.equal(one(r, 12).cash_bank, '100.00'); assert.equal(one(r, 12).client_credit, '400.00'); assert.equal(one(r, 12).state, 'matched');
  assert.equal(r.totals.proven_cash_bank, '100.00'); assert.equal(r.totals.proven_client_credit, '400.00');
  assert.equal(payment(r, 3002).category, 'client_credit'); assert.equal(payment(r, 3002).credit_source, 'unverified'); assert.equal(payment(r, 3001).credit_source, undefined);
  assert.ok(r.warnings.some((x) => /SOURCE of that credit and its journal entry are NOT verified/.test(x)));
  assert.doesNotMatch(JSON.stringify(r), /accounting(ally)? correct|"credit_verified"/i);
});

test('the same payment id twice: identical copies count once; different copies are a conflict, never summed; a duplicated LIST id is refused', async () => {
  const p = pay(4001, 13, '300.00');
  let r = await R(world({ invoices: [inv(13, '300.00', '300.00')], list: [p], embedded: { 13: [p, p] } }));
  assert.equal(one(r, 13).state, 'matched'); assert.equal(r.totals.proven_paid, '300.00'); assert.equal(payment(r, 4001).conflicts, undefined);
  assert.ok(r.warnings.some((x) => /repeated inside one source/.test(x)));
  r = await R(world({ invoices: [inv(13, '300.00', '300.00')], list: [p], embedded: { 13: [p, { ...p, amount: '310.00' }] }, singles: { 4001: p } }));
  assert.equal(one(r, 13).state, 'unresolved'); assert.equal(payment(r, 4001).state, 'unresolved'); assert.equal(r.totals.proven_paid, '0.00');
  // one payment id embedded under two different invoices
  r = await R(world({ invoices: [inv(13, '300.00', '300.00'), inv(14, '300.00', '300.00')], list: [], embedded: { 13: [p], 14: [p] }, singles: { 4001: p } }));
  assert.equal(one(r, 13).state, 'unresolved'); assert.equal(one(r, 14).state, 'unresolved');
  assert.equal(r.totals.proven_paid, '0.00');
  // the paginated reader itself refuses a list that repeats an id (so the list can never double-count)
  await assert.rejects(R(world({ invoices: [inv(13, '300.00', '300.00')], list: [p, p], embedded: { 13: [p] } })), /duplicate record id|blocked/i);
});

test('conflicting amount / invoice / status between sources: shown, never chosen; invoice is UNRESOLVED', async () => {
  const base = pay(5001, 15, '100.00');
  const cases = {
    amount: [{ ...base, amount: '110.00' }, 'amount'],
    invoice: [{ ...base, invoice_id: 16 }, 'invoice_id'],
    status: [{ ...base, status: 0 }, 'status'],
  };
  for (const [name, [detailVersion, field]] of Object.entries(cases)) {
    const w = world({ invoices: [inv(15, '100.00', '100.00'), inv(16, '50.00', '0.00')], list: [base], embedded: { 15: [detailVersion], 16: [] }, singles: { 5001: base } });
    const r = await R(w);
    const p = payment(r, 5001);
    assert.equal(p.state, 'unresolved', name);
    assert.ok(p.conflicts.some((c) => c.field === field && c.values.length >= 2), name);
    assert.equal(one(r, 15).state, 'unresolved', name);
    assert.equal(r.accounting_coverage, 'unresolved', name);
    assert.equal(r.listing_complete, true, name);                          // pages were all read; coverage is still not proven
    assert.equal(r.totals.proven_paid, '0.00', name);
  }
});

test('cancelled / unsuccessful payments are not counted; unrecognised statuses are unresolved, not guessed', async () => {
  const ok = pay(6001, 17, '100.00'); const cancelled = pay(6002, 17, '40.00', { status: 0 });
  let r = await R(world({ invoices: [inv(17, '100.00', '100.00')], list: [ok, cancelled], embedded: { 17: [ok, cancelled] } }));
  assert.equal(one(r, 17).state, 'matched'); assert.equal(one(r, 17).proven_paid, '100.00');
  assert.equal(payment(r, 6002).state, 'not_counted'); assert.deepEqual(one(r, 17).not_counted_payments, [{ id: '6002', status: '0', amount: '40.00' }]);
  // Daftra says paid 140 but only 100 is a successful payment => mismatch, not silently "fixed"
  r = await R(world({ invoices: [inv(17, '140.00', '140.00')], list: [ok, cancelled], embedded: { 17: [ok, cancelled] } }));
  assert.equal(one(r, 17).state, 'mismatch'); assert.match(one(r, 17).reasons.join(' '), /proven payments 100\.00 != summary_paid 140\.00/);
  const weird = pay(6003, 18, '10.00', { status: 7 });
  r = await R(world({ invoices: [inv(18, '10.00', '10.00')], list: [weird], embedded: { 18: [weird] } }));
  assert.equal(one(r, 18).state, 'unresolved'); assert.match(payment(r, 6003).reasons.join(' '), /status_unrecognised:7/);
});

test('a payment without a stable id cannot be merged or counted; the invoice stays unresolved', async () => {
  const noId = { invoice_id: 19, amount: '60.00', status: 1, payment_method: 'cash' };
  for (const where of ['detail', 'list']) {
    const w = world({ invoices: [inv(19, '60.00', '60.00')], list: where === 'list' ? [noId] : [], embedded: { 19: where === 'detail' ? [noId] : [] } });
    const r = await R(w);
    assert.equal(r.unidentified_payments.length, 1, where); assert.equal(r.unidentified_payments[0].source, where);
    assert.equal(r.totals.proven_paid, '0.00', where); assert.equal(r.accounting_coverage, 'unresolved', where);
    assert.ok(r.warnings.some((x) => /no stable id/.test(x)), where);
  }
  assert.equal(normalizePayment({ id: '', amount: '1' }, 'list').id, null);
  assert.equal(normalizePayment({ id: '0', amount: '1' }, 'list').id, null);
});

test('failed single GET (404 / 500 / wrong id) leaves the payment and invoice unresolved', async () => {
  const p = pay(7001, 20, '90.00');
  for (const single of [404, 500, { ...p, id: 7999 }]) {
    const r = await R(world({ invoices: [inv(20, '90.00', '90.00')], list: [], embedded: { 20: [p] }, singles: { 7001: single } }));
    assert.equal(one(r, 20).state, 'unresolved', JSON.stringify(single)); assert.match(payment(r, 7001).reasons.join(' '), /individual_get_failed/);
    assert.equal(r.totals.proven_paid, '0.00');
  }
});

test('pagination failure or missing pages abort the reconciliation (nothing partial is reported)', async () => {
  const invs = Array.from({ length: 3 }, (_, i) => inv(30 + i, '10.00', '10.00'));
  const list = invs.map((x, i) => pay(8000 + i, x.id, '10.00'));
  const embedded = Object.fromEntries(invs.map((x, i) => [x.id, [list[i]]]));
  await assert.rejects(R(world({ invoices: invs, list, embedded, listFail: { page: 1, status: 500 } })), /failed|500/);
  await assert.rejects(R(world({ invoices: invs, list, embedded, listTotalOverride: 5 })), /blocked|Pagination|collected|total/i);          // fewer rows than total_results
  await assert.rejects(R(world({ invoices: invs, list, embedded, invoiceListFail: 503 })), /failed|503/);
  // a later page failing
  const many = Array.from({ length: 250 }, (_, i) => pay(9000 + i, 30, '0.01'));
  await assert.rejects(R(world({ invoices: invs, list: many, embedded, listFail: { page: 2, status: 500 } })), /failed|500/);
});

test('one unreadable invoice detail only makes THAT invoice unresolved', async () => {
  const a = pay(8101, 40, '10.00'); const b = pay(8102, 41, '20.00');
  const r = await R(world({ invoices: [inv(40, '10.00', '10.00'), inv(41, '20.00', '20.00')], list: [a, b], embedded: { 40: [a], 41: [b] }, detailFail: { 41: 500 } }));
  assert.equal(one(r, 40).state, 'matched'); assert.equal(one(r, 41).state, 'unresolved'); assert.match(one(r, 41).reasons.join(' '), /detail_unavailable/);
  assert.deepEqual(r.state_counts, { matched: 1, mismatch: 0, unresolved: 1 });
});

test('partially paid invoice: matched against summary_paid/unpaid; a different proven amount is a mismatch', async () => {
  const p = pay(8201, 50, '400.00');
  let r = await R(world({ invoices: [inv(50, '1000.00', '400.00')], list: [p], embedded: { 50: [p] } }));
  assert.equal(one(r, 50).state, 'matched'); assert.equal(one(r, 50).partially_paid, true); assert.equal(one(r, 50).summary_unpaid, '600.00');
  assert.equal(r.totals.summary_unpaid, '600.00');
  const q = pay(8201, 50, '300.00');
  r = await R(world({ invoices: [inv(50, '1000.00', '400.00')], list: [q], embedded: { 50: [q] } }));
  assert.equal(one(r, 50).state, 'mismatch'); assert.equal(r.accounting_coverage, 'unresolved'); assert.equal(r.totals.gap_summary_paid_minus_proven, '100.00');
});

test('summary fields: inconsistent total/paid/unpaid or list-vs-detail disagreement is unresolved; missing payments section is not assumed empty', async () => {
  const p = pay(8301, 60, '100.00');
  let r = await R(world({ invoices: [inv(60, '100.00', '100.00', { summary_unpaid: '5.00' })], list: [p], embedded: { 60: [p] } }));
  assert.match(one(r, 60).reasons.join(' '), /summary_inconsistent/); assert.equal(one(r, 60).state, 'unresolved');
  r = await R(world({ invoices: [inv(60, '100.00', '100.00')], list: [p], embedded: { 60: [p] }, detailHeader: { 60: { summary_paid: '90.00', summary_unpaid: '10.00' } } }));
  assert.match(one(r, 60).reasons.join(' '), /summary_conflict:summary_paid/); assert.equal(one(r, 60).state, 'unresolved');
  r = await R(world({ invoices: [inv(61, '100.00', '100.00')], list: [pay(8302, 61, '100.00')], embedded: {} }));        // detail has no payments section
  assert.match(one(r, 61).reasons.join(' '), /payments_section_not_found_in_detail/); assert.equal(one(r, 61).state, 'unresolved');
  r = await R(world({ invoices: [inv(62, '100.00', '0.00')], list: [], embedded: { 62: [] } }));                           // genuinely unpaid
  assert.equal(one(r, 62).state, 'matched');
});

test('payments with no payment_method are counted but reported as unclassified', async () => {
  const p = pay(8401, 70, '25.00', { payment_method: null });
  const r = await R(world({ invoices: [inv(70, '25.00', '25.00')], list: [p], embedded: { 70: [p] } }));
  assert.equal(one(r, 70).unclassified, '25.00'); assert.equal(r.totals.proven_unclassified, '25.00'); assert.ok(r.warnings.some((x) => /could not be classified/.test(x) && /method_missing/.test(x)));
});

test('drafts and credit notes are skipped and reported, payments of other invoices are not counted', async () => {
  const p = pay(8501, 80, '10.00'); const other = pay(8502, 999, '77.00');
  const r = await R(world({ invoices: [inv(80, '10.00', '10.00'), inv(81, '5.00', '0.00', { draft: 1 }), inv(82, '5.00', '0.00', { type: 6 })], list: [p, other], embedded: { 80: [p] } }));
  assert.equal(r.totals.invoices, 1); assert.deepEqual(r.skipped_documents.map((s) => s.id), ['81', '82']);
  assert.deepEqual(r.outside_period_payments, ['8502']); assert.equal(r.totals.proven_paid, '10.00');
});

// ---------------------------------------------------------------------------------------------------------------
// Synthetic replica of the reported case: 19 invoices = 346,325.40; two client_credit settlements (84268 on 84382 = 20,815;
// 89373 on 89569 = 18,100) are visible in the invoice details and the single GET but NOT in the invoice_payments list.
function reported() {
  const invoices = []; const list = []; const embedded = {}; const singles = {};
  const add = (id, no, total, payment) => { invoices.push(inv(id, total, total, { no })); embedded[id] = [payment]; if (payment.payment_method !== 'client_credit') list.push(payment); else singles[payment.id] = payment; };
  add(84382, '007214', '20815.00', pay(84268, 84382, '20815.00', { payment_method: 'client_credit' }));
  add(89569, '007329', '18100.00', pay(89373, 89569, '18100.00', { payment_method: 'client_credit' }));
  for (let i = 0; i < 16; i++) add(90000 + i, '0075' + String(i).padStart(2, '0'), '18000.00', pay(95000 + i, 90000 + i, '18000.00', { payment_method: i % 2 ? 'bank' : 'cash' }));
  add(90016, '007599', '19410.40', pay(95016, 90016, '19410.40'));
  return { invoices, list, embedded, singles };
}

test('REPORTED CASE (synthetic): 19 invoices = 346,325.40; the two client_credit settlements missing from the list are found, verified by single GET and separated', async () => {
  const d = reported();
  assert.equal(d.invoices.length, 19);
  const w = world(d);
  const r = await R(w);
  assert.equal(r.totals.invoices, 19);
  assert.equal(r.totals.summary_total, '346325.40'); assert.equal(r.totals.summary_paid, '346325.40'); assert.equal(r.totals.summary_unpaid, '0.00');
  // what the LIST alone shows vs what Daftra applied
  assert.equal(r.totals.list_only_payments_total, '307410.40');
  assert.equal(r.totals.not_in_list_total, '38915.00');
  assert.equal(r.totals.proven_paid, '346325.40'); assert.equal(r.totals.gap_summary_paid_minus_proven, '0.00');
  assert.equal(r.totals.proven_client_credit, '38915.00'); assert.equal(r.totals.proven_cash_bank, '307410.40');
  assert.deepEqual(r.state_counts, { matched: 19, mismatch: 0, unresolved: 0 });
  assert.equal(r.listing_complete, true); assert.equal(r.accounting_coverage, 'complete');
  for (const [pid, invId, amt] of [['84268', '84382', '20815.00'], ['89373', '89569', '18100.00']]) {
    const p = payment(r, pid);
    assert.deepEqual({ invoice_id: p.invoice_id, amount: p.amount, category: p.category, in_list: p.in_list, state: p.state, credit_source: p.credit_source },
      { invoice_id: invId, amount: amt, category: 'client_credit', in_list: false, state: 'verified', credit_source: 'unverified' });
    assert.deepEqual(p.sources.sort(), ['detail', 'individual']);
  }
  assert.deepEqual(singleGets(w).sort(), ['84268', '89373']);                       // single GET only where needed
  assert.ok(r.warnings.some((x) => /client_credit/.test(x) && /NOT verified/.test(x)));
  assert.ok(r.warnings.some((x) => /not an official statement/.test(x)));
  assert.ok(w.calls.every((c) => c.method === 'GET'));                              // read only
});

test('REPORTED CASE: if one of the two single GETs fails, the case is NOT resolved and no amount is guessed', async () => {
  const d = reported(); d.singles[89373] = 500;
  const r = await R(world(d));
  assert.equal(one(r, 89569).state, 'unresolved'); assert.equal(one(r, 84382).state, 'matched');
  assert.equal(r.accounting_coverage, 'unresolved'); assert.equal(r.listing_complete, true);
  assert.equal(r.totals.proven_paid, '328225.40'); assert.equal(r.totals.gap_summary_paid_minus_proven, '18100.00');
});

test('pure reconcile(): empty period is reported as nothing reconciled, not as complete', () => {
  const r = reconcile({ clientId: 48, from: '2026-10-01', to: '2026-11-06', invoices: [], listPayments: [], details: new Map() });
  assert.equal(r.accounting_coverage, 'unresolved'); assert.ok(r.warnings.some((x) => /nothing could be reconciled/.test(x)));
});

test('CLI: reconcile-payments is a read command, validates input and never sends a non-GET', async () => {
  const d = reported(); const w = world(d);
  const out = await run(['reconcile-payments', '48', '--from', '2026-10-01', '--to', '2026-11-06'], { env, fetcher: w.fetcher, sleep: noSleep });
  assert.equal(out.ok, true); assert.equal(out.official, false); assert.equal(out.totals.proven_paid, '346325.40');
  assert.ok(w.calls.every((c) => c.method === 'GET'));
  await assert.rejects(run(['reconcile-payments', '48'], { env, fetcher: w.fetcher, sleep: noSleep }), /Usage: reconcile-payments/);
  await assert.rejects(run(['reconcile-payments', '48', '--from', '2026-11-06', '--to', '2026-10-01'], { env, fetcher: w.fetcher, sleep: noSleep }), /from <= to|valid/);
  await assert.rejects(run(['reconcile-payments', '4x', '--from', '2026-10-01', '--to', '2026-11-06'], { env, fetcher: w.fetcher, sleep: noSleep }), /Invalid client id/);
});


test('fail closed if Daftra ignores the invoice client/date filters; never silently exclude out-of-scope rows', async () => {
  const good = inv(100, '100.00', '0.00');
  for (const bad of [
    inv(101, '10.00', '0.00', { client_id: 49 }),
    inv(102, '10.00', '0.00', { date: '2026-09-30' }),
    inv(103, '10.00', '0.00', { date: '2026-11-07' }),
    inv(104, '10.00', '0.00', { date: null }),
    inv(105, '10.00', '0.00', { client_id: null }),
  ]) {
    const w = world({ invoices: [good, bad], embedded: { 100: [] } });
    await assert.rejects(R(w), /Invoice list scope mismatch/);
    assert.equal(w.calls.filter((c) => /\/api2\/invoices\/\d+\.json/.test(c.path)).length, 0, 'reject before reading details');
    assert.ok(w.calls.every((c) => c.method === 'GET'));
  }
});

test('fail closed for invoice whose individual detail contradicts the list client/date', async () => {
  const i = inv(110, '10.00', '0.00');
  for (const wrong of [{ client_id: 49 }, { date: '2026-10-16' }]) {
    const w = world({ invoices: [i], embedded: { 110: [] }, detailHeader: { 110: wrong } });
    const r = await R(w);
    assert.equal(one(r, 110).state, 'unresolved');
    assert.match(one(r, 110).reasons.join(' '), /detail_unavailable.*scope mismatch/);
    assert.equal(r.accounting_coverage, 'unresolved');
    assert.ok(w.calls.every((c) => c.method === 'GET'));
  }
});

test('matching client and dates at period boundaries remain eligible', async () => {
  const invoices = [
    inv(120, '10.00', '0.00', { date: '2026-10-01' }),
    inv(121, '20.00', '0.00', { date: '2026-11-06' }),
  ];
  const r = await R(world({ invoices, embedded: { 120: [], 121: [] } }));
  assert.deepEqual(r.state_counts, { matched: 2, mismatch: 0, unresolved: 0 });
  assert.equal(r.accounting_coverage, 'complete');
});

// ---------------------------------------------------------------------------------------------------------------
// Evidence-driven fixes (client 48 live test): date formats, payment locations, identity-based merging, scope.

test('normalizeDaftraDate: strict ISO and DD/MM/YYYY only; everything else is rejected, never guessed', () => {
  assert.equal(normalizeDaftraDate('2026-10-05'), '2026-10-05');
  assert.equal(normalizeDaftraDate('05/10/2026'), '2026-10-05');
  assert.equal(normalizeDaftraDate('2026-10-05 13:20:00'), '2026-10-05');
  assert.equal(normalizeDaftraDate('05/10/2026 13:20'), '2026-10-05');
  assert.equal(normalizeDaftraDate(' 2026-10-05 '), '2026-10-05');
  for (const bad of ['5/10/2026', '10/05/26', '31/02/2026', '29/02/2026', '2026-13-01', '2026-02-30', '', '   ', '05-10-2026', '2026/10/05', '05.10.2026', null, undefined, 20261005, {}, 'tomorrow'])
    assert.equal(normalizeDaftraDate(bad), null, JSON.stringify(bad));
  assert.equal(normalizeDaftraDate('29/02/2028'), '2028-02-29');
});

test('DATES: list ISO vs detail DD/MM/YYYY (and the reverse) are the same day; the report shows ISO', async () => {
  const p = pay(10001, 100, '50.00');
  for (const [listDate, detailDate] of [['2026-10-05', '05/10/2026'], ['05/10/2026', '2026-10-05'], ['05/10/2026', '05/10/2026'], ['2026-10-05', '2026-10-05 08:00:00']]) {
    const r = await R(world({ invoices: [inv(100, '50.00', '50.00', { date: listDate })], list: [p], embedded: { 100: [p] }, detailHeader: { 100: { date: detailDate } } }));
    assert.equal(one(r, 100).state, 'matched', listDate + ' / ' + detailDate); assert.equal(one(r, 100).date, '2026-10-05');
  }
});

test('DATES: a different day, an MM/DD reading, or an invalid date in the detail is NOT guessed: invoice unresolved', async () => {
  const p = pay(10002, 101, '50.00');
  for (const [detailDate, rx] of [['10/05/2026', /differs from list date 2026-05-10|differs from list date/], ['06/10/2026', /differs from list date/], ['31/02/2026', /not a valid/], ['5/10/2026', /not a valid/], ['', /not a valid/], [undefined, /not a valid/]]) {
    const r = await R(world({ invoices: [inv(101, '50.00', '50.00', { date: '2026-10-05' }), inv(102, '10.00', '0.00', { date: '2026-10-06' })], list: [p], embedded: { 101: [p], 102: [] }, detailHeader: { 101: { date: detailDate } } }));
    assert.equal(one(r, 101).state, 'unresolved', String(detailDate)); assert.match(one(r, 101).reasons.join(' '), rx, String(detailDate));
    assert.equal(r.totals.proven_paid, '0.00', String(detailDate));            // its payment is not counted either
    assert.equal(one(r, 102).state, 'matched');                                // other invoices are unaffected
  }
});

test('SCOPE: list rows outside the requested client/date range, or with an unparseable date, abort the whole reconciliation', async () => {
  const p = pay(10003, 110, '5.00');
  for (const bad of [inv(110, '5.00', '5.00', { date: '2026-09-30' }), inv(110, '5.00', '5.00', { date: '2026-11-07' }), inv(110, '5.00', '5.00', { client_id: 49 }),
    inv(110, '5.00', '5.00', { client_id: null }), inv(110, '5.00', '5.00', { date: '13/13/2026' }), inv(110, '5.00', '5.00', { date: '' }), inv(110, '5.00', '5.00', { id: 'abc' })])
    await assert.rejects(R(world({ invoices: [bad], list: [p], embedded: { 110: [p] } })), /scope mismatch/, JSON.stringify(bad));
  // boundary dates are in scope, in either format
  for (const date of ['2026-10-01', '01/10/2026', '2026-11-06', '06/11/2026']) {
    const r = await R(world({ invoices: [inv(110, '5.00', '5.00', { date })], list: [p], embedded: { 110: [p] }, detailHeader: { 110: { date } } }));
    assert.equal(one(r, 110).state, 'matched', date);
  }
});

test('SCOPE: a detail whose client or date differs from the request/list makes that invoice unresolved', async () => {
  const a = pay(10004, 120, '5.00'); const b = pay(10005, 121, '6.00');
  const r = await R(world({ invoices: [inv(120, '5.00', '5.00'), inv(121, '6.00', '6.00')], list: [a, b], embedded: { 120: [a], 121: [b] }, detailHeader: { 120: { client_id: 99 } } }));
  assert.equal(one(r, 120).state, 'unresolved'); assert.match(one(r, 120).reasons.join(' '), /client differs from the request/);
  assert.equal(one(r, 121).state, 'matched');
});

test('PAYMENT LOCATIONS: data.Payment, data.InvoicePayment and data.Invoice.InvoicePayment are each read, with the path reported', async () => {
  const cases = [
    ['data.Payment', (id, p) => ({ embedded: { [id]: [p] } })],
    ['data.InvoicePayment', (id, p) => ({ embeddedAt: { InvoicePayment: { [id]: [p] } } })],
    ['data.Invoice.InvoicePayment', (id, p) => ({ embeddedAt: { 'Invoice.InvoicePayment': { [id]: [p] } } })],
  ];
  let n = 0;
  for (const [path, place] of cases) {
    const id = 130 + n; const p = pay(10100 + n++, id, '70.00');
    // wrapped elements ({ InvoicePayment: {...} }) are accepted as well
    const r = await R(world({ invoices: [inv(id, '70.00', '70.00')], list: [p], ...place(id, { InvoicePayment: p }) }));
    assert.equal(one(r, id).state, 'matched', path); assert.deepEqual(one(r, id).payments_paths, [path], path);
    assert.deepEqual(payment(r, p.id).sources, ['list', 'detail'], path);
  }
  assert.deepEqual(embeddedPayments({ data: {} }), { present: false, rows: [], paths: [] });
  assert.equal(embeddedPayments({ data: { Invoice: { InvoicePayment: 'x' }, Payment: {} } }).present, false);     // not arrays => not a payments section
});

test('PAYMENT LOCATIONS: no recognised section is UNRESOLVED with a clear reason, even when Daftra says nothing is owed or nothing was paid', async () => {
  const p = pay(10200, 140, '30.00');
  let r = await R(world({ invoices: [inv(140, '30.00', '30.00')], list: [p], embedded: {} }));
  assert.equal(one(r, 140).state, 'unresolved'); assert.match(one(r, 140).reasons.join(' '), /payments_section_not_found_in_detail \(checked data\.Payment, data\.InvoicePayment, data\.Invoice\.InvoicePayment\)/);
  r = await R(world({ invoices: [inv(141, '30.00', '0.00')], list: [], embedded: {} }));                         // nothing paid, but nothing proves it either
  assert.equal(one(r, 141).state, 'unresolved'); assert.equal(r.accounting_coverage, 'unresolved');
});

test('PAYMENT LOCATIONS: a payment only in data.Invoice.InvoicePayment is confirmed by the single GET and flagged as missing from the list', async () => {
  const p = pay(10300, 150, '90.00', { payment_method: 'client_credit' });
  const w = world({ invoices: [inv(150, '90.00', '90.00')], list: [], embeddedAt: { 'Invoice.InvoicePayment': { 150: [p] } }, singles: { 10300: p } });
  const r = await R(w);
  assert.deepEqual(singleGets(w), ['10300']); assert.equal(one(r, 150).state, 'matched'); assert.deepEqual(one(r, 150).missing_from_list, ['10300']);
  assert.equal(one(r, 150).credit_source_unverified, true); assert.deepEqual(payment(r, 10300).sources.sort(), ['detail', 'individual']);
});

test('NO DOUBLE COUNT: the same payment id in the list, in data.Payment and in data.Invoice.InvoicePayment is counted exactly once', async () => {
  const p = pay(10400, 160, '100.00');
  const r = await R(world({ invoices: [inv(160, '100.00', '100.00')], list: [p], embedded: { 160: [p] }, embeddedAt: { 'Invoice.InvoicePayment': { 160: [p] } } }));
  assert.equal(r.totals.proven_paid, '100.00'); assert.equal(one(r, 160).state, 'matched'); assert.deepEqual(one(r, 160).payments, ['10400']);
  assert.equal(r.payments.length, 1); assert.deepEqual(payment(r, 10400).sources, ['list', 'detail']);
  // if summary_paid were the DOUBLE amount, a sum-based match would accept it; identity-based matching must not
  const d = await R(world({ invoices: [inv(161, '200.00', '200.00')], list: [pay(10401, 161, '100.00')], embedded: { 161: [pay(10401, 161, '100.00')] } }));
  assert.equal(one(d, 161).state, 'mismatch'); assert.equal(one(d, 161).proven_paid, '100.00');
});

test('IDENTITY, NOT TOTALS: two different payment ids are two payments; a payment without an id is never matched by its amount', async () => {
  // list says id 1 (100), detail says id 2 (100): equal amounts, different identities => 200 proven vs 100 paid => mismatch
  const a = pay(10501, 170, '100.00'); const b = pay(10502, 170, '100.00');
  const w = world({ invoices: [inv(170, '100.00', '100.00')], list: [a], embedded: { 170: [b] }, singles: { 10501: a, 10502: b } });
  const r = await R(w);
  assert.equal(one(r, 170).state, 'mismatch'); assert.equal(one(r, 170).proven_paid, '200.00'); assert.deepEqual(one(r, 170).payments.sort(), ['10501', '10502']);
  // a detail payment with the right amount but no id cannot stand in for the missing listed one
  const noId = { invoice_id: 171, amount: '100.00', status: 1, payment_method: 'cash' };
  const q = await R(world({ invoices: [inv(171, '100.00', '100.00')], list: [], embedded: { 171: [noId] } }));
  assert.equal(one(q, 171).state, 'unresolved'); assert.equal(q.totals.proven_paid, '0.00'); assert.equal(q.unidentified_payments.length, 1);
});

test('INCOMPLETE PAYMENT DATA: amount, status or invoice link supplied by only one source needs the single GET; without it the payment is unresolved', async () => {
  const full = pay(10600, 180, '40.00');
  const stripped = (field) => { const c = { ...full }; delete c[field]; return c; };
  for (const field of ['amount', 'status', 'invoice_id']) {
    // list lacks the field, detail has it: one source only => confirmed by the single GET => matched
    let w = world({ invoices: [inv(180, '40.00', '40.00')], list: [stripped(field)], embedded: { 180: [full] }, singles: { 10600: full } });
    let r = await R(w);
    assert.deepEqual(singleGets(w), ['10600'], field); assert.equal(one(r, 180).state, 'matched', field);
    // ... and if the single GET is unavailable the money is NOT counted
    w = world({ invoices: [inv(180, '40.00', '40.00')], list: [stripped(field)], embedded: { 180: [full] }, singles: { 10600: 500 } });
    r = await R(w);
    assert.equal(one(r, 180).state, 'unresolved', field); assert.equal(r.totals.proven_paid, '0.00', field); assert.match(payment(r, 10600).reasons.join(' '), /individual_get_failed/, field);
  }
  // amount missing everywhere / unparseable
  let r = await R(world({ invoices: [inv(181, '40.00', '40.00')], list: [{ ...stripped('amount'), invoice_id: 181, id: 10601 }], embedded: { 181: [{ ...stripped('amount'), invoice_id: 181, id: 10601 }] }, singles: { 10601: { ...stripped('amount'), invoice_id: 181, id: 10601 } } }));
  assert.equal(one(r, 181).state, 'unresolved'); assert.match(payment(r, 10601).reasons.join(' '), /amount_missing/);
  r = await R(world({ invoices: [inv(182, '40.00', '40.00')], list: [pay(10602, 182, 'abc')], embedded: { 182: [pay(10602, 182, 'abc')] } }));
  assert.equal(one(r, 182).state, 'unresolved'); assert.match(payment(r, 10602).reasons.join(' '), /amount_invalid/);
  // an unparseable payment date is rejected, not ignored
  r = await R(world({ invoices: [inv(183, '40.00', '40.00')], list: [pay(10603, 183, '40.00', { date: '31/02/2026' })], embedded: { 183: [pay(10603, 183, '40.00', { date: '31/02/2026' })] } }));
  assert.equal(one(r, 183).state, 'unresolved'); assert.match(payment(r, 10603).reasons.join(' '), /date_invalid/);
  // payment dates in either format are accepted
  r = await R(world({ invoices: [inv(184, '40.00', '40.00')], list: [pay(10604, 184, '40.00', { date: '2026-10-20' })], embedded: { 184: [pay(10604, 184, '40.00', { date: '20/10/2026' })] } }));
  assert.equal(one(r, 184).state, 'matched'); assert.equal(payment(r, 10604).date, '2026-10-20');
});

test('REAL DIFFERENCE: Daftra says paid/unpaid 0 but there is no payment evidence => NOT matched; partial evidence => mismatch with the gap', async () => {
  let r = await R(world({ invoices: [inv(190, '100.00', '100.00')], list: [], embedded: { 190: [] } }));
  assert.equal(one(r, 190).state, 'mismatch'); assert.equal(one(r, 190).summary_unpaid, '0.00'); assert.equal(one(r, 190).evidence, null);
  assert.equal(r.accounting_coverage, 'unresolved'); assert.equal(r.totals.gap_summary_paid_minus_proven, '100.00');
  const p = pay(10700, 191, '60.00');
  r = await R(world({ invoices: [inv(191, '100.00', '100.00')], list: [p], embedded: { 191: [p] } }));
  assert.equal(one(r, 191).state, 'mismatch'); assert.match(one(r, 191).reasons.join(' '), /proven payments 60\.00 != summary_paid 100\.00/);
  assert.equal(r.totals.gap_summary_paid_minus_proven, '40.00');
  // a genuinely unpaid invoice is matched only on positive evidence: the section is there, empty, and the list has nothing for it
  r = await R(world({ invoices: [inv(192, '100.00', '0.00')], list: [], embedded: { 192: [] } }));
  assert.equal(one(r, 192).state, 'matched'); assert.equal(one(r, 192).evidence, 'no_payments_claimed_and_none_found');
  // matched invoices expose their evidence
  const q = pay(10701, 193, '10.00', { payment_method: 'client_credit' });
  r = await R(world({ invoices: [inv(193, '10.00', '10.00')], list: [q], embedded: { 193: [q] } }));
  assert.equal(one(r, 193).evidence, 'payments_verified_by_id'); assert.equal(one(r, 193).credit_source_unverified, true);
});

// ---------------------------------------------------------------------------------------------------------------
// Review round: duplicates INSIDE one source, payment_method reliability, one documentation of the payment paths.

const direct = ({ invoices, listPayments = [], details, individual = {} }) => reconcile({
  clientId: 48, from: '2026-10-01', to: '2026-11-06', invoices, listPayments,
  details: new Map(Object.entries(details)), individual: new Map(Object.entries(individual).map(([k, v]) => [k, normalizePayment(v, 'individual')])),
});
const detailOf = (invoice, rows, extra = {}) => ({ payload: { data: { Invoice: invoice, Payment: rows, ...extra } }, header: invoice });

test('SAME-SOURCE DUPLICATES (identical): a payment repeated inside the list, inside data.Payment or across detail paths counts once, with the repeat reported', () => {
  const i = inv(200, '100.00', '100.00'); const p = pay(11000, 200, '100.00');
  const r = direct({ invoices: [i], listPayments: [p, p], details: { 200: detailOf(i, [p, p], { InvoicePayment: [p] }) } });
  assert.equal(one(r, 200).state, 'matched'); assert.equal(r.totals.proven_paid, '100.00'); assert.equal(r.payments.length, 1);
  assert.deepEqual(one(r, 200).payments, ['11000']);
  assert.deepEqual(payment(r, 11000).sources, ['list', 'detail']);
  assert.match(payment(r, 11000).duplicate_in_source.join(' '), /list x2/); assert.match(payment(r, 11000).duplicate_in_source.join(' '), /detail\[data\.Payment,data\.InvoicePayment\] x3/);
  assert.ok(r.warnings.some((x) => /repeated inside one source with identical data and was counted once/.test(x)));
  // a repeat that doubles the amount can never make a double-paid summary match
  const d = direct({ invoices: [inv(201, '200.00', '200.00')], listPayments: [pay(11001, 201, '100.00'), pay(11001, 201, '100.00')], details: { 201: detailOf(inv(201, '200.00', '200.00'), [pay(11001, 201, '100.00'), pay(11001, 201, '100.00')]) } });
  assert.equal(one(d, 201).state, 'mismatch'); assert.equal(one(d, 201).proven_paid, '100.00');
});

test('SAME-SOURCE DUPLICATES (conflicting): any difference between repeats makes the payment UNRESOLVED and nothing is counted, even if the single GET agrees with one copy', () => {
  const i = inv(210, '100.00', '100.00'); const p = pay(11100, 210, '100.00', { date: '2026-10-20' });
  const variants = { amount: { amount: '110.00' }, status: { status: 0 }, invoice_id: { invoice_id: 211 }, method: { payment_method: 'cash' }, date: { date: '2026-10-21' } };
  for (const [field, change] of Object.entries(variants)) {
    for (const where of ['list', 'detail', 'detail-two-paths']) {
      const other = { ...p, ...change };
      const args = { invoices: [i, inv(211, '5.00', '0.00')], individual: { 11100: p } };
      if (where === 'list') args.listPayments = [p, other], args.details = { 210: detailOf(i, [p]), 211: detailOf(inv(211, '5.00', '0.00'), []) };
      if (where === 'detail') args.listPayments = [p], args.details = { 210: detailOf(i, [p, other]), 211: detailOf(inv(211, '5.00', '0.00'), []) };
      if (where === 'detail-two-paths') args.listPayments = [p], args.details = { 210: detailOf(i, [p], { InvoicePayment: [other] }), 211: detailOf(inv(211, '5.00', '0.00'), []) };
      const r = direct(args);
      const label = field + ' / ' + where;
      assert.equal(payment(r, 11100).state, 'unresolved', label);
      assert.ok(payment(r, 11100).conflicts.some((c) => c.field === field), label);
      assert.equal(one(r, 210).state, 'unresolved', label);
      assert.equal(r.totals.proven_paid, '0.00', label);                          // neither copy is counted
      assert.equal(r.accounting_coverage, 'unresolved', label);
    }
  }
});

test('SAME-SOURCE DUPLICATES through the orchestrator: conflicting repeats in the invoice detail stay unresolved; a duplicated LIST id is refused outright', async () => {
  const p = pay(11200, 220, '100.00');
  const w = world({ invoices: [inv(220, '100.00', '100.00')], list: [p], embedded: { 220: [p, { ...p, amount: '90.00' }] }, embeddedAt: { 'Invoice.InvoicePayment': { 220: [p] } }, singles: { 11200: p } });
  const r = await R(w);
  assert.equal(one(r, 220).state, 'unresolved'); assert.equal(r.totals.proven_paid, '0.00');
  assert.deepEqual(payment(r, 11200).conflicts.find((c) => c.field === 'amount').values.map((v) => v.value).sort(), ['100.00', '90.00']);
  await assert.rejects(R(world({ invoices: [inv(220, '100.00', '100.00')], list: [p, { ...p, amount: '90.00' }], embedded: { 220: [p] } })), /duplicate record id|blocked/i);
});

test('PAYMENT_METHOD: only client_credit and the documented cash/bank built-ins are classified; everything else is UNCLASSIFIED with a reason, never guessed', async () => {
  assert.deepEqual([...CASH_BANK_METHODS].sort(), ['bank', 'cash', 'cheque']);
  const cases = [
    ['client_credit', 'client_credit', null], ['CLIENT_CREDIT', 'client_credit', null], [' client_credit ', 'client_credit', null],
    ['cash', 'cash_bank', null], ['Bank', 'cash_bank', null], ['cheque', 'cash_bank', null],
    ['credit', 'unclassified', 'method_unrecognised:credit'], ['offline', 'unclassified', 'method_unrecognised:offline'],
    ['bank_transfer', 'unclassified', 'method_unrecognised:bank_transfer'], ['client credit', 'unclassified', 'method_unrecognised:client credit'],
    ['client-credit', 'unclassified', 'method_unrecognised:client-credit'], ['customer_credit', 'unclassified', 'method_unrecognised:customer_credit'],
    ['ائتمان العميل', 'unclassified', 'method_unrecognised:ائتمان العميل'], ['7', 'unclassified', 'method_unrecognised:7'],
    [null, 'unclassified', 'method_missing'], ['', 'unclassified', 'method_missing'],
  ];
  let n = 0;
  for (const [method, category, reason] of cases) {
    const id = 230 + n; const p = pay(11300 + n++, id, '10.00', { payment_method: method });
    const r = await R(world({ invoices: [inv(id, '10.00', '10.00')], list: [p], embedded: { [id]: [p] }, singles: { [p.id]: p } }));
    assert.equal(payment(r, p.id).category, category, JSON.stringify(method)); assert.equal(payment(r, p.id).classification_reason ?? null, reason, JSON.stringify(method));
    assert.equal(one(r, id).state, 'matched', JSON.stringify(method));                      // the money is still proven by id/amount/status
    assert.equal(one(r, id).classification_complete, category !== 'unclassified', JSON.stringify(method));
    assert.equal(r.classification_complete, category !== 'unclassified', JSON.stringify(method));
    const bucket = { client_credit: 'proven_client_credit', cash_bank: 'proven_cash_bank', unclassified: 'proven_unclassified' }[category];
    assert.equal(r.totals[bucket], '10.00', JSON.stringify(method));
    if (category === 'unclassified') assert.ok(r.warnings.some((x) => /NOT guessed/.test(x)), JSON.stringify(method));
  }
});

test('PAYMENT_METHOD: a method that only ONE source supplies is corroborated by the single GET; if that cannot be done the payment stays counted but UNCLASSIFIED', async () => {
  const credit = pay(11400, 240, '50.00', { payment_method: 'client_credit' });
  const noMethod = { ...credit }; delete noMethod.payment_method;
  // list says client_credit, detail has no method => single GET confirms => classified
  let w = world({ invoices: [inv(240, '50.00', '50.00')], list: [credit], embedded: { 240: [noMethod] }, singles: { 11400: credit } });
  let r = await R(w);
  assert.deepEqual(singleGets(w), ['11400']); assert.equal(payment(r, 11400).category, 'client_credit'); assert.equal(one(r, 240).credit_source_unverified, true);
  // single GET unavailable: amount/status/invoice are two-source proven, so the money counts, but the method is NOT trusted
  w = world({ invoices: [inv(240, '50.00', '50.00')], list: [credit], embedded: { 240: [noMethod] }, singles: { 11400: 500 } });
  r = await R(w);
  assert.equal(payment(r, 11400).state, 'verified'); assert.equal(payment(r, 11400).category, 'unclassified'); assert.equal(payment(r, 11400).classification_reason, 'method_single_source');
  assert.equal(one(r, 240).state, 'matched'); assert.equal(one(r, 240).classification_complete, false); assert.equal(r.totals.proven_unclassified, '50.00');
  assert.equal(one(r, 240).credit_source_unverified, true);               // a source CLAIMS credit: surfaced, never hidden by the missing corroboration
  // single GET disagrees with the claimed method => conflict => unresolved
  w = world({ invoices: [inv(240, '50.00', '50.00')], list: [credit], embedded: { 240: [noMethod] }, singles: { 11400: { ...credit, payment_method: 'cash' } } });
  r = await R(w);
  assert.equal(payment(r, 11400).state, 'unresolved'); assert.ok(payment(r, 11400).conflicts.some((c) => c.field === 'method'));
});

test('PAYMENT_METHOD: methods that disagree between sources are a conflict: unresolved, no category', async () => {
  const a = pay(11500, 250, '20.00', { payment_method: 'cash' }); const b = { ...a, payment_method: 'client_credit' };
  const r = await R(world({ invoices: [inv(250, '20.00', '20.00')], list: [a], embedded: { 250: [b] }, singles: { 11500: a } }));
  assert.equal(payment(r, 11500).state, 'unresolved'); assert.equal(payment(r, 11500).category, 'unclassified'); assert.equal(payment(r, 11500).classification_reason, 'method_conflict');
  assert.equal(one(r, 250).state, 'unresolved'); assert.equal(r.totals.proven_cash_bank, '0.00'); assert.equal(r.totals.proven_client_credit, '0.00');
});

test('DOCS: SKILL.md and the integration contract list exactly the three payment paths the code reads', async () => {
  assert.deepEqual([...EMBEDDED_PATHS], ['data.Payment', 'data.InvoicePayment', 'data.Invoice.InvoicePayment']);
  const docs = { skill: await readFile(new URL('../SKILL.md', import.meta.url), 'utf8'), contract: await readFile(new URL('../../../docs/DAFTRA_INTEGRATION_CONTRACT.md', import.meta.url), 'utf8') };
  for (const [name, text] of Object.entries(docs)) {
    for (const path of EMBEDDED_PATHS) assert.ok(text.includes('`' + path + '`'), name + ' documents ' + path);
    const mentioned = new Set(text.match(/data\.(?:Invoice\.)?(?:InvoicePayment|Payment)\b/g) ?? []);
    for (const m of mentioned) assert.ok(EMBEDDED_PATHS.includes(m), name + ' mentions an undocumented path ' + m);
  }
});
