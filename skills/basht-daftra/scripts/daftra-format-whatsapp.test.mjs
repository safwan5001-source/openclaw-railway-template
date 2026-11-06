import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderWhatsApp, renderWhatsAppCliResult, formatWhatsAppFailure, WA_ROWS, WA_MAX_CHARS } from './daftra-format-whatsapp.mjs';
import { renderMarkdown } from './daftra-format.mjs';
import { run, renderOptions } from './daftra-cli.mjs';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';

const TODAY = '2026-11-05';
const RLM = '‏'; const LRI = '⁦'; const PDI = '⁩';
const inv = (o = {}) => ({ id: 1, no: '007472', date: '2026-05-01', client_id: 48, client_business_name: 'شركة نبراس', currency_code: 'SAR', draft: 0,
  summary_total: '18100', summary_paid: '18100', summary_unpaid: '0', ...o });
const list = (entity, records, extra = {}) => ({ ok: true, entity, complete: true, count: records.length, total: records.length, records, ...extra });
const wa = (entity, records, extra, opts = {}) => renderWhatsApp('list', entity, list(entity, records, extra), { lang: 'ar', today: TODAY, wire: 'native', ...opts });
const many = (n, o = {}) => Array.from({ length: n }, (_, i) => inv({ id: i + 1, no: 'INV-' + (i + 1), date: '2026-05-' + String(i + 1).padStart(2, '0'), ...o }));
const noJson = (s) => assert.ok(!/[{}]\s*"|"\s*:\s*[{"\[\d]|^\s*[\[{]/m.test(s), 'no raw JSON in: ' + s);
const lines = (s) => s.split('\n');

test('WhatsApp style: *bold* in the recipient view, **bold** for the OpenClaw reply path, no Markdown tables / headings / fences', () => {
  for (const lang of ['ar', 'en']) {
    const r = renderWhatsAppCliResult('list', 'invoices', list('invoices', many(7)), { lang, today: TODAY });
    assert.ok(r.markdown.includes('**') && !/(^|[^*])\*(?!\*)/m.test(r.markdown.replace(/\*\*/g, '')), 'gateway text only uses **');
    assert.ok(/(^|\s)\*[^*\s][^*\n]*\*/.test(r.preview) && !r.preview.includes('**'), 'preview uses single *: ' + r.preview);
    assert.equal(r.markdown.replace(/\*\*(.+?)\*\*/g, '*$1*'), r.preview, 'preview is exactly what OpenClaw makes of markdown');
    for (const s of [r.markdown, r.preview]) {
      assert.ok(!/^\s*\|/m.test(s) && !/\|\s*---/.test(s) && !/^\s*#{1,6}\s/m.test(s) && !s.includes('```') && !/\b_[^_\s][^_]*_\b/.test(s), s);
      noJson(s);
    }
  }
});

test('bold is always preceded by whitespace (WhatsApp rule) and no line starts with a marker, so RTL direction marks never glue to one', () => {
  for (const lang of ['ar', 'en']) for (const wire of ['native', 'gateway']) {
    const s = renderWhatsApp('list', 'invoices', list('invoices', many(6)), { lang, today: TODAY, wire, view: 'detail' });
    for (const l of lines(s)) {
      const body = l.replace(RLM, '');
      assert.ok(!/^[*_~`#>\-+]/.test(body) && !/^\d+[.)]/.test(body), 'line must not start with a marker: ' + l);
    }
    assert.ok(!s.replace(/\*+[^*\n]+\*+/g, 'B').includes('*'), 'every * belongs to a bold pair');
    for (const m of s.matchAll(/\*+(?=[^*\s])/g)) assert.ok(m.index === 0 || /\s/.test(s[m.index - 1]), 'opening marker preceded by space: ' + JSON.stringify(s.slice(Math.max(0, m.index - 3), m.index + 5)));
  }
});

test('default view = last 5 records, newest first; detail = 15 on request; the "more" hint appears only when rows were left out', () => {
  assert.equal(WA_ROWS.summary, 5); assert.equal(WA_ROWS.detail, 15);
  const shuffled = many(12).sort((a, b) => (a.id * 7) % 12 - (b.id * 7) % 12);
  const s = wa('invoices', shuffled);
  const refs = [...s.matchAll(/INV-(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(refs, [12, 11, 10, 9, 8], 'the 5 newest by date, newest first');
  assert.match(s, /آخر ⁦5⁩ من ⁦12⁩/); assert.match(s, /اطلب «التفاصيل»/);
  const d = wa('invoices', shuffled, undefined, { view: 'detail' });
  assert.equal([...d.matchAll(/INV-\d+/g)].length, 12, 'all 12 fit in the 15-row detail view'); assert.ok(!/اطلب «التفاصيل»/.test(d));
  assert.equal([...wa('invoices', many(30), undefined, { view: 'detail' }).matchAll(/INV-\d+/g)].length, 15);
  assert.match(wa('invoices', many(3)), /الفواتير\* — ⁦3⁩$/m);
  assert.match(wa('invoices', [], undefined), /لا توجد سجلات/);
});

test('every document shows total, paid, outstanding and status clearly (Arabic and English, exact 2-decimal numbers)', () => {
  const rec = inv({ summary_total: '1234567.5', summary_paid: '234567.25', summary_unpaid: '1000000.25' });
  const a = wa('invoices', [rec]);
  assert.ok(a.includes('الإجمالي: ' + LRI + '1,234,567.50 ر.س' + PDI), a);
  assert.ok(a.includes('المدفوع: ' + LRI + '234,567.25 ر.س' + PDI) && a.includes('المتبقي: ' + LRI + '1,000,000.25 ر.س' + PDI));
  assert.match(a, /🟡 \*007472\* · مدفوعة جزئيًا/);
  const e = wa('invoices', [rec], undefined, { lang: 'en' });
  assert.match(e, /Total: 1,234,567\.50 SAR/); assert.match(e, /Paid: 234,567\.25 SAR · ⏳ Outstanding: 1,000,000\.25 SAR/); assert.match(e, /🟡 \*007472\* · Partially paid/);
  assert.match(e, /\*Total: 1,234,567\.50 SAR\*/, 'headline total is bold');
});

test('currency: from the record, never assumed, never summed across currencies', () => {
  const s = wa('invoices', [inv({ summary_total: '100', summary_paid: '0', summary_unpaid: '100' }), inv({ id: 2, no: '2', currency_code: 'USD', summary_total: '50', summary_paid: '0', summary_unpaid: '50' }),
    inv({ id: 3, no: '3', currency_code: undefined, summary_total: '7', summary_paid: '0', summary_unpaid: '7' })], undefined, { lang: 'en' });
  assert.match(s, /\*Total: 100\.00 SAR\*/); assert.match(s, /\*Total: 50\.00 USD\*/); assert.match(s, /\*Total: 7\.00 \(currency not specified\)\*/);
  assert.ok(!/157|150\.00|107/.test(s), 'no cross-currency sum');
  const ar = wa('invoices', [inv({ id: 3, currency_code: undefined })]);
  assert.match(ar, /العملة غير محددة/); assert.ok(!/ر\.س/.test(ar));
  assert.match(wa('invoices', [inv({ summary_total: '-1234.5', summary_paid: '0', summary_unpaid: '-1234.5' })]), new RegExp(LRI + '-1,234\\.50 ر\\.س' + PDI));
});

test('financial status is shown only when the record proves it; anything else is unconfirmed; drafts/cancelled stay out of totals', () => {
  const unk = wa('invoices', [inv({ summary_paid: '1', summary_unpaid: '1' }), inv({ id: 2, no: '2', summary_total: undefined, summary_paid: undefined, summary_unpaid: undefined })], undefined, { lang: 'en' });
  assert.equal([...unk.matchAll(/❔ \*\d+\* · Unconfirmed/g)].length, 2, unk);
  assert.match(unk, /Paid: — · ⏳ Outstanding: —/, 'missing amounts are a dash, never 0');
  const t = wa('invoices', [inv({ summary_total: '100', summary_paid: '0', summary_unpaid: '100' }), inv({ id: 2, no: '2', draft: 1, summary_total: '900', summary_paid: '0', summary_unpaid: '900' }),
    inv({ id: 3, no: '3', status: 'cancelled', summary_total: '700', summary_paid: '0', summary_unpaid: '700' })], undefined, { lang: 'en' });
  assert.match(t, /\*Total: 100\.00 SAR\*/); assert.match(t, /2 drafts\/cancelled excluded from totals/); assert.ok(!/1,000|1,700/.test(t));
  const over = wa('invoices', [inv({ due_date: '2026-10-01', summary_paid: '0', summary_unpaid: '18100' })], undefined, { lang: 'en' });
  assert.match(over, /🔴 \*007472\* · Overdue/);
  for (const status of [0, '0', 1, '1', 'x', undefined]) {
    const p = renderWhatsApp('list', 'invoice_payments', list('invoice_payments', [{ id: 1, date: '2026-05-02', client_id: 48, amount: '10', currency_code: 'SAR', status }]), { lang: 'en', wire: 'native' });
    assert.match(p, /❔ \*1\* · Unconfirmed/); assert.ok(!/Paid|Failed|Cancelled|Completed/i.test(p), p);
  }
  assert.match(renderWhatsApp('list', 'client_payments', list('client_payments', [{ id: 2, amount: '5', status: 'cancelled' }]), { lang: 'en' }), /Cancelled/);
});

test('incomplete lists are labelled a sample, never a full report', () => {
  const s = wa('invoices', many(8), { complete: false, total: 80 });
  assert.match(s, /عيّنة/); assert.match(s, /صفحة واحدة فقط/); assert.match(s, /إجماليات العيّنة المعروضة فقط/);
  assert.ok(!wa('invoices', many(8)).includes('صفحة واحدة فقط'));
  assert.equal(renderWhatsAppCliResult('list', 'invoices', list('invoices', many(2), { complete: false })).complete, false);
});

test('every supported entity renders in both languages without JSON, and get cards work (summary and detail)', () => {
  const samples = {
    invoices: inv({ notes: 'ملاحظة', InvoiceItem: [{ item: 'زيت', quantity: '2', unit_price: '10' }] }), estimates: inv(), credit_notes: inv(), purchase_invoices: { id: 4, no: 'P1', date: '2026-05-01', supplier_name: 'مورد', currency_code: 'SAR', summary_total: '10', summary_paid: '0', summary_unpaid: '10', draft: 0 },
    invoice_payments: { id: 2, date: '2026-05-02', client_id: 48, amount: '5', currency_code: 'SAR', payment_method: 'bank', invoice_id: 9 }, client_payments: { id: 3, amount: '5' },
    expenses: { id: 5, expense_number: 'E5', date: '2026-05-03', description: 'وقود', amount: '99.5', currency_code: 'SAR' }, incomes: { id: 6, amount: '1', date: '2026-05-04' },
    clients: { id: 7, business_name: 'عميل', phone1: '0555', email: 'a@b.sa', country_code: 'SA' }, suppliers: { id: 8, name: 'مورد' }, products: { id: 9, name: 'منتج', product_code: 'P-9', barcode: '123', unit_price: '12.5', currency_code: 'SAR' },
    taxes: { id: 1, name: 'VAT', value: 15, is_active: 1 }, treasuries: { id: 2, name: 'البنك', type: 1, balance: '1250.75', currency_code: 'SAR' }, journals: { id: 8, title: 'قيد' },
  };
  for (const [entity, rec] of Object.entries(samples)) for (const lang of ['ar', 'en']) for (const view of ['summary', 'detail']) {
    const l = renderWhatsApp('list', entity, list(entity, [rec, rec]), { lang, view, today: TODAY });
    const g = renderWhatsApp('get', entity, { ok: true, record: rec }, { lang, view, today: TODAY });
    for (const s of [l, g]) { assert.ok(s.length > 15 && s.length <= WA_MAX_CHARS, entity); noJson(s); assert.ok(!/^\s*\|/m.test(s), 'no table'); }
  }
  const d = renderWhatsApp('get', 'invoices', { ok: true, record: samples.invoices }, { lang: 'en', view: 'detail', wire: 'native' });
  assert.match(d, /\*Invoice 007472\*/); assert.match(d, /▫️ زيت × 2 — 10\.00 SAR/); assert.match(d, /📝 ملاحظة/);
  assert.match(renderWhatsApp('list', 'taxes', list('taxes', [samples.taxes]), { lang: 'en', wire: 'native' }), /VAT\* · 15% · 🟢 Active/);
});

test('statement: unofficial label, last rows only, balance only when reconciles === true', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ date: '2026-05-' + String(i + 1).padStart(2, '0'), kind: i % 2 ? 'invoice_payment' : 'invoice', reference: String(100 + i), debit: '10.00', credit: '0.00', balance: String((i + 1) * 10) + '.00' }));
  const base = { ok: true, client_id: '48', from: '2026-05-01', to: '2026-05-31', official: false, rows, totals: { debit: '120.00', credit: '0.00', balance: '4321.00', open_invoices_unpaid: '9876.00' }, warnings: ['w1'] };
  const ok = renderWhatsApp('statement', '48', { ...base, reconciles: true }, { lang: 'ar', wire: 'native' });
  assert.match(ok, /كشف حساب العميل/); assert.match(ok, /غير رسمي/); assert.ok(ok.includes('4,321.00') && ok.includes('9,876.00') && ok.includes('120.00'));
  assert.equal([...ok.matchAll(/▫️ ⁦2026/g)].length, 5, 'last 5 movements'); assert.ok(ok.includes('⁦111⁩') && ok.includes('⁦107⁩') && !ok.includes('⁦106⁩') && !ok.includes('⁦100⁩'), 'only the 5 newest movements');
  for (const reconciles of [false, undefined, null, 'true', 1]) for (const lang of ['ar', 'en']) {
    const s = renderWhatsApp('statement', '48', { ...base, reconciles }, { lang, wire: 'native' });
    assert.ok(!/4,321|9,876|120\.00 ·/.test(s.replace(/➕.*/, '')) && s.includes('⛔'), 'balance withheld for ' + String(reconciles));
    assert.ok(!/(Balance|الرصيد) [⁦\d]/.test(s), 'no per-row balance either: ' + s);
  }
  assert.match(renderWhatsApp('statement', '48', { ...base, reconciles: false }, { lang: 'en' }), /does not reconcile/);
  assert.match(renderWhatsApp('statement', '48', { ...base, rows: [], reconciles: true }, { lang: 'en' }), /No matching records/);
});

test('reports: scalar lines and first rows, money formatted, secret-looking keys dropped, never JSON', () => {
  const payload = { total_amount: '12345.6', period: '2026-05', api_key: 'SHOULD-NOT-SHOW', download_url: 'https://x.daftra.com/f?token=zzz', rows: [{ client: 'نبراس', total: '1000', count: '3', session_token: 'abc' }, { client: 'ب', total: '2.5', count: '1' }] };
  const s = renderWhatsApp('report', 'revenue', { ok: true, report: 'revenue', complete: true, official: false, payload }, { lang: 'en', wire: 'native' });
  assert.match(s, /total amount: 12,345\.60/); assert.match(s, /client: نبراس · total: 1,000\.00 · count: 3/); assert.match(s, /currency not specified/);
  assert.ok(!/SHOULD-NOT-SHOW|daftra\.com|zzz|api key|session/i.test(s), s); noJson(s);
  assert.match(renderWhatsApp('report', 'x', { ok: true, complete: false, payload: {} }, { lang: 'en' }), /One page only/);
});

test('Daftra text is untrusted: markers, backslashes, links, tokens and control chars cannot format, link or leak', () => {
  const evil = [
    'A *bold* _it_ ~st~ `code` \\ end', '1. fake list', '# heading', '> quote', '- dash', '[pay](http://evil.test/x) ![i](http://e.test/p.png) <b>x</b> | a | b |',
    'https://evil.test/p?x=1 www.evil.test nepras.daftra.com/api', 'Bearer abcdef0123456789 token=sekret apikey: k-123 ' + 'a'.repeat(40), '‮RTL⁦x⁩‏\u0000', '&amp; &#42; Smith & Sons',
  ];
  for (const text of evil) for (const lang of ['ar', 'en']) {
    const recs = [inv({ client_business_name: text, notes: text, no: text }), ];
    const out = [renderWhatsApp('list', 'invoices', list('invoices', recs), { lang, view: 'detail', wire: 'native' }),
      renderWhatsApp('get', 'invoices', { ok: true, record: recs[0] }, { lang, view: 'detail', wire: 'native' }),
      renderWhatsApp('list', 'clients', list('clients', [{ id: 1, business_name: text, email: text, phone1: text }]), { lang, wire: 'native' }),
      formatWhatsAppFailure({ ok: false, error: text }, { lang, wire: 'native' })];
    for (const s of out) {
      const stripped = s.replace(/(^|\s)\*(?=[^*\s])([^*\n]*[^*\s])\*(?=\s|$)/g, '$1$2');   // remove our own bold pairs
      assert.ok(!/[*~`\\<>[\]{}|]/.test(stripped), 'format char leaked: ' + JSON.stringify(stripped));
      assert.ok(!/\b_\S+_\b/.test(stripped.replace(/\S+_\S+_\S+/g, '')), 'no italic: ' + stripped);
      assert.ok(!/https?:|www\.|daftra\.com|sekret|k-123|abcdef0123|a{32}|‮|\u0000/i.test(s), 'link/secret/control leaked: ' + JSON.stringify(s));
      assert.ok(!/^[‏]?\s*([#>\-+]|\d+[.)]\s)/m.test(s), 'a value cannot open a list/heading/quote');
    }
  }
  const ent = wa('invoices', [inv({ client_business_name: '&amp; &#42;' })]); assert.ok(!/&amp;|&#42;/.test(ent));
  assert.match(wa('clients', [{ id: 1, business_name: 'john_doe', email: 'john_doe@x.sa' }]), /john_doe@x\.sa/, 'snake_case / e-mail stay copyable');
});

test('output stays one iPhone-sized message even with long notes and many rows', () => {
  const big = many(15, { notes: 'ن'.repeat(200), client_business_name: 'ع'.repeat(120), InvoiceItem: Array.from({ length: 15 }, (_, i) => ({ item: 'بند طويل جدا ' + i, quantity: '1', unit_price: '1' })) });
  for (const view of ['summary', 'detail']) for (const lang of ['ar', 'en']) {
    const s = renderWhatsApp('list', 'invoices', list('invoices', big), { lang, view, today: TODAY });
    assert.ok(s.length <= WA_MAX_CHARS, view + ' ' + s.length);
  }
  assert.ok(renderWhatsApp('list', 'invoices', list('invoices', many(30)), { lang: 'ar', today: TODAY }).split('\n').length < 40, 'summary stays short');
});

test('failures: reason by category, owner/hints/keys never echoed, available vs unavailable explicit', () => {
  const f = formatWhatsAppFailure({ ok: false, error: 'x', category: 'forbidden', status: 403, hint: 'API KEY k-secret https://x.daftra.com', owner_action: 'token abc' }, { lang: 'ar', available: ['العملاء'], unavailable: ['الفواتير'], wire: 'native' });
  assert.match(f, /⛔ \*تعذّر تنفيذ الطلب\*/); assert.match(f, /الصلاحية غير كافية/); assert.match(f, /403/); assert.match(f, /المتاح: العملاء/); assert.match(f, /المتعذّر: الفواتير/);
  assert.ok(!/k-secret|token abc|daftra\.com/.test(f));
  assert.match(formatWhatsAppFailure({ ok: false, category: 'report_not_exposed', status: 404 }, { lang: 'en' }), /not a permission issue/);
  assert.match(renderWhatsApp('list', 'invoices', { ok: false, category: 'upstream_error', status: 500 }, { lang: 'en' }), /Request failed/);
  assert.match(renderWhatsApp('list', 'invoices', null, { lang: 'en' }), /Request failed/);
});

test('input validation: unknown language / view / wire / command is rejected', () => {
  assert.throws(() => renderWhatsApp('list', 'invoices', list('invoices', []), { lang: 'fr' }), /lang/);
  assert.throws(() => renderWhatsApp('list', 'invoices', list('invoices', []), { view: 'x' }), /view/);
  assert.throws(() => renderWhatsApp('list', 'invoices', list('invoices', []), { wire: 'x' }), /wire/);
  assert.throws(() => renderWhatsApp('propose', 'x', { ok: true }, {}), /supports list/);
});

test('the Markdown views (--render ar|en) are unchanged by the WhatsApp view', () => {
  const md = renderMarkdown('list', 'invoices', list('invoices', [inv()]), { lang: 'ar', today: TODAY });
  assert.match(md, /^\|/m); assert.match(md, /\*\*الإجمالي/); assert.ok(!md.includes('📋'));
});

// ---- no message is ever sent from the formatter or from a test -----------------------------------------------------------------
test('the WhatsApp formatter is pure: no network, files, processes or messaging code', async () => {
  const src = await readFile(new URL('./daftra-format-whatsapp.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./daftra-cells.mjs', './daftra-entities.mjs', './daftra-format.mjs']);
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|spawn|exec|execFile|readFile|writeFile|process\.env|openclaw|baileys|sendMessage)\b/.test(src.replace(/\/\/.*$/gm, '')), 'no I/O or sender code');
});

// ---- CLI integration ------------------------------------------------------------------------------------------------------------
async function cli(args, seed) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-wa-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k-secret' };
  const fake = new FakeDaftra(seed); const realFetch = globalThis.fetch; let leaked = 0;
  globalThis.fetch = () => { leaked++; throw Error('a real network call/message send was attempted'); };      // a test must never reach WhatsApp or the net
  try { return { out: await run(args, { env, fetcher: fake.fetch, sleep: async () => {} }), fake, leaked: () => leaked }; } finally { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); }
}
test('CLI --render whatsapp: same GET requests as without it, text out, no JSON/records/secrets, nothing sent', async () => {
  const lists = { invoices: many(8).map((r) => ({ ...r })) };
  const plain = await cli(['list', 'invoices', '--all'], { lists });
  const wa1 = await cli(['list', 'invoices', '--all', '--render', 'whatsapp'], { lists });
  assert.deepEqual(wa1.fake.calls.map((c) => c.method + c.path + c.search), plain.fake.calls.map((c) => c.method + c.path + c.search));
  assert.equal(wa1.fake.posts.length, 0); assert.equal(wa1.leaked(), 0);
  assert.equal(wa1.out.ok, true); assert.equal(wa1.out.channel, 'whatsapp'); assert.equal(wa1.out.lang, 'ar'); assert.equal(wa1.out.view, 'summary'); assert.equal(wa1.out.complete, true);
  assert.match(wa1.out.markdown, /\*\*الفواتير\*\*/); assert.match(wa1.out.preview, /\*الفواتير\*/); assert.equal(wa1.out.chars, wa1.out.markdown.length);
  assert.ok(!('records' in wa1.out) && !JSON.stringify(wa1.out).includes('k-secret'));
  const en = await cli(['get', 'invoices', '3', '--render', 'whatsapp', '--lang', 'en', '--view', 'detail']);
  assert.match(en.out.preview, /\*Invoice 3\*/); assert.equal(en.out.lang, 'en'); assert.equal(en.leaked(), 0);
  const ar = await cli(['list', 'invoices', '--all', '--render', 'ar'], { lists });
  assert.ok(ar.out.markdown.includes('|') && !('preview' in ar.out), '--render ar|en still returns the Markdown table view');
});
test('CLI --render whatsapp is read-only and strict about flags', () => {
  for (const args of [['propose', 'expense', '--render', 'whatsapp'], ['execute', 'x', '--render', 'whatsapp'], ['pdf', '3', '--render', 'whatsapp'], ['capabilities', '--render', 'whatsapp']])
    assert.throws(() => renderOptions(args), /supports only/, args.join(' '));
  assert.throws(() => renderOptions(['list', 'invoices', '--render', 'whatsapp', '--lang', 'fr']), /--lang must be/);
  assert.throws(() => renderOptions(['list', 'invoices', '--render', 'ar', '--lang', 'en']), /only valid with --render whatsapp/);
  assert.throws(() => renderOptions(['list', 'invoices', '--lang', 'en']), /--render must be/);
  assert.throws(() => renderOptions(['list', 'invoices', '--render', 'telegram']), /--render must be/);
  assert.throws(() => renderOptions(['list', 'invoices', '--render', 'whatsapp', '--view', 'all']), /--view/);
  assert.deepEqual(renderOptions(['list', 'invoices', '--render', 'whatsapp']), { channel: 'whatsapp', lang: 'ar', view: 'summary' });
  assert.deepEqual(renderOptions(['statement', '5', '--render', 'whatsapp', '--lang', 'en', '--view', 'detail']), { channel: 'whatsapp', lang: 'en', view: 'detail' });
  assert.deepEqual(renderOptions(['list', 'invoices', '--render', 'en']), { lang: 'en', view: 'summary' });
  assert.equal(renderOptions(['list', 'invoices']), null);
});
