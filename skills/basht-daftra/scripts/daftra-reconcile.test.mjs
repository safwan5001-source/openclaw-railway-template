// Invoice <-> payment reconciliation. All data is SYNTHETIC; the fetcher is GET-only and records every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileClientPayments, reconcile, normalizePayment } from './daftra-reconcile.mjs';
import { run } from './daftra-cli.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'dummy' };
const noSleep = async () => {};
const R = (o) => reconcileClientPayments({ clientId: 48, from: '2026-10-01', to: '2026-11-06' }, env, o.fetcher, { sleep: noSleep });

const inv = (id, total, paid, extra = {}) => ({ id, no: String(id), date: '2026-10-15', client_id: 48, type: 0, draft: 0, summary_total: total, summary_paid: paid, summary_unpaid: (Number(total) - Number(paid)).toFixed(2), ...extra });
const pay = (id, invoice_id, amount, extra = {}) => ({ id, invoice_id, amount, status: 1, payment_method: 'bank_transfer', date: '2026-10-20', client_id: 48, ...extra });

// world({ invoices, list, embedded: {invoiceId: [payments] | undefined}, singles: {paymentId: record | number(HTTP status)}, ... })
function world({ invoices, list = [], embedded = {}, singles = {}, detailHeader = {}, detailFail = {}, listFail = null, listTotalOverride = null, invoiceListFail = null, pageSize }) {
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
  assert.ok(r.warnings.some((x) => /more than once in one source/.test(x)));
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
  assert.equal(one(r, 70).unclassified, '25.00'); assert.equal(r.totals.proven_unclassified, '25.00'); assert.ok(r.warnings.some((x) => /no payment_method/.test(x)));
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
  for (let i = 0; i < 16; i++) add(90000 + i, '0075' + String(i).padStart(2, '0'), '18000.00', pay(95000 + i, 90000 + i, '18000.00', { payment_method: i % 2 ? 'bank_transfer' : 'cash' }));
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
