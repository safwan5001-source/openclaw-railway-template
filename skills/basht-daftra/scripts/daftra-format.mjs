// Presentation layer for Daftra read results in chat (iPhone first, Arabic RTL / English LTR).
// PURE: it takes the JSON a read command already produced and returns Markdown. It never fetches, never writes, never
// touches credentials, approvals or the API. Fetching lives in daftra-readonly.mjs; this file only formats.
//
// Rules enforced here (see SKILL.md §9):
//  - nothing is invented: a missing field renders "—", a status is shown only when the record's own fields prove it
//  - amounts are exact decimals (BigInt via daftra-money.mjs), thousands separators, 2 decimals, currency from the record;
//    totals are NEVER added across currencies
//  - an incomplete (single-page) list is labelled a sample, never a total
//  - raw JSON is never produced; values from Daftra are untrusted text and are stripped of control/bidi characters and escaped
//    so a client name cannot forge a link, a table row or a reordered line
import { parseDecimal, format as fmtUnits, ZERO } from './daftra-money.mjs';
import { normalizeDaftraDate } from './daftra-entities.mjs';
import { guessNumericColumns } from './daftra-cells.mjs';

export const LANGS = Object.freeze(['ar', 'en']);
export const VIEWS = Object.freeze(['summary', 'detail']);
const ROWS = Object.freeze({ summary: 10, detail: 25 });
const DASH = '—';
const LRI = '\u2066'; const PDI = '\u2069'; const RLM = '\u200f';

// ---- text safety ------------------------------------------------------------------------------------------------------
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const MD_SPECIAL = /[\\`*_{}\[\]()<>#+!|~&]/g;
export const clean = (v, max = 80) => {
  const s = String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
};
const esc = (v, max) => clean(v, max).replace(MD_SPECIAL, (c) => '\\' + c);
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || typeof v === 'object';

// ---- locale -----------------------------------------------------------------------------------------------------------
const I18N = {
  ar: {
    sample: 'عيّنة', of: 'من', none: 'لا توجد سجلات مطابقة.', unknownCur: 'العملة غير محددة',
    total: 'الإجمالي', paid: 'المدفوع', unpaid: 'المتبقي', count: 'العدد', date: 'التاريخ', party: 'الطرف', client: 'العميل', supplier: 'المورد',
    doc: 'المستند', status: 'الحالة', amount: 'المبلغ', notes: 'ملاحظات', method: 'طريقة الدفع', currency: 'العملة', name: 'الاسم', code: 'الرمز',
    price: 'السعر', rate: 'النسبة', type: 'النوع', phone: 'الجوال', email: 'البريد', country: 'الدولة', balance: 'الرصيد', debit: 'مدين', credit: 'دائن',
    item: 'البند', qty: 'الكمية', linkedInv: 'الفاتورة', moreRows: 'اطلب «التفاصيل» أو «المزيد» لعرض الباقي، أو صدّرها بملف.',
    incomplete: 'صفحة واحدة فقط وليست كل السجلات — لا تُعتبر تقريرًا كاملًا.', excluded: 'سجلات بلا مبلغ مؤكد مستبعدة من الإجمالي',
    notPosted: 'مسودات/ملغاة مستبعدة من الإجماليات', sampleTotals: 'إجماليات العيّنة المعروضة فقط', unofficial: 'غير رسمي — محسوب محليًا من سجلات دفترة',
    notOfficial: 'تقرير دفترة', otherCols: 'أُظهرت الأعمدة الأولى فقط.', record: 'سجل', treasury: 'خزينة', bank: 'حساب بنكي', cash: 'خزينة نقدية',
    active: 'مفعّلة', inactive: 'غير مفعّلة', openingNote: 'لا يشمل الرصيد الافتتاحي ولا الإشعارات الدائنة.',
    stmtUntrusted: 'الرصيد غير مطابق لأرصدة الفواتير في دفترة — لا يُعتمد.', lastRows: 'آخر',
    failed: 'تعذّر تنفيذ الطلب', available: 'المتاح', unavailable: 'المتعذّر', reason: 'السبب', action: 'المطلوب', details: 'تفاصيل', ownerCheck: 'يلزم مراجعة صلاحيات مفتاح API في دفترة.',
    st: { draft: 'مسودة', issued: 'صادرة', paid: 'مدفوعة', partial: 'مدفوعة جزئيًا', overdue: 'متأخرة', cancelled: 'ملغاة', unknown: 'غير مؤكدة', done: 'مكتملة', failedPay: 'ملغاة/فاشلة' },
    kinds: { invoice: 'فاتورة', debit_note: 'إشعار مدين', invoice_payment: 'دفعة فاتورة', client_payment: 'دفعة عميل' },
    cat: {
      forbidden: ['الصلاحية غير كافية لهذا المورد.', 'يلزم أن يسمح دور مفتاح API في دفترة بهذا القسم (إجراء من مالك الحساب).'],
      report_not_exposed: ['دفترة لا تتيح هذا التقرير على هذا الحساب (ليست مشكلة صلاحيات).', 'جرّب تقريرًا أو سجلًا بديلًا متاحًا.'],
      validation: ['دفترة رفضت أحد المعاملات أو أن الطلب أكبر من الحد المسموح.', 'ضيّق التواريخ أو الفلاتر ثم أعد المحاولة.'],
      invalid_page: ['دفترة رفضت طلب الترقيم (ليست مشكلة صلاحيات).', 'أعد المحاولة بدون فلاتر إضافية.'],
      unauthorized: ['لم يتم التعرّف على مفتاح الاتصال بدفترة.', 'يلزم تحديث مفتاح القراءة من المشغّل.'],
      not_found: ['لم يتم العثور على السجل المطلوب.', 'تحقق من الرقم الداخلي (id) وليس رقم المستند الظاهر.'],
      rate_limited: ['دفترة تحدّ من عدد الطلبات حاليًا.', 'أعد المحاولة بعد قليل.'],
      transient: ['خدمة دفترة غير متاحة مؤقتًا.', 'أعد المحاولة بعد قليل.'],
      upstream_error: ['حدث خطأ داخل دفترة أثناء بناء الرد.', 'جرّب طلبًا أضيق؛ وإن استمر فأبلغ دعم دفترة.'],
      method_not_allowed: ['العملية غير مدعومة للقراءة.', ''],
      unknown: ['تعذّر الحصول على الرد من دفترة.', ''],
    },
    ent: {
      invoices: 'الفواتير', estimates: 'عروض الأسعار', credit_notes: 'الإشعارات الدائنة', purchase_invoices: 'فواتير الشراء', invoice_payments: 'تحصيلات الفواتير',
      client_payments: 'مدفوعات العملاء', expenses: 'المصروفات', incomes: 'الإيرادات', clients: 'العملاء', suppliers: 'الموردون', products: 'المنتجات',
      product_categories: 'تصنيفات المنتجات', taxes: 'الضرائب', treasuries: 'الخزائن والبنوك', journals: 'القيود', journal_accounts: 'الحسابات', journal_cats: 'مجموعات الحسابات',
    },
    one: { invoices: 'فاتورة', estimates: 'عرض سعر', credit_notes: 'إشعار دائن', purchase_invoices: 'فاتورة شراء', invoice_payments: 'تحصيل', client_payments: 'دفعة عميل', expenses: 'مصروف', incomes: 'إيراد', clients: 'عميل', suppliers: 'مورد', products: 'منتج', taxes: 'ضريبة', treasuries: 'خزينة' },
  },
  en: {
    sample: 'sample', of: 'of', none: 'No matching records.', unknownCur: 'currency not specified',
    total: 'Total', paid: 'Paid', unpaid: 'Outstanding', count: 'Count', date: 'Date', party: 'Party', client: 'Client', supplier: 'Supplier',
    doc: 'Document', status: 'Status', amount: 'Amount', notes: 'Notes', method: 'Payment method', currency: 'Currency', name: 'Name', code: 'Code',
    price: 'Price', rate: 'Rate', type: 'Type', phone: 'Phone', email: 'Email', country: 'Country', balance: 'Balance', debit: 'Debit', credit: 'Credit',
    item: 'Item', qty: 'Qty', linkedInv: 'Invoice', moreRows: 'Ask for "details" or "more" to see the rest, or export it to a file.',
    incomplete: 'One page only, not all records — not a full report.', excluded: 'records without a confirmed amount excluded from totals',
    notPosted: 'drafts/cancelled excluded from totals', sampleTotals: 'Totals cover the displayed sample only', unofficial: 'Unofficial — computed locally from Daftra records',
    notOfficial: 'Daftra report', otherCols: 'Only the first columns are shown.', record: 'Record', treasury: 'Treasury', bank: 'Bank account', cash: 'Cash treasury',
    active: 'Active', inactive: 'Inactive', openingNote: 'Excludes opening balance and credit notes.',
    stmtUntrusted: 'Balance does not reconcile with Daftra invoice balances — do not rely on it.', lastRows: 'Last',
    failed: 'Request failed', available: 'Available', unavailable: 'Not available', reason: 'Reason', action: 'Needed', details: 'Details', ownerCheck: 'The Daftra API key role needs review.',
    st: { draft: 'Draft', issued: 'Issued', paid: 'Paid', partial: 'Partially paid', overdue: 'Overdue', cancelled: 'Cancelled', unknown: 'Unconfirmed', done: 'Completed', failedPay: 'Cancelled/failed' },
    kinds: { invoice: 'Invoice', debit_note: 'Debit note', invoice_payment: 'Invoice payment', client_payment: 'Client payment' },
    cat: {
      forbidden: ['Permission is not sufficient for this resource.', 'The Daftra API-key role must allow this section (account-owner action).'],
      report_not_exposed: ['Daftra does not expose this report on this account (not a permission issue).', 'Try an available alternative report or record list.'],
      validation: ['Daftra rejected a parameter, or the request exceeded a size limit.', 'Narrow the dates or filters and retry.'],
      invalid_page: ['Daftra refused the pagination request (not a permission issue).', 'Retry without extra filters.'],
      unauthorized: ['Daftra did not recognise the connection key.', 'The operator must refresh the read key.'],
      not_found: ['The requested record was not found.', 'Check the internal id, not the visible document number.'],
      rate_limited: ['Daftra is rate-limiting requests right now.', 'Retry shortly.'],
      transient: ['Daftra is temporarily unavailable.', 'Retry shortly.'],
      upstream_error: ['Daftra failed while building the response.', 'Try a narrower request; if it persists, contact Daftra support.'],
      method_not_allowed: ['This operation is not supported for reading.', ''],
      unknown: ['Could not get a response from Daftra.', ''],
    },
    ent: {
      invoices: 'Invoices', estimates: 'Quotes', credit_notes: 'Credit notes', purchase_invoices: 'Purchase invoices', invoice_payments: 'Invoice collections',
      client_payments: 'Client payments', expenses: 'Expenses', incomes: 'Incomes', clients: 'Clients', suppliers: 'Suppliers', products: 'Products',
      product_categories: 'Product categories', taxes: 'Taxes', treasuries: 'Treasuries & banks', journals: 'Journal entries', journal_accounts: 'Accounts', journal_cats: 'Account groups',
    },
    one: { invoices: 'Invoice', estimates: 'Quote', credit_notes: 'Credit note', purchase_invoices: 'Purchase invoice', invoice_payments: 'Collection', client_payments: 'Client payment', expenses: 'Expense', incomes: 'Income', clients: 'Client', suppliers: 'Supplier', products: 'Product', taxes: 'Tax', treasuries: 'Treasury' },
  },
};
const BADGE = { draft: '⚪', issued: '🔵', paid: '🟢', partial: '🟡', overdue: '🔴', cancelled: '⚫', unknown: '❔', done: '🟢', failedPay: '⚫' };

// ---- money ------------------------------------------------------------------------------------------------------------
// -> BigInt micro-units, or null when the value is missing / not a plain decimal. Never throws, never guesses.
export function toUnits(value) {
  if (typeof value === 'number') { if (!Number.isFinite(value)) return null; value = String(value); }
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(s) || /e/i.test(s)) return null;
  const neg = s.startsWith('-');
  try { const u = parseDecimal(neg ? s.slice(1) : s, 'amount', { maxDecimals: 6, maxIntegerDigits: 12 }); return neg ? -u : u; } catch { return null; }
}
const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function formatNumber(units) {
  if (units === null) return DASH;
  const s = fmtUnits(units, 2); const neg = s.startsWith('-'); const [w, f] = (neg ? s.slice(1) : s).split('.');
  return (neg ? '-' : '') + group(w) + '.' + f;
}
const CUR_AR = { SAR: 'ر.س', AED: 'د.إ', KWD: 'د.ك', QAR: 'ر.ق', BHD: 'د.ب', OMR: 'ر.ع', EGP: 'ج.م', JOD: 'د.أ', USD: 'دولار', EUR: 'يورو' };
const curCode = (v) => (typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null);
const ctxOf = (lang) => ({ lang, t: I18N[lang], rtl: lang === 'ar' });
// A left-to-right island inside Arabic text so numbers, ids, dates and currency codes keep their order next to Arabic words.
const ltr = (c, s) => (c.rtl ? LRI + s + PDI : s);
const money = (c, units, cur) => ltr(c, formatNumber(units) + (units !== null && cur ? ' ' + (c.rtl && CUR_AR[cur] ? CUR_AR[cur] : cur) : ''));
const dateOf = (c, v) => { const d = normalizeDaftraDate(typeof v === 'string' ? v : ''); return d ? ltr(c, d) : DASH; };
const textOf = (v, max) => (blank(v) ? DASH : esc(v, max));
const idOf = (c, v) => (blank(v) ? DASH : ltr(c, esc(v, 30)));
const line = (c, s) => (c.rtl ? RLM + s : s);

// ---- status (only what the record itself proves) ------------------------------------------------------------------------
const isTrue = (v) => v === true || v === 1 || v === '1';
const isFalse = (v) => v === false || v === 0 || v === '0';
export function documentStatus(rec, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (typeof rec.status === 'string' && /^cancell?ed$/i.test(rec.status.trim())) return 'cancelled';
  if (isTrue(rec.draft)) return 'draft';
  const total = toUnits(rec.summary_total); const paid = toUnits(rec.summary_paid); const unpaid = toUnits(rec.summary_unpaid);
  if (total === null || paid === null || unpaid === null || total <= ZERO || total - paid !== unpaid) return 'unknown';
  let base = null;
  if (unpaid === ZERO && paid === total) base = 'paid';
  else if (paid > ZERO && unpaid > ZERO) base = 'partial';
  else if (paid === ZERO && unpaid === total && isFalse(rec.draft)) base = 'issued';
  if (base === null) return 'unknown';
  if (base !== 'paid') {
    const due = normalizeDaftraDate(rec.due_date);                // only when the record itself carries a parseable due date
    if (due && due < today) return 'overdue';
  }
  return base;
}
export function paymentStatus(rec) {
  if (typeof rec.status === 'string' && /^cancell?ed$/i.test(rec.status.trim())) return 'failedPay';
  const s = String(rec.status ?? '').trim();
  return s === '1' ? 'done' : s === '0' ? 'failedPay' : 'unknown';   // 1 = successful, 0 = cancelled/failed (contract §6.1)
}
const badge = (c, st) => BADGE[st] + ' ' + c.t.st[st];

// ---- tables -----------------------------------------------------------------------------------------------------------
export function table(headers, rows) {
  const row = (cells) => '| ' + cells.map((x) => String(x).replace(/\n/g, ' ')).join(' | ') + ' |';
  return [row(headers), row(headers.map(() => '---')), ...rows.map(row)].join('\n');
}

// ---- entity specs -----------------------------------------------------------------------------------------------------
const partyName = (rec, side) => {
  const n = [rec[side + '_business_name'], rec[side + '_name'], rec.business_name, rec.client_name, rec.supplier_name].find((x) => !blank(x));
  if (n !== undefined) return { name: n, id: null };
  return { name: null, id: rec[side + '_id'] };
};
const partyCell = (c, rec, side) => {
  const p = partyName(rec, side);
  return p.name !== null ? esc(p.name, 22) : !blank(p.id) ? esc(c.t[side], 12) + ' #' + ltr(c, esc(p.id, 12)) : DASH;
};
const docRef = (rec) => (blank(rec.no) ? rec.id : rec.no);

function docSpec(side) {
  return {
    headers: (t) => [t.doc, t[side], t.total, '●'],
    row: (c, rec, ctx) => { const st = documentStatus(rec, ctx); return {
      cells: [idOf(c, docRef(rec)) + ' · ' + dateOf(c, rec.date), partyCell(c, rec, side), money(c, toUnits(rec.summary_total), curCode(rec.currency_code)), BADGE[st]], status: st }; },
    amounts: (rec) => ({ total: rec.summary_total, paid: rec.summary_paid, unpaid: rec.summary_unpaid, cur: curCode(rec.currency_code) }),
    card: (c, rec, ctx, full) => {
      const st = documentStatus(rec, ctx); const cur = curCode(rec.currency_code); const t = c.t;
      const out = [['status', badge(c, st)], [t[side], partyCell(c, rec, side)], [t.date, dateOf(c, rec.date)]];
      if (!blank(rec.due_date)) out.push([c.rtl ? 'الاستحقاق' : 'Due', dateOf(c, rec.due_date)]);
      out.push([t.total, money(c, toUnits(rec.summary_total), cur)]);
      if (!blank(rec.summary_paid)) out.push([t.paid, money(c, toUnits(rec.summary_paid), cur)]);
      if (!blank(rec.summary_unpaid)) out.push([t.unpaid, money(c, toUnits(rec.summary_unpaid), cur)]);
      if (blank(rec.currency_code)) out.push([t.currency, t.unknownCur]);
      if (full && !blank(rec.notes)) out.push([t.notes, esc(rec.notes, 200)]);
      return out;
    },
    lines: true,
  };
}
const paySpec = {
  headers: (t) => [t.doc, t.client, t.amount, '●'],
  row: (c, rec) => { const st = paymentStatus(rec); return { cells: [idOf(c, docRef(rec)) + ' · ' + dateOf(c, rec.date), partyCell(c, rec, 'client'),
    money(c, toUnits(rec.amount), curCode(rec.currency_code)), BADGE[st]], status: st }; },
  amounts: (rec) => ({ total: rec.amount, cur: curCode(rec.currency_code) }),
  card: (c, rec, ctx, full) => { const st = paymentStatus(rec); const t = c.t; const cur = curCode(rec.currency_code);
    const out = [['status', badge(c, st)], [t.client, partyCell(c, rec, 'client')], [t.date, dateOf(c, rec.date)], [t.amount, money(c, toUnits(rec.amount), cur)], [t.method, textOf(rec.payment_method, 30)]];
    if (!blank(rec.invoice_id)) out.push([t.linkedInv, idOf(c, rec.invoice_id)]);
    if (blank(rec.currency_code)) out.push([t.currency, t.unknownCur]);
    if (full && !blank(rec.notes)) out.push([t.notes, esc(rec.notes, 200)]);
    return out; },
};
const expSpec = {
  headers: (t) => [t.doc, t.notes, t.amount],
  row: (c, rec) => ({ cells: [idOf(c, blank(rec.expense_number) ? rec.id : rec.expense_number) + ' · ' + dateOf(c, rec.date), textOf(rec.description ?? rec.note ?? rec.notes, 22), money(c, toUnits(rec.amount), curCode(rec.currency_code))] }),
  amounts: (rec) => ({ total: rec.amount, cur: curCode(rec.currency_code) }),
  card: (c, rec, ctx, full) => { const t = c.t; const out = [[t.date, dateOf(c, rec.date)], [t.amount, money(c, toUnits(rec.amount), curCode(rec.currency_code))]];
    if (blank(rec.currency_code)) out.push([t.currency, t.unknownCur]);
    if (!blank(rec.description ?? rec.note)) out.push([t.notes, esc(rec.description ?? rec.note, 200)]);
    return out; },
};
const partySpec = (side) => ({
  headers: (t) => [t.name, t.phone, t.email],
  row: (c, rec) => ({ cells: [textOf(rec.business_name ?? rec.name, 24), blank(rec.phone1) ? DASH : ltr(c, esc(rec.phone1, 20)), textOf(rec.email, 26)] }),
  card: (c, rec) => { const t = c.t; return [[t.name, textOf(rec.business_name ?? rec.name, 80)], [t.phone, blank(rec.phone1) ? DASH : ltr(c, esc(rec.phone1, 20))], [t.email, textOf(rec.email, 80)], [t.country, textOf(rec.country_code, 8)]]; },
});
const prodSpec = {
  headers: (t) => [t.name, t.code, t.price],
  row: (c, rec) => ({ cells: [textOf(rec.name, 26), idOf(c, rec.product_code), money(c, toUnits(rec.unit_price), curCode(rec.currency_code))] }),
  card: (c, rec) => { const t = c.t; return [[t.name, textOf(rec.name, 80)], [t.code, idOf(c, rec.product_code)], ['Barcode', idOf(c, rec.barcode)], [t.price, money(c, toUnits(rec.unit_price), curCode(rec.currency_code))]]; },
};
const taxSpec = {
  headers: (t) => [t.name, t.rate, t.status],
  row: (c, rec) => ({ cells: [textOf(rec.name, 26), blank(rec.value) ? DASH : ltr(c, esc(rec.value, 8) + '%'), isTrue(rec.is_active) ? '🟢 ' + c.t.active : isFalse(rec.is_active) ? '⚫ ' + c.t.inactive : DASH] }),
  card: (c, rec) => { const t = c.t; return [[t.name, textOf(rec.name, 80)], [t.rate, blank(rec.value) ? DASH : ltr(c, esc(rec.value, 8) + '%')]]; },
};
const treSpec = {
  headers: (t) => [t.name, t.type, t.balance],
  row: (c, rec) => ({ cells: [textOf(rec.name, 26), String(rec.type) === '1' ? c.t.bank : String(rec.type) === '3' ? c.t.cash : DASH, money(c, toUnits(rec.balance), curCode(rec.currency_code))] }),
  card: (c, rec) => { const t = c.t; return [[t.name, textOf(rec.name, 80)], [t.type, String(rec.type) === '1' ? t.bank : String(rec.type) === '3' ? t.cash : DASH], [t.balance, money(c, toUnits(rec.balance), curCode(rec.currency_code))]]; },
};
const SPECS = {
  invoices: docSpec('client'), estimates: docSpec('client'), credit_notes: docSpec('client'), purchase_invoices: docSpec('supplier'),
  invoice_payments: paySpec, client_payments: paySpec, expenses: expSpec, incomes: expSpec,
  clients: partySpec('client'), suppliers: partySpec('supplier'), products: prodSpec, taxes: taxSpec, treasuries: treSpec,
};

// ---- summaries --------------------------------------------------------------------------------------------------------
// Totals per currency. A record whose amount cannot be confirmed is counted separately and never turned into 0.
function totalsByCurrency(records, spec) {
  const by = new Map(); let excluded = 0; let notPosted = 0;
  for (const rec of records) {
    // Drafts and cancelled documents are not receivables/payables: counted, but kept out of the money totals.
    if (spec.lines) { const st = documentStatus(rec); if (st === 'draft' || st === 'cancelled') { notPosted++; continue; } }
    const a = spec.amounts(rec); const total = toUnits(a.total);
    if (total === null) { excluded++; continue; }
    const key = a.cur ?? '';
    const cur = by.get(key) ?? { total: ZERO, paid: ZERO, unpaid: ZERO, hasPU: true };
    cur.total += total;
    const p = toUnits(a.paid); const u = toUnits(a.unpaid);
    if (p === null || u === null) cur.hasPU = false; else { cur.paid += p; cur.unpaid += u; }
    by.set(key, cur);
  }
  return { by, excluded, notPosted };
}
function summaryLines(c, records, spec, ctx, complete) {
  if (!spec.amounts) return [];
  const { by, excluded, notPosted } = totalsByCurrency(records, spec); const t = c.t; const out = [];
  for (const [cur, v] of by) {
    const parts = [t.total + ' ' + money(c, v.total, cur || null)];
    if (v.hasPU && spec.lines) parts.push(t.paid + ' ' + money(c, v.paid, cur || null), t.unpaid + ' ' + money(c, v.unpaid, cur || null));
    if (!cur) parts.push('(' + t.unknownCur + ')');
    out.push(line(c, '**' + parts.join(' · ') + '**'));
  }
  if (notPosted) out.push(line(c, 'ℹ️ ' + ltr(c, String(notPosted)) + ' ' + t.notPosted + '.'));
  if (excluded) out.push(line(c, '⚠️ ' + ltr(c, String(excluded)) + ' ' + t.excluded + '.'));
  if (!complete && out.length) out.push(line(c, '⚠️ ' + t.sampleTotals + '.'));
  if (spec.row && records[0] && spec.lines) {
    const counts = {}; for (const r of records) { const s = documentStatus(r, ctx); counts[s] = (counts[s] ?? 0) + 1; }
    const order = ['draft', 'issued', 'paid', 'partial', 'overdue', 'cancelled', 'unknown'].filter((s) => counts[s]);
    if (order.length) out.push(line(c, order.map((s) => BADGE[s] + ' ' + t.st[s] + ' ' + ltr(c, String(counts[s]))).join(' · ')));
  }
  return out;
}
const legend = (c, used) => line(c, [...used].map((s) => BADGE[s] + ' ' + c.t.st[s]).join(' · '));

// ---- renderers --------------------------------------------------------------------------------------------------------
function renderList(entity, result, c, opts) {
  const t = c.t; const spec = SPECS[entity]; const title = t.ent[entity] ?? esc(entity, 40);
  const records = Array.isArray(result.records) ? result.records : [];
  const complete = result.complete === true;
  const max = ROWS[opts.view]; const shown = records.slice(0, max);
  const head = '**' + title + '** — ' + ltr(c, String(records.length) + (result.total != null && result.total !== records.length ? ' ' + t.of + ' ' + result.total : '')) + (complete ? '' : ' (' + t.sample + ')');
  const out = [line(c, head)];
  if (!complete) out.push(line(c, '⚠️ ' + t.incomplete));
  if (!records.length) { out.push(line(c, t.none)); return out; }
  if (!spec) {                                                       // entity without a dedicated layout: a plain name/id table, no JSON
    out.push('', table([t.record, t.name], shown.map((r) => [idOf(c, r.id), textOf(r.name ?? r.title ?? r.description, 40)])));
  } else {
    const ctx = { today: opts.today };
    const rows = shown.map((r) => spec.row(c, r, ctx));
    const sums = summaryLines(c, records, spec, ctx, complete);
    if (sums.length) out.push(...sums);
    out.push('', table(spec.headers(t), rows.map((r) => r.cells)));
    const used = new Set(rows.map((r) => r.status).filter(Boolean));
    if (used.size) out.push('', legend(c, used));
  }
  if (records.length > shown.length) out.push('', line(c, ltr(c, String(shown.length)) + ' / ' + ltr(c, String(records.length)) + ' — ' + t.moreRows));
  return out;
}

function itemLines(c, rec) {
  const items = Array.isArray(rec.InvoiceItem) ? rec.InvoiceItem : Array.isArray(rec.items) ? rec.items : [];
  const rows = items.filter((i) => i && typeof i === 'object' && !blank(i.item)).slice(0, 15)
    .map((i) => [esc(i.item, 28), ltr(c, esc(i.quantity ?? DASH, 10)), money(c, toUnits(i.unit_price), curCode(rec.currency_code))]);
  return rows.length ? ['', table([c.t.item, c.t.qty, c.t.price], rows)] : [];
}
function renderGet(entity, result, c, opts) {
  const t = c.t; const spec = SPECS[entity]; const rec = result.record ?? {};
  if (!spec) return [line(c, '**' + (t.ent[entity] ?? esc(entity, 40)) + '** #' + idOf(c, rec.id)), ...Object.entries(rec).filter(([, v]) => !blank(v)).slice(0, opts.view === 'detail' ? 20 : 6)
    .map(([k, v]) => line(c, '- ' + esc(k, 30) + ': ' + esc(v, 80)))];
  const ref = docRef(rec);
  const out = [line(c, '**' + (t.one[entity] ?? esc(entity, 30)) + ' ' + idOf(c, ref) + '**')];
  for (const [label, value] of spec.card(c, rec, { today: opts.today }, opts.view === 'detail')) out.push(line(c, '- ' + (label === 'status' ? t.status : label) + ': ' + value));
  if (opts.view === 'detail' && spec.lines) out.push(...itemLines(c, rec));
  return out;
}

const KIND_LABEL = (c, k) => c.t.kinds[k] ?? esc(k, 20);
function renderStatement(result, c, opts) {
  const t = c.t; const rows = Array.isArray(result.rows) ? result.rows : []; const max = ROWS[opts.view];
  const tot = result.totals ?? {};
  const num = (v) => ltr(c, formatNumber(toUnits(v)));
  const out = [line(c, '**' + (c.rtl ? 'كشف حساب العميل' : 'Client statement') + ' ' + idOf(c, result.client_id) + '**'),
    line(c, t.date + ': ' + dateOf(c, result.from) + ' → ' + dateOf(c, result.to)), line(c, '⚠️ ' + t.unofficial + '. ' + t.openingNote), line(c, t.currency + ': ' + t.unknownCur)];
  out.push(line(c, '- ' + t.debit + ': ' + num(tot.debit) + ' · ' + t.credit + ': ' + num(tot.credit)));
  if (result.reconciles === false) out.push(line(c, '⛔ ' + t.stmtUntrusted));        // never quote the balance when it does not reconcile
  else out.push(line(c, '- **' + t.balance + ': ' + num(tot.balance) + '** · ' + t.unpaid + ': ' + num(tot.open_invoices_unpaid)));
  if (!rows.length) return [...out, line(c, t.none)];
  const shown = rows.slice(-max);
  out.push('', table([t.date, c.rtl ? 'البيان' : 'Entry', t.debit, t.credit, t.balance], shown.map((r) => [dateOf(c, r.date), KIND_LABEL(c, r.kind) + ' ' + idOf(c, r.reference), num(r.debit), num(r.credit), result.reconciles === false ? DASH : num(r.balance)])));
  if (rows.length > shown.length) out.push('', line(c, t.lastRows + ' ' + ltr(c, String(shown.length)) + ' / ' + ltr(c, String(rows.length)) + ' — ' + t.moreRows));
  for (const w of (opts.view === 'detail' ? result.warnings ?? [] : [])) out.push(line(c, '- ' + esc(w, 200)));
  return out;
}

const scalar = (v) => v !== null && typeof v !== 'object' && !blank(v);
const isMoneyKey = (k) => guessNumericColumns([k]).length > 0;
function findRows(node, depth = 0) {
  if (Array.isArray(node)) return node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x)) ? node : null;
  if (!node || typeof node !== 'object' || depth > 3) return null;
  for (const v of Object.values(node)) { const r = findRows(v, depth + 1); if (r) return r; }
  return null;
}
const cellValue = (c, k, v) => (!scalar(v) ? DASH : isMoneyKey(k) && toUnits(v) !== null ? ltr(c, formatNumber(toUnits(v))) : esc(v, 24));
function renderReport(name, result, c, opts) {
  const t = c.t; const payload = result.payload ?? {};
  const out = [line(c, '**' + t.notOfficial + ': ' + esc(name, 40) + '**')];
  if (result.complete === false) out.push(line(c, '⚠️ ' + t.incomplete));
  const flat = Object.entries(payload).filter(([, v]) => scalar(v)).slice(0, opts.view === 'detail' ? 20 : 8);
  for (const [k, v] of flat) out.push(line(c, '- ' + esc(k, 30) + ': ' + cellValue(c, k, v)));
  const rows = findRows(payload);
  if (rows) {
    const cols = Object.keys(rows[0]).filter((k) => scalar(rows[0][k])).slice(0, 3);
    if (cols.length) {
      const max = ROWS[opts.view];
      out.push('', table(cols.map((k) => esc(k, 20)), rows.slice(0, max).map((r) => cols.map((k) => cellValue(c, k, r[k])))));
      if (Object.keys(rows[0]).length > cols.length) out.push('', line(c, t.otherCols));
      if (rows.length > max) out.push(line(c, ltr(c, String(max)) + ' / ' + ltr(c, String(rows.length)) + ' — ' + t.moreRows));
    }
  }
  if (!flat.length && !rows) out.push(line(c, t.none));
  if (flat.some(([k]) => isMoneyKey(k)) || (rows && Object.keys(rows[0]).some(isMoneyKey))) out.push(line(c, t.currency + ': ' + t.unknownCur));
  return out;
}

// ---- failures ---------------------------------------------------------------------------------------------------------
// `body` is the error object the CLI prints ({ok:false,error,category,status,hint,owner_action,validation_errors}).
// `available`/`unavailable` let a multi-part answer say what was obtained and what was not.
export function formatFailure(body, { lang = 'ar', available = [], unavailable = [] } = {}) {
  const c = ctxOf(lang); const t = c.t; const cat = t.cat[body?.category] ?? t.cat.unknown;
  const out = [line(c, '⛔ **' + t.failed + '**'), line(c, '- ' + t.reason + ': ' + cat[0] + (body?.status ? ' ' + ltr(c, '(HTTP ' + esc(body.status, 4) + ')') : ''))];
  if (cat[1]) out.push(line(c, '- ' + t.action + ': ' + cat[1]));
  if (!body?.category && body?.error) out.push(line(c, '- ' + t.details + ': ' + esc(body.error, 160)));
  if (typeof body?.validation_errors === 'string') out.push(line(c, '- ' + t.details + ': ' + esc(body.validation_errors, 200)));
  if (available.length) out.push(line(c, '- ✅ ' + t.available + ': ' + available.map((x) => esc(x, 40)).join('، ')));
  if (unavailable.length || available.length) out.push(line(c, '- ❌ ' + t.unavailable + ': ' + (unavailable.length ? unavailable.map((x) => esc(x, 40)).join('، ') : DASH)));
  return out.join('\n');
}

// ---- entry points -----------------------------------------------------------------------------------------------------
export function renderMarkdown(command, target, result, { lang = 'ar', view = 'summary', today } = {}) {
  if (!LANGS.includes(lang)) throw Error('lang must be ar or en');
  if (!VIEWS.includes(view)) throw Error('view must be summary or detail');
  if (!result || result.ok === false) return formatFailure(result, { lang });
  const c = ctxOf(lang); const opts = { view, today };
  const lines = command === 'list' ? renderList(target, result, c, opts)
    : command === 'get' ? renderGet(target, result, c, opts)
    : command === 'statement' ? renderStatement(result, c, opts)
    : command === 'report' ? renderReport(target, result, c, opts)
    : (() => { throw Error('--render supports list, get, report and statement only'); })();
  return lines.join('\n');
}

// What the CLI prints with --render: the Markdown to relay to the user as-is (no JSON), plus completeness flags.
export function renderCliResult(command, target, result, opts = {}) {
  const markdown = renderMarkdown(command, target, result, opts);
  return { ok: true, lang: opts.lang ?? 'ar', view: opts.view ?? 'summary', complete: result?.complete !== false, markdown };
}
