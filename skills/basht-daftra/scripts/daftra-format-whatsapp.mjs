// WhatsApp view of Daftra read results (iPhone first, Arabic RTL / English LTR).
// PURE, like daftra-format.mjs: it takes the JSON a read command already produced and returns text. It never fetches, never writes,
// never sends a message, never touches credentials, approvals or the API. Statuses, amounts, currencies and totals come from the
// shared logic exported by daftra-format.mjs (documentStatus, paymentStatus, toUnits, totalsByCurrency, money ...) - nothing is recomputed here.
//
// How OpenClaw delivers text (checked against openclaw@2026.10.9 + @openclaw/whatsapp@2026.10.9, see docs/DAFTRA_WHATSAPP.md):
// every outbound WhatsApp text is parsed as Markdown and re-rendered with WhatsApp markers (`**x**` -> `*x*`, `*x*` -> `_x_`,
// tables -> bullets, a backslash escape stays visible as `\*`). So the text handed to the reply path ("gateway" wire) uses `**bold**`
// and the recipient sees `*bold*`; `preview` ("native" wire) is exactly what the recipient will see. Untrusted Daftra text is never
// backslash-escaped (the backslash would show up in WhatsApp): format characters are swapped for harmless look-alikes instead.
//
// Rules (SKILL.md section 9 still applies): missing field = "—", a status only when the record proves it, no cross-currency totals,
// a single page is a sample, an unreconciled statement balance is withheld, no JSON, no keys/tokens, no links from Daftra data.
import {
  LANGS, VIEWS, I18N, BADGE, SPECS, DASH, blank, isTrue, isFalse, ctxOf, ltr, money, curCode, toUnits, formatNumber,
  documentStatus, paymentStatus, partyName, docRef, totalsByCurrency, clean,
} from './daftra-format.mjs';
import { normalizeDaftraDate } from './daftra-entities.mjs';
import { guessNumericColumns } from './daftra-cells.mjs';

export const WA_VIEWS = VIEWS;
export const WA_ROWS = Object.freeze({ summary: 5, detail: 15 });   // last 5 by default, 15 on request
export const WA_MAX_CHARS = 3500;                                   // one message on an iPhone; the gateway splits at 4000
export const WIRES = Object.freeze(['gateway', 'native']);
const RLM = '‏';

// ---- untrusted text -----------------------------------------------------------------------------------------------------
const HIDDEN = { ar: { link: '(رابط محجوب)', secret: '(قيمة حساسة محجوبة)' }, en: { link: '(link hidden)', secret: '(sensitive value hidden)' } };
function redact(s, lang) {
  const h = HIDDEN[lang];
  return s                                                       // links first, so a token inside a URL goes with the whole URL
    .replace(/\b(?:https?|ftp|sftp|file|wss?):\/\/\S*/gi, h.link)
    .replace(/\bwww\.\S+/gi, h.link)
    .replace(/\b[a-z0-9-]+\.daftra\.com\S*/gi, h.link)
    .replace(/\bBearer\s+\S+/gi, h.secret)
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*\S+/gi, h.secret)
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, h.secret)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, h.secret);
}
// Characters OpenClaw's Markdown parser or WhatsApp itself would turn into formatting/links/tables are replaced by look-alikes.
const LOOKALIKE = { '*': '∗', '~': '∼', '`': 'ʼ', '\\': '⧵', '[': '(', ']': ')', '{': '(', '}': ')', '<': '‹', '>': '›', '|': '¦' };
const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
function neutralize(s) {
  return s.replace(/[*~`\\[\]{}<>|]/g, (ch) => LOOKALIKE[ch])
    .replace(/_/g, (m, i, str) => (isWordChar(str[i - 1]) && isWordChar(str[i + 1]) ? m : '＿'))   // snake_case / e-mail stay copyable
    .replace(/&(?=#?\w+;)/g, '＆');
}
const waText = (c, v, max = 80) => {
  if (blank(v)) return DASH;
  const s = neutralize(redact(clean(v, 1000), c.lang));
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
};
const waId = (c, v) => (blank(v) ? DASH : ltr(c, waText(c, v, 30)));

// ---- context ------------------------------------------------------------------------------------------------------------
function makeCtx(lang, wire, today) {
  const c = { ...ctxOf(lang), lang };
  const b = wire === 'native' ? (s) => '*' + s + '*' : (s) => '**' + s + '**';
  // Every line starts with an emoji or a word - never a marker - so bold is preceded by whitespace (WhatsApp requires it) and a
  // client name can never open a list / heading / quote at the start of a line.
  const ln = (s) => (c.rtl ? RLM + s : s);
  return { c, t: c.t, b, ln, today };
}
const dateOf = (w, v) => { const d = normalizeDaftraDate(typeof v === 'string' ? v : ''); return d ? ltr(w.c, d) : DASH; };
const amount = (w, v, rec) => money(w.c, toUnits(v), curCode(rec.currency_code));
const cap = (w, key) => (w.c.rtl ? { due: 'الاستحقاق', barcode: 'الباركود', entry: 'البيان', statement: 'كشف حساب العميل', period: 'الفترة', report: 'تقرير دفترة' } : { due: 'Due', barcode: 'Barcode', entry: 'Entry', statement: 'Client statement', period: 'Period', report: 'Daftra report' })[key];
const stLabel = (w, st) => BADGE[st] + ' ' + w.t.st[st];

// ---- one record ---------------------------------------------------------------------------------------------------------
function partyLine(w, rec, side) {
  const p = partyName(rec, side);
  if (p.name !== null) return w.ln('👤 ' + waText(w.c, p.name, 40));
  return blank(p.id) ? w.ln('👤 ' + DASH) : w.ln('👤 ' + waText(w.c, w.t[side], 12) + ' #' + waId(w.c, p.id));
}
const noteLine = (w, v) => (blank(v) ? [] : [w.ln('📝 ' + waText(w.c, v, 200))]);
const noCurrency = (w, rec) => (blank(rec.currency_code) ? ' (' + w.t.unknownCur + ')' : '');

function docRecord(side) {
  return (w, rec, { full, single, one }) => {
    const st = documentStatus(rec, { today: w.today }); const t = w.t;
    const ref = waText(w.c, docRef(rec), 30);
    const out = [w.ln(single ? '🧾 ' + w.b(one + ' ' + ref) : BADGE[st] + ' ' + w.b(ref) + ' · ' + t.st[st] + ' · ' + dateOf(w, rec.date))];
    if (single) out.push(w.ln(stLabel(w, st) + ' · ' + dateOf(w, rec.date)));
    out.push(partyLine(w, rec, side));
    out.push(w.ln('💰 ' + t.total + ': ' + amount(w, rec.summary_total, rec) + noCurrency(w, rec)));
    out.push(w.ln('✅ ' + t.paid + ': ' + amount(w, rec.summary_paid, rec) + ' · ⏳ ' + t.unpaid + ': ' + amount(w, rec.summary_unpaid, rec)));
    if (full || single) { if (!blank(rec.due_date)) out.push(w.ln('📅 ' + cap(w, 'due') + ': ' + dateOf(w, rec.due_date))); }
    if (full) out.push(...noteLine(w, rec.notes), ...itemLines(w, rec));
    return out;
  };
}
function itemLines(w, rec) {
  const items = Array.isArray(rec.InvoiceItem) ? rec.InvoiceItem : Array.isArray(rec.items) ? rec.items : [];
  return items.filter((i) => i && typeof i === 'object' && !blank(i.item)).slice(0, 10)
    .map((i) => w.ln('▫️ ' + waText(w.c, i.item, 28) + ' × ' + waId(w.c, i.quantity ?? DASH) + ' — ' + amount(w, i.unit_price, rec)));
}
const payRecord = (w, rec, { full, single, one }) => {
  const st = paymentStatus(rec); const t = w.t; const ref = waText(w.c, docRef(rec), 30);
  const out = [w.ln(single ? '💵 ' + w.b(one + ' ' + ref) : BADGE[st] + ' ' + w.b(ref) + ' · ' + t.st[st] + ' · ' + dateOf(w, rec.date))];
  if (single) out.push(w.ln(stLabel(w, st) + ' · ' + dateOf(w, rec.date)));
  out.push(partyLine(w, rec, 'client'), w.ln('💰 ' + t.amount + ': ' + amount(w, rec.amount, rec) + noCurrency(w, rec)));
  if (!blank(rec.payment_method) && (full || single)) out.push(w.ln('💳 ' + waText(w.c, rec.payment_method, 30)));
  if (!blank(rec.invoice_id) && (full || single)) out.push(w.ln('🔗 ' + t.linkedInv + ' ' + waId(w.c, rec.invoice_id)));
  if (full) out.push(...noteLine(w, rec.notes));
  return out;
};
const expRecord = (w, rec, { single, one }) => {
  const ref = waText(w.c, blank(rec.expense_number) ? rec.id : rec.expense_number, 30);
  return [w.ln('💸 ' + w.b(single ? one + ' ' + ref : ref) + ' · ' + dateOf(w, rec.date)),
    ...noteLine(w, rec.description ?? rec.note ?? rec.notes),
    w.ln('💰 ' + w.t.amount + ': ' + amount(w, rec.amount, rec) + noCurrency(w, rec))];
};
const partyRecord = (w, rec) => [w.ln('👤 ' + w.b(waText(w.c, rec.business_name ?? rec.name, 40))),
  w.ln('📞 ' + (blank(rec.phone1) ? DASH : ltr(w.c, waText(w.c, rec.phone1, 20)))), w.ln('✉️ ' + waText(w.c, rec.email, 40))];
const prodRecord = (w, rec, { full }) => [w.ln('📦 ' + w.b(waText(w.c, rec.name, 40))),
  w.ln('🏷️ ' + w.t.code + ' ' + waId(w.c, rec.product_code) + ' · ' + w.t.price + ': ' + amount(w, rec.unit_price, rec)),
  ...(full && !blank(rec.barcode) ? [w.ln('🔖 ' + cap(w, 'barcode') + ' ' + waId(w.c, rec.barcode))] : [])];
const taxRecord = (w, rec) => [w.ln('🧮 ' + w.b(waText(w.c, rec.name, 40)) + ' · ' + (blank(rec.value) ? DASH : ltr(w.c, waText(w.c, rec.value, 8) + '%'))
  + (isTrue(rec.is_active) ? ' · 🟢 ' + w.t.active : isFalse(rec.is_active) ? ' · ⚫ ' + w.t.inactive : ''))];
const treRecord = (w, rec) => [w.ln('🏦 ' + w.b(waText(w.c, rec.name, 40))),
  w.ln((String(rec.type) === '1' ? w.t.bank : String(rec.type) === '3' ? w.t.cash : DASH) + ' · ' + w.t.balance + ': ' + amount(w, rec.balance, rec))];
const plainRecord = (w, rec) => [w.ln('▫️ ' + waId(w.c, rec.id) + ' · ' + waText(w.c, rec.name ?? rec.title ?? rec.description, 40))];

const RECORDS = {
  invoices: docRecord('client'), estimates: docRecord('client'), credit_notes: docRecord('client'), purchase_invoices: docRecord('supplier'),
  invoice_payments: payRecord, client_payments: payRecord, expenses: expRecord, incomes: expRecord,
  clients: partyRecord, suppliers: partyRecord, products: prodRecord, taxes: taxRecord, treasuries: treRecord,
};

// ---- lists --------------------------------------------------------------------------------------------------------------
// "Last N": newest first by the record's own date, then by numeric id; records without either keep Daftra's order after the rest.
const num = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : -1);
const newestFirst = (records) => records.map((r, i) => ({ r, i, d: normalizeDaftraDate(typeof r?.date === 'string' ? r.date : '') ?? '', n: num(r?.id) }))
  .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.n - a.n || a.i - b.i)).map((x) => x.r);

function moneyBlock(w, records, spec, complete) {
  const { by, excluded, notPosted } = totalsByCurrency(records, spec); const t = w.t; const out = [];
  for (const [cur, v] of by) {
    const cu = cur || null; const tail = cur ? '' : ' (' + t.unknownCur + ')';
    out.push(w.ln('💰 ' + w.b(t.total + ': ' + money(w.c, v.total, cu) + tail)));
    if (v.hasPU && spec.lines) out.push(w.ln('✅ ' + t.paid + ': ' + money(w.c, v.paid, cu)), w.ln('⏳ ' + t.unpaid + ': ' + money(w.c, v.unpaid, cu)));
  }
  if (notPosted) out.push(w.ln('ℹ️ ' + ltr(w.c, String(notPosted)) + ' ' + t.notPosted + '.'));
  if (excluded) out.push(w.ln('⚠️ ' + ltr(w.c, String(excluded)) + ' ' + t.excluded + '.'));
  if (!complete && out.length) out.push(w.ln('⚠️ ' + t.sampleTotals + '.'));
  if (spec.lines) {
    const counts = {}; for (const r of records) { const s = documentStatus(r, { today: w.today }); counts[s] = (counts[s] ?? 0) + 1; }
    const used = ['draft', 'issued', 'paid', 'partial', 'overdue', 'cancelled', 'unknown'].filter((s) => counts[s]);
    if (used.length) out.push(w.ln(used.map((s) => stLabel(w, s) + ' ' + ltr(w.c, String(counts[s]))).join(' · ')));
  }
  return out;
}

function waList(entity, result, w, view, rows) {
  const t = w.t; const spec = SPECS[entity]; const render = RECORDS[entity] ?? plainRecord;
  const title = t.ent[entity] ?? waText(w.c, entity, 40);
  const records = Array.isArray(result.records) ? result.records : []; const complete = result.complete === true;
  const shown = newestFirst(records).slice(0, rows);
  const n = String(records.length);
  const how = records.length > shown.length ? t.lastRows + ' ' + ltr(w.c, String(shown.length)) + ' ' + t.of + ' ' + (complete ? '' : t.sample + ' ') + ltr(w.c, n)
    : ltr(w.c, n) + (complete ? '' : ' (' + t.sample + ')');
  const out = [w.ln('📋 ' + w.b(title) + ' — ' + how)];
  if (!complete) out.push(w.ln('⚠️ ' + t.incomplete));
  if (!records.length) return [...out, w.ln(t.none)];
  if (spec?.amounts) out.push(...moneyBlock(w, records, spec, complete));
  shown.forEach((rec) => out.push('', ...render(w, rec, { full: view === 'detail' })));
  if (records.length > shown.length) out.push('', w.ln('ℹ️ ' + ltr(w.c, String(shown.length)) + ' / ' + ltr(w.c, n) + ' — ' + t.moreRows));
  return out;
}

function waGet(entity, result, w, view) {
  const spec = SPECS[entity]; const rec = result.record ?? {}; const t = w.t;
  if (!spec) {
    const out = [w.ln('📋 ' + w.b((t.ent[entity] ?? waText(w.c, entity, 40)) + ' #' + waText(w.c, rec.id, 20)))];
    for (const [k, v] of Object.entries(rec).filter(([k, v]) => !blank(v) && !SECRET_KEY.test(k)).slice(0, view === 'detail' ? 12 : 5)) out.push(w.ln('▫️ ' + keyLabel(k) + ': ' + waText(w.c, v, 80)));
    return out;
  }
  const one = t.one[entity] ?? waText(w.c, entity, 30);
  const lines = RECORDS[entity](w, rec, { full: view === 'detail', single: true, one });
  return (spec.amounts || !lines.length) ? lines : [w.ln('📋 ' + w.b(one)), ...lines];
}

// ---- statement ----------------------------------------------------------------------------------------------------------
function waStatement(result, w, view, rows) {
  const t = w.t; const all = Array.isArray(result.rows) ? result.rows : []; const tot = result.totals ?? {};
  const n = (v) => ltr(w.c, formatNumber(toUnits(v)));
  const trusted = result.reconciles === true;                      // false or missing -> the balance is withheld, never quoted
  const out = [w.ln('📄 ' + w.b(cap(w, 'statement') + ' ' + waId(w.c, result.client_id))),
    w.ln('📅 ' + cap(w, 'period') + ': ' + dateOf(w, result.from) + ' → ' + dateOf(w, result.to)),
    w.ln('⚠️ ' + t.unofficial + '. ' + t.openingNote), w.ln('💱 ' + t.currency + ': ' + t.unknownCur),
    w.ln('➕ ' + t.debit + ': ' + n(tot.debit) + ' · ➖ ' + t.credit + ': ' + n(tot.credit))];
  if (!trusted) out.push(w.ln('⛔ ' + (result.reconciles === false ? t.stmtUntrusted : t.stmtUnverified)));
  else out.push(w.ln('💰 ' + w.b(t.balance + ': ' + n(tot.balance)) + ' · ⏳ ' + t.unpaid + ': ' + n(tot.open_invoices_unpaid)));
  if (!all.length) return [...out, w.ln(t.none)];
  const shown = all.slice(-rows);
  out.push('', w.ln('🧾 ' + (all.length > shown.length ? t.lastRows + ' ' + ltr(w.c, String(shown.length)) + ' ' + t.of + ' ' + ltr(w.c, String(all.length)) : ltr(w.c, String(all.length)))));
  for (const r of shown) {
    out.push('', w.ln('▫️ ' + dateOf(w, r.date) + ' · ' + (t.kinds[r.kind] ?? waText(w.c, r.kind, 20)) + ' ' + waId(w.c, r.reference)),
      w.ln(t.debit + ' ' + n(r.debit) + ' · ' + t.credit + ' ' + n(r.credit) + (trusted ? ' · ' + t.balance + ' ' + n(r.balance) : '')));
  }
  if (all.length > shown.length) out.push('', w.ln('ℹ️ ' + t.moreRows));
  if (view === 'detail') for (const x of result.warnings ?? []) out.push(w.ln('⚠️ ' + waText(w.c, x, 200)));
  return out;
}

// ---- reports ------------------------------------------------------------------------------------------------------------
const SECRET_KEY = /key|token|secret|passw|auth|credential|url|link|href|cookie|session/i;
const keyLabel = (k) => String(k).replace(/_/g, ' ').replace(/[^\p{L}\p{N} .-]/gu, '').slice(0, 30) || DASH;
const scalar = (v) => v !== null && typeof v !== 'object' && !blank(v);
const isMoneyKey = (k) => guessNumericColumns([k]).length > 0;       // same money-column heuristic as the Markdown view
function findRows(node, depth = 0) {
  if (Array.isArray(node)) return node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x)) ? node : null;
  if (!node || typeof node !== 'object' || depth > 3) return null;
  for (const v of Object.values(node)) { const r = findRows(v, depth + 1); if (r) return r; }
  return null;
}
function waReport(name, result, w, view, rows) {
  const t = w.t; const payload = result.payload ?? {};
  const cell = (k, v) => (!scalar(v) ? DASH : isMoneyKey(k) && toUnits(v) !== null ? ltr(w.c, formatNumber(toUnits(v))) : waText(w.c, v, 24));
  const out = [w.ln('📊 ' + w.b(cap(w, 'report') + ': ' + waText(w.c, name, 40)))];
  if (result.complete === false) out.push(w.ln('⚠️ ' + t.incomplete));
  const flat = Object.entries(payload).filter(([k, v]) => scalar(v) && !SECRET_KEY.test(k)).slice(0, view === 'detail' ? 15 : 8);
  for (const [k, v] of flat) out.push(w.ln('▫️ ' + keyLabel(k) + ': ' + cell(k, v)));
  const data = findRows(payload);
  if (data) {
    const cols = Object.keys(data[0]).filter((k) => scalar(data[0][k]) && !SECRET_KEY.test(k)).slice(0, 3);
    if (cols.length) {
      for (const r of data.slice(0, rows)) out.push('', w.ln('▫️ ' + cols.map((k) => keyLabel(k) + ': ' + cell(k, r[k])).join(' · ')));
      if (data.length > rows) out.push('', w.ln('ℹ️ ' + ltr(w.c, String(rows)) + ' / ' + ltr(w.c, String(data.length)) + ' — ' + t.moreRows));
    }
  }
  if (!flat.length && !data) out.push(w.ln(t.none));
  if (flat.some(([k]) => isMoneyKey(k)) || (data && Object.keys(data[0]).some(isMoneyKey))) out.push(w.ln('💱 ' + t.currency + ': ' + t.unknownCur));
  return out;
}

// ---- failures -----------------------------------------------------------------------------------------------------------
// `body` is the error object the CLI prints. Internal hints / owner_action are never echoed (they may carry keys or URLs).
function failureLines(body, w, available, unavailable) {
  const t = w.t; const cat = t.cat[body?.category] ?? t.cat.unknown; const list = (xs) => xs.map((x) => waText(w.c, x, 40)).join('، ');
  const out = [w.ln('⛔ ' + w.b(t.failed)), w.ln('📌 ' + t.reason + ': ' + cat[0] + (body?.status ? ' ' + ltr(w.c, '(HTTP ' + waText(w.c, body.status, 4) + ')') : ''))];
  if (cat[1]) out.push(w.ln('🛠️ ' + t.action + ': ' + cat[1]));
  if (!body?.category && body?.error) out.push(w.ln('ℹ️ ' + t.details + ': ' + waText(w.c, body.error, 160)));
  if (typeof body?.validation_errors === 'string') out.push(w.ln('ℹ️ ' + t.details + ': ' + waText(w.c, body.validation_errors, 200)));
  if (available.length) out.push(w.ln('✅ ' + t.available + ': ' + list(available)));
  if (unavailable.length || available.length) out.push(w.ln('❌ ' + t.unavailable + ': ' + (unavailable.length ? list(unavailable) : DASH)));
  return out;
}
function checkOpts(lang, wire) {
  if (!LANGS.includes(lang)) throw Error('lang must be ar or en');
  if (!WIRES.includes(wire)) throw Error('wire must be gateway or native');
}
export function formatWhatsAppFailure(body, { lang = 'ar', wire = 'gateway', available = [], unavailable = [] } = {}) {
  checkOpts(lang, wire);
  return failureLines(body, makeCtx(lang, wire), available, unavailable).join('\n');
}

// ---- entry points -------------------------------------------------------------------------------------------------------
function build(command, target, result, w, view, rows) {
  return command === 'list' ? waList(target, result, w, view, rows)
    : command === 'get' ? waGet(target, result, w, view)
    : command === 'statement' ? waStatement(result, w, view, rows)
    : command === 'report' ? waReport(target, result, w, view, rows)
    : (() => { throw Error('--render whatsapp supports list, get, report and statement only'); })();
}
// -> the text for ONE WhatsApp message. wire 'gateway' (default) is what to hand to OpenClaw (`**bold**`); 'native' is what the recipient sees (`*bold*`).
export function renderWhatsApp(command, target, result, { lang = 'ar', view = 'summary', today, wire = 'gateway' } = {}) {
  checkOpts(lang, wire);
  if (!VIEWS.includes(view)) throw Error('view must be summary or detail');
  const w = makeCtx(lang, wire, today);
  if (!result || result.ok === false) return failureLines(result, w, [], []).join('\n');
  // Keep it one message: drop the oldest rows until it fits; the "more" hint already tells the user how to ask for the rest.
  for (let rows = WA_ROWS[view]; ; rows--) {
    const text = build(command, target, result, w, view, rows).join('\n');
    if (text.length <= WA_MAX_CHARS || rows <= 1) return text;
  }
}

// What the CLI prints with `--render whatsapp`: `markdown` is the text to relay AS-IS in the WhatsApp reply (no JSON); `preview` is what
// the recipient will see after OpenClaw's WhatsApp conversion. Nothing is sent from here.
export function renderWhatsAppCliResult(command, target, result, opts = {}) {
  const lang = opts.lang ?? 'ar'; const view = opts.view ?? 'summary';
  const markdown = renderWhatsApp(command, target, result, { ...opts, lang, view, wire: 'gateway' });
  const preview = renderWhatsApp(command, target, result, { ...opts, lang, view, wire: 'native' });
  return { ok: true, channel: 'whatsapp', lang, view, complete: result?.complete !== false, chars: markdown.length, markdown, preview };
}
