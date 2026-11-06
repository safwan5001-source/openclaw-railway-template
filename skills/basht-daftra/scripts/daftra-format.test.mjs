import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown, renderCliResult, formatFailure, formatNumber, toUnits, documentStatus, paymentStatus, clean } from './daftra-format.mjs';
import { run, renderOptions } from './daftra-cli.mjs';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';

const TODAY = '2026-11-05';
const LRI = '\u2066'; const PDI = '\u2069'; const RLM = '\u200f';
const BIDI = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const inv = (o = {}) => ({ id: 1, no: '007472', date: '2026-05-01', client_id: 48, client_business_name: 'شركة نبراس', currency_code: 'SAR', draft: 0,
  summary_total: '18100', summary_paid: '18100', summary_unpaid: '0', ...o });
const list = (entity, records, extra = {}) => ({ ok: true, entity, complete: true, count: records.length, total: records.length, records, ...extra });
const ar = (entity, records, extra, opts = {}) => renderMarkdown('list', entity, list(entity, records, extra), { lang: 'ar', today: TODAY, ...opts });
const en = (entity, records, extra, opts = {}) => renderMarkdown('list', entity, list(entity, records, extra), { lang: 'en', today: TODAY, ...opts });
const noJson = (md) => assert.ok(!/[{}]\s*"|"\s*:\s*[{"\[\d]|^\s*[\[{]/m.test(md), 'no raw JSON in: ' + md);

test('numbers: thousands separators, exactly 2 decimals, half-up, negatives, no floating point', () => {
  assert.equal(formatNumber(toUnits('18100')), '18,100.00');
  assert.equal(formatNumber(toUnits(1234567.5)), '1,234,567.50');
  assert.equal(formatNumber(toUnits('0.005')), '0.01');
  assert.equal(formatNumber(toUnits('-1234.5')), '-1,234.50');
  assert.equal(formatNumber(toUnits('999999999999.99')), '999,999,999,999.99');
  assert.equal(formatNumber(toUnits('0.1')), '0.10');
  for (const bad of [null, undefined, '', 'abc', '1e5', '1,5', NaN, {}, '9'.repeat(14), true]) assert.equal(toUnits(bad), null, String(bad));
  assert.equal(formatNumber(null), '—');
});

test('currency: shown from the record (Arabic label in RTL, code in LTR), missing currency is stated, never assumed', () => {
  const a = ar('invoices', [inv()]); const e = en('invoices', [inv()]);
  assert.match(a, new RegExp(LRI + '18,100\\.00 ر\\.س' + PDI));
  assert.match(e, /18,100\.00 SAR/);
  const noCur = ar('invoices', [inv({ currency_code: undefined })]);
  assert.match(noCur, /العملة غير محددة/);
  assert.ok(!/SAR|ر\.س/.test(noCur));
  assert.match(en('invoices', [inv({ currency_code: undefined })]), /currency not specified/);
});

test('totals are exact, per currency, and never mix currencies; unconfirmed amounts are excluded and counted', () => {
  const md = en('invoices', [
    inv({ id: 1, summary_total: '100.10', summary_paid: '0', summary_unpaid: '100.10' }),
    inv({ id: 2, no: '2', summary_total: '200.20', summary_paid: '0', summary_unpaid: '200.20' }),
    inv({ id: 3, no: '3', currency_code: 'AED', summary_total: '50', summary_paid: '50', summary_unpaid: '0' }),
    inv({ id: 4, no: '4', summary_total: null }),
  ]);
  assert.match(md, /Total 300\.30 SAR · Paid 0\.00 SAR · Outstanding 300\.30 SAR/);
  assert.match(md, /Total 50\.00 AED/);
  assert.ok(!/350\.30/.test(md));
  assert.match(md, /1 records without a confirmed amount excluded/);
});

test('statuses come only from confirmed fields: draft, issued, paid, partial, overdue, cancelled, unconfirmed', () => {
  const st = (o) => documentStatus(inv(o), { today: TODAY });
  assert.equal(st({ draft: 1 }), 'draft');
  assert.equal(st({}), 'paid');
  assert.equal(st({ summary_paid: '0', summary_unpaid: '18100' }), 'issued');
  assert.equal(st({ summary_paid: '100', summary_unpaid: '18000' }), 'partial');
  assert.equal(st({ summary_paid: '0', summary_unpaid: '18100', due_date: '2026-10-01' }), 'overdue');
  assert.equal(st({ summary_paid: '100', summary_unpaid: '18000', due_date: '05/10/2026' }), 'overdue');
  assert.equal(st({ summary_paid: '0', summary_unpaid: '18100', due_date: '2026-12-01' }), 'issued');
  assert.equal(st({ due_date: '2020-01-01' }), 'paid');                         // a paid invoice is never overdue
  assert.equal(st({ status: 'Cancelled' }), 'cancelled');
  // not provable -> never guessed
  assert.equal(st({ draft: undefined, summary_paid: '0', summary_unpaid: '18100' }), 'unknown');   // may be a draft
  assert.equal(st({ summary_unpaid: '5' }), 'unknown');                                           // total - paid != unpaid
  assert.equal(st({ summary_total: undefined }), 'unknown');
  assert.equal(st({ summary_total: '0', summary_paid: '0', summary_unpaid: '0' }), 'unknown');
  assert.equal(st({ summary_paid: '0', summary_unpaid: '18100', due_date: 'soon' }), 'issued');  // unparseable due date is ignored
  assert.equal(paymentStatus({ status: 1 }), 'done');
  assert.equal(paymentStatus({ status: '0' }), 'failedPay');
  assert.equal(paymentStatus({}), 'unknown');
  assert.equal(paymentStatus({ status: 7 }), 'unknown');
});

test('status badges and a legend appear in the table, in both languages', () => {
  const recs = [inv({ id: 1, draft: 1 }), inv({ id: 2, no: '2' }), inv({ id: 3, no: '3', summary_paid: '10', summary_unpaid: '18090' }),
    inv({ id: 4, no: '4', summary_paid: '0', summary_unpaid: '18100', due_date: '2026-01-01' }), inv({ id: 5, no: '5', status: 'cancelled' }), inv({ id: 6, no: '6', summary_total: undefined })];
  const a = ar('invoices', recs);
  for (const w of ['مسودة', 'مدفوعة', 'مدفوعة جزئيًا', 'متأخرة', 'ملغاة', 'غير مؤكدة']) assert.ok(a.includes(w), w);
  const e = en('invoices', recs);
  for (const w of ['Draft', 'Paid', 'Partially paid', 'Overdue', 'Cancelled', 'Unconfirmed']) assert.ok(e.includes(w), w);
  assert.ok(!/Issued/.test(e), 'issued is not claimed when no record proves it');
});

test('RTL: Arabic lines start with RLM and numbers/ids/dates/currency are isolated LTR; LTR output has no bidi marks at all', () => {
  const a = ar('invoices', [inv()]);
  const textLines = a.split('\n').filter((l) => l && !l.startsWith('|'));
  assert.ok(textLines.length >= 3);
  for (const l of textLines) assert.ok(l.startsWith(RLM), 'RTL line: ' + l);
  const row = a.split('\n').find((l) => l.includes('007472'));
  assert.ok(row.includes(LRI + '007472' + PDI) && row.includes(LRI + '2026-05-01' + PDI) && row.includes(LRI + '18,100.00 ر.س' + PDI));
  assert.ok(!BIDI.test(en('invoices', [inv({ client_business_name: 'Nebras Co.' })])), 'English output carries no direction marks');
});

test('iPhone width: at most 4 narrow columns, long names are truncated, the table row count is capped with a pointer to the rest', () => {
  const recs = Array.from({ length: 40 }, (_, i) => inv({ id: i + 1, no: String(i + 1), client_business_name: 'شركة ' + 'طويلة'.repeat(20) }));
  const md = ar('invoices', recs);
  const rows = md.split('\n').filter((l) => l.startsWith('|'));
  assert.equal(rows.length, 2 + 10);                                             // header + separator + 10
  for (const r of rows) assert.ok(r.split(' | ').length <= 4, r);
  assert.ok(rows.every((r) => r.length < 120), 'rows stay short');
  assert.match(md, /10.*40.*التفاصيل/);
  assert.match(md, /الإجمالي/);                                                  // totals cover all 40, not just the 10 shown
  const detail = ar('invoices', recs, undefined, { view: 'detail' });
  assert.equal(detail.split('\n').filter((l) => l.startsWith('|')).length, 2 + 25);
  assert.equal(ar('invoices', recs.slice(0, 3)).split('\n').filter((l) => l.startsWith('|')).length, 2 + 3);
  assert.ok(!/…\s*\|.*…/.test(clean('x')), 'sanity');
  assert.ok(clean('x'.repeat(200), 10).endsWith('…') && [...clean('x'.repeat(200), 10)].length === 10);
});

test('an incomplete page is labelled a sample, totals say so, and nothing claims a full report', () => {
  const md = en('invoices', [inv(), inv({ id: 2, no: '2' })], { complete: false, total: 87 });
  assert.match(md, /2 of 87 \(sample\)/);
  assert.match(md, /One page only, not all records/);
  assert.match(md, /Totals cover the displayed sample only/);
  assert.match(ar('invoices', [inv()], { complete: false, total: 9 }), /عيّنة/);
  assert.ok(!/عيّنة|sample/.test(en('invoices', [inv()])));
});

test('missing data renders a dash, never an invented value; empty list says so', () => {
  const md = en('invoices', [{ id: 9 }]);
  assert.match(md, /\| 9 · — \| — \| — \| ❔ \|/);
  assert.match(md, /Unconfirmed/);
  assert.match(en('invoices', []), /No matching records\./);
  assert.match(ar('clients', []), /لا توجد سجلات مطابقة/);
  const withId = en('invoices', [inv({ client_business_name: undefined, client_id: 48 })]);
  assert.match(withId, /Client #48/);                                            // only the id Daftra gave us
  const card = renderMarkdown('get', 'invoices', { ok: true, record: { id: 5 } }, { lang: 'en', today: TODAY });
  assert.match(card, /Invoice 5/); assert.match(card, /Status: ❔ Unconfirmed/); assert.match(card, /Total: —/);
});

test('single invoice card: title, number, party, date, status, amounts; detail adds notes and items', () => {
  const rec = inv({ summary_paid: '4000.5', summary_unpaid: '14099.5', due_date: '2026-12-01', notes: 'ملاحظة', InvoiceItem: [{ item: 'Diesel', quantity: '1000', unit_price: '1.89' }] });
  const s = renderMarkdown('get', 'invoices', { ok: true, record: rec }, { lang: 'ar', today: TODAY });
  assert.match(s, /فاتورة/); assert.match(s, /007472/); assert.match(s, /شركة نبراس/); assert.match(s, /مدفوعة جزئيًا/);
  assert.match(s, /4,000\.50/); assert.match(s, /14,099\.50/);
  assert.ok(!s.includes('ملاحظة') && !s.includes('Diesel'), 'summary stays short');
  const d = renderMarkdown('get', 'invoices', { ok: true, record: rec }, { lang: 'ar', view: 'detail', today: TODAY });
  assert.ok(d.includes('ملاحظة') && d.includes('Diesel') && d.includes('1.89'));
  noJson(s); noJson(d);
});

test('every supported entity renders without JSON and without throwing, in both languages', () => {
  const samples = {
    invoices: inv(), estimates: inv(), credit_notes: inv(), purchase_invoices: inv({ supplier_id: 7, client_id: undefined, client_business_name: undefined, supplier_business_name: 'مورد' }),
    invoice_payments: { id: 3, no: '3', date: '2026-05-02', client_id: 48, invoice_id: 1, amount: '115', status: 1, payment_method: 'cash', currency_code: 'SAR' },
    client_payments: { id: 4, date: '2026-05-02', client_id: 48, amount: '500', status: 0, currency_code: 'SAR' },
    expenses: { id: 5, expense_number: 'E-5', date: '2026-05-03', amount: '88.5', description: 'وقود', currency_code: 'SAR' }, incomes: { id: 6, date: '2026-05-03', amount: '10', note: 'x' },
    clients: { id: 48, business_name: 'شركة نبراس', phone1: '0555555555', email: 'a@b.sa', country_code: 'SA' }, suppliers: { id: 7, business_name: 'مورد', email: 'm@b.sa' },
    products: { id: 9, name: 'Diesel 10L', product_code: 'D10', unit_price: '18.9', barcode: '6291041500213' },
    taxes: { id: 1, name: 'VAT', value: 15, is_active: 1 }, treasuries: { id: 2, name: 'البنك الأهلي', type: 1, balance: '1250.75', currency_code: 'SAR' },
    journals: { id: 8, title: 'قيد' },
  };
  for (const [entity, rec] of Object.entries(samples)) for (const lang of ['ar', 'en']) {
    const l = renderMarkdown('list', entity, list(entity, [rec, rec]), { lang, today: TODAY });
    const g = renderMarkdown('get', entity, { ok: true, record: rec }, { lang, view: 'detail', today: TODAY });
    for (const md of [l, g]) { assert.ok(md.length > 20, entity); noJson(md); }
  }
  assert.match(renderMarkdown('list', 'invoice_payments', list('invoice_payments', [samples.client_payments]), { lang: 'en' }), /⚫ Cancelled\/failed/);
  assert.match(renderMarkdown('list', 'treasuries', list('treasuries', [samples.treasuries]), { lang: 'en' }), /Bank account/);
  assert.match(renderMarkdown('list', 'taxes', list('taxes', [samples.taxes]), { lang: 'en' }), /15%/);
});

test('statement: summary first, last rows only, unofficial label; an unreconciled balance is never quoted', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ date: '2026-05-' + String(i % 28 + 1).padStart(2, '0'), kind: i % 2 ? 'invoice_payment' : 'invoice', reference: String(100 + i), debit: '10.00', credit: '0.00', balance: String((i + 1) * 10) + '.00' }));
  const st = { ok: true, client_id: '48', from: '2026-05-01', to: '2026-05-31', official: false, rows, totals: { debit: '300.00', credit: '0.00', balance: '1234.50', open_invoices_unpaid: '300.00' }, reconciles: true, warnings: ['w'] };
  const a = renderMarkdown('statement', '48', st, { lang: 'ar' });
  assert.match(a, /كشف حساب العميل/); assert.match(a, /غير رسمي/); assert.match(a, /1,234\.50/); assert.match(a, /آخر/);
  assert.equal(a.split('\n').filter((l) => l.startsWith('|')).length, 2 + 10);
  const bad = renderMarkdown('statement', '48', { ...st, reconciles: false }, { lang: 'en' });
  assert.match(bad, /do not rely on it/); assert.ok(!bad.includes('1,234.50'));
  assert.match(renderMarkdown('statement', '48', { ...st, rows: [] }, { lang: 'en' }), /No matching records/);
});

test('reports: scalars and the first rows table, money-like columns formatted, currency stated as unknown, never raw JSON', () => {
  const payload = { total_amount: '12345.6', period: '2026-05', rows: [{ client: 'نبراس', total: '1000', count: '3', extra: 'x' }, { client: 'ب', total: '2.5', count: '1' }] };
  const md = renderMarkdown('report', 'revenue', { ok: true, report: 'revenue', complete: true, official: false, payload }, { lang: 'en' });
  assert.match(md, /total\\_amount: 12,345\.60/); assert.match(md, /\| 1,000\.00 \|/); assert.match(md, /currency not specified/); assert.match(md, /Only the first columns/);
  noJson(md);
  assert.match(renderMarkdown('report', 'x', { ok: true, complete: false, payload: {} }, { lang: 'en' }), /One page only/);
});

test('failures: forbidden is the only permission message; report_not_exposed, validation and unknown are explained; available vs unavailable is explicit', () => {
  const f = formatFailure({ ok: false, error: 'x', category: 'forbidden', status: 403 }, { lang: 'ar', available: ['العملاء'], unavailable: ['الفواتير'] });
  assert.match(f, /الصلاحية غير كافية/); assert.match(f, /403/); assert.match(f, /المتاح: العملاء/); assert.match(f, /المتعذّر: الفواتير/);
  const r = formatFailure({ ok: false, category: 'report_not_exposed', status: 404 }, { lang: 'en' });
  assert.match(r, /not a permission issue/); assert.ok(!/role must allow/.test(r));
  assert.match(formatFailure({ ok: false, category: 'validation', status: 400, validation_errors: 'date_from=bad' }, { lang: 'en' }), /date\\_from=bad/);
  assert.match(formatFailure({ ok: false, error: 'Export blocked: partial' }, { lang: 'en' }), /Export blocked: partial/);
  assert.match(formatFailure({ ok: false, category: 'transient', status: 503 }, { lang: 'ar' }), /غير متاحة مؤقتًا/);
  assert.match(renderMarkdown('list', 'invoices', { ok: false, category: 'upstream_error', status: 500 }, { lang: 'en' }), /Request failed/);
  const secret = formatFailure({ ok: false, error: 'boom', hint: 'API KEY k-secret', owner_action: 'token abc' }, { lang: 'en' });
  assert.ok(!/k-secret|token abc/.test(secret), 'internal hints are not echoed');
});

test('Daftra text is untrusted: control/bidi chars are removed and markdown/table/link syntax is neutralised', () => {
  const evil = inv({ client_business_name: 'A | B\n| fake | row |\u202e ![x](http://evil.test/p.png) [pay](http://evil.test) <b>x</b> `c`' });
  const md = ar('invoices', [evil]);
  assert.ok(!md.includes('\u202e'));
  const rows = md.split('\n').filter((l) => l.startsWith('|'));
  assert.equal(rows.length, 3, 'a name cannot add table rows');
  assert.ok(!/(^|[^\\])\[|(^|[^\\])\]\(|<b>|(^|[^\\])!\[/.test(rows[2].replace(/\\./g, '')), 'no live link/image/html: ' + rows[2]);
  assert.ok(!rows[2].replace(/\\\|/g, '').slice(2, -2).includes('|') || rows[2].replace(/\\\|/g, '').split('|').length === 6);
});

test('input validation: unknown language/view/command is rejected', () => {
  assert.throws(() => renderMarkdown('list', 'invoices', list('invoices', []), { lang: 'fr' }), /lang/);
  assert.throws(() => renderMarkdown('list', 'invoices', list('invoices', []), { view: 'x' }), /view/);
  assert.throws(() => renderMarkdown('propose', 'x', { ok: true }, {}), /supports list/);
});

// ---- CLI integration: fetching is unchanged, --render only formats ---------------------------------------------------------
async function cli(args, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-fmt-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k-secret' };
  const fake = new FakeDaftra(seed);
  try { return { out: await run(args, { env, fetcher: fake.fetch, sleep: async () => {} }), fake }; } finally { await rm(dir, { recursive: true, force: true }); }
}
test('CLI --render ar: same GET requests, Markdown out, no JSON, no secrets', async () => {
  const lists = { invoices: [inv({ id: 1 }), inv({ id: 2, no: '2', summary_paid: '0', summary_unpaid: '18100', client_business_name: 'Acme' })] };
  const plain = await cli(['list', 'invoices', '--all'], { lists });
  const rendered = await cli(['list', 'invoices', '--all', '--render', 'ar'], { lists });
  assert.deepEqual(rendered.fake.calls.map((c) => c.method + c.path + c.search), plain.fake.calls.map((c) => c.method + c.path + c.search));
  assert.equal(rendered.fake.posts.length, 0);
  assert.equal(rendered.out.ok, true); assert.equal(rendered.out.complete, true);
  assert.match(rendered.out.markdown, /الفواتير/); assert.match(rendered.out.markdown, /007472/);
  assert.ok(!rendered.out.markdown.includes('k-secret') && !('records' in rendered.out));
  const one = await cli(['get', 'invoices', '3', '--render', 'en', '--view', 'detail']);
  assert.match(one.out.markdown, /Invoice 3/);
  const page = await cli(['list', 'invoices', '--render', 'en'], { lists });
  assert.equal(page.out.complete, true);
});
test('CLI --render is read-only: writes, approvals and other commands refuse it; bad values are rejected', async () => {
  for (const args of [['propose', 'expense', '--render', 'ar'], ['execute', 'x', '--render', 'ar'], ['capabilities', '--render', 'ar'], ['pdf', '3', '--render', 'ar']])
    assert.throws(() => renderOptions(args), /supports only/, args.join(' '));
  assert.throws(() => renderOptions(['list', 'invoices', '--render', 'fr']), /--render must be/);
  assert.throws(() => renderOptions(['list', 'invoices', '--render', 'ar', '--view', 'zzz']), /--view/);
  assert.throws(() => renderOptions(['list', 'invoices', '--view', 'detail']), /--render must be/);
  assert.equal(renderOptions(['list', 'invoices']), null);
  const r = renderCliResult('list', 'invoices', list('invoices', [], { complete: false }), { lang: 'en' });
  assert.equal(r.complete, false);
});

test('drafts and cancelled documents are counted but never added to money totals', () => {
  const md = en('invoices', [inv({ summary_total: '100', summary_paid: '0', summary_unpaid: '100' }),
    inv({ id: 2, no: '2', draft: 1, summary_total: '900', summary_paid: '0', summary_unpaid: '900' }), inv({ id: 3, no: '3', status: 'cancelled', summary_total: '700', summary_paid: '0', summary_unpaid: '700' })]);
  assert.match(md, /Total 100\.00 SAR/); assert.ok(!/1,000|1,700|900\.00 SAR ·/.test(md.split('\n').find((l) => l.startsWith('**Total'))));
  assert.match(md, /2 drafts\/cancelled excluded from totals/);
});
