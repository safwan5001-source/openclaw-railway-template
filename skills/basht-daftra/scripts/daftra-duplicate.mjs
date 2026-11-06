// Duplicate an existing sales invoice / purchase invoice / estimate into a NEW document proposal.
//
// Daftra documents NO copy/clone endpoint for these documents (the only "clone" is an audit field,
// `clone_id`, on expenses). So a duplicate is: GET the source (read-only) -> build the input of the normal
// create flow -> the usual approval-gated proposal. Therefore everything the create flow guarantees applies:
// draft first, tax/product/client verification, duplicate detection, hash-bound human approval, ledger.
//
// NEVER copied: id, number, payments/receipts, paid/unpaid/settlement, e-invoice (ZATCA) state, issue/created
// timestamps, document links, source links, custom item columns. The new document gets its identity from Daftra,
// and the request body shape allowlist makes sending any of those impossible even by mistake.
import { getRecord } from './daftra-readonly.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { isCalendarDate } from './daftra-entities.mjs';
import { redactRecord } from './daftra-normalize.mjs';
import { listPage } from './daftra-readonly.mjs';
import { prepareFinancialAction } from './daftra-finance-preflight.mjs';
import { parseDecimal } from './daftra-money.mjs';
import { DUP_SOURCES, TOTAL_AFFECTING, locate, trustedSourceId, sourceFingerprint } from './daftra-duplicate-source.mjs';

export { DUP_SOURCES };

const LINE_KEYS = ['item', 'description', 'quantity', 'unit_price', 'tax1', 'tax2', 'discount', 'discount_type', 'product_id'];
const NEVER_COPIED = ['id', 'no', 'payments', 'payment_status', 'summary_paid', 'summary_unpaid', 'summary_deposit', 'summary_refund', 'created', 'modified',
  'invoice_pdf_url', 'invoice_html_url', 'qr_code_url', 'password', 'estimate_id', 'source_type', 'source_id', 'subscription_id', 'work_order_id',
  'pos_shift_id', 'staff_id', 'is_received', 'received_date'];
const ALLOWED_SOURCE_TYPES = { invoices: [0], estimates: [3] };   // Daftra type ids: 0 invoice, 3 estimate (credit notes, debit notes, subscriptions are refused)
const OVERRIDE_KEYS = new Set(['date', 'client_id', 'supplier_id', 'currency_code', 'notes', 'finalize', 'line_overrides', 'remove_lines', 'add_lines',
  'accept_total_difference', 'acknowledge_duplicates']);

const plain = (v, label) => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(s)) throw Error(label + ' in the source is not a plain decimal (' + String(v).slice(0, 20) + ')');
  return s;
};
const hasValue = (v) => { if (v === undefined || v === null || v === '' || v === false) return false; const n = Number(v); return Number.isNaN(n) ? true : n !== 0; };

// Purchase lines carry the tax VALUE, sales lines the tax ID. Map value -> id only when unambiguous.
function mapPurchaseTax(value, taxes, label) {
  if (!hasValue(value)) return 0;
  const hits = taxes.filter((t) => Number(t.is_active) !== 0 && Number(t.value) === Number(value));
  if (hits.length !== 1) throw Error(label + ': source tax value ' + value + ' matches ' + hits.length + ' active taxes; choose the tax id with line_overrides');
  if (Number(hits[0].included) === 1) throw Error(label + ': source tax value ' + value + ' matches only a tax-INCLUSIVE tax, which would change the total; choose the tax id with line_overrides');
  return Number(hits[0].id);
}

export async function buildDuplicate({ source, id, overrides = {} }, env, fetcher) {
  if (typeof source !== 'string' || !Object.hasOwn(DUP_SOURCES, source)) throw Error('source must be one of: ' + Object.keys(DUP_SOURCES).join(', '));
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw Error('overrides must be an object');
  for (const k of Object.keys(overrides)) if (!OVERRIDE_KEYS.has(k)) throw Error('Unknown override: ' + k);
  if (!isCalendarDate(overrides.date)) throw Error('overrides.date (YYYY-MM-DD) is required: a copy never inherits the original date');
  const spec = DUP_SOURCES[source];
  const payload = await getRecord(source, id, env, fetcher);
  const { header, items } = locate(payload, spec);
  const sourceId = trustedSourceId(header, id);                  // identity comes from the returned document, never from the caller's input
  if (items.length > 100) throw Error('Source has more than 100 lines');
  const srcType = header.type === undefined || header.type === null || header.type === '' ? undefined : Number(header.type);
  if (ALLOWED_SOURCE_TYPES[source] && srcType !== undefined && !ALLOWED_SOURCE_TYPES[source].includes(srcType)) throw Error('Source document type ' + srcType + ' is not a standard ' + source.replace(/s$/, '').replace('_', ' ') + ' and cannot be duplicated');
  const taxes = (await listPage('taxes', {}, env, fetcher));
  if (!taxes.complete) throw Error('Tax table could not be proven complete');
  const taxRows = taxes.records;
  const blocking = []; const warnings = [];

  // header
  const partyKey = spec.party;
  const party = overrides[partyKey] ?? header[partyKey];
  if (party === undefined || party === null) throw Error('Source has no ' + partyKey + ' and none was provided');
  const input = { date: overrides.date, [partyKey]: String(party) };
  const currency = overrides.currency_code ?? header.currency_code; if (currency) input.currency_code = currency;
  const notes = overrides.notes ?? header.notes; if (typeof notes === 'string' && notes.trim() && notes.length <= 2000) input.notes = notes;
  else if (typeof notes === 'string' && notes.length > 2000) warnings.push('Source notes longer than 2000 characters were not copied');
  if (overrides.finalize === true) input.finalize = true;
  if (overrides.acknowledge_duplicates) input.acknowledge_duplicates = overrides.acknowledge_duplicates;

  // lines
  const lineOv = overrides.line_overrides ?? {};
  if (typeof lineOv !== 'object' || Array.isArray(lineOv)) throw Error('line_overrides must be an object keyed by 1-based line number');
  for (const [n, ov] of Object.entries(lineOv)) {
    if (!/^[1-9]\d{0,2}$/.test(n) || Number(n) > items.length) throw Error('line_overrides refers to a line that does not exist: ' + n);
    for (const k of Object.keys(ov ?? {})) if (!LINE_KEYS.includes(k)) throw Error('line_overrides: unsupported field ' + k);
  }
  const remove = new Set((overrides.remove_lines ?? []).map(Number));
  for (const n of remove) if (!Number.isInteger(n) || n < 1 || n > items.length) throw Error('remove_lines refers to a line that does not exist: ' + n);
  const lines = []; const lineDiff = [];
  items.forEach((src, i) => {
    const n = i + 1; const label = 'line ' + n;
    const copy = { item: src.item ?? src.org_name, description: src.description || undefined, quantity: plain(src.quantity, label + ' quantity'), unit_price: plain(src.unit_price, label + ' unit_price'),
      product_id: src.product_id && String(src.product_id) !== '0' ? String(src.product_id) : undefined };
    if (source === 'purchase_invoices') {
      copy.tax1 = mapPurchaseTax(src.tax1, taxRows, label + ' tax1'); copy.tax2 = mapPurchaseTax(src.tax2, taxRows, label + ' tax2');
      if (copy.tax1 !== 0 && copy.tax1 === copy.tax2) throw Error(label + ': tax1 and tax2 map to the same tax id; choose the tax ids with line_overrides');
      delete copy.description;                                  // purchase create lines carry no documented description field
    }
    else { copy.tax1 = hasValue(src.tax1) ? Number(src.tax1) : 0; copy.tax2 = hasValue(src.tax2) ? Number(src.tax2) : 0; }
    if (hasValue(src.discount)) { copy.discount = plain(src.discount, label + ' discount'); copy.discount_type = Number(src.discount_type) === 2 ? 2 : 1; }
    if (!copy.item || copy.quantity === undefined || copy.unit_price === undefined) throw Error(label + ' is missing item/quantity/unit_price in the source');
    const original = JSON.parse(JSON.stringify(copy));
    if (source === 'purchase_invoices' && lineOv[String(n)]?.description !== undefined) throw Error('line_overrides: description is not supported on purchase invoice lines');
    const proposed = { ...copy, ...(lineOv[String(n)] ?? {}) };
    for (const k of Object.keys(proposed)) if (proposed[k] === undefined) delete proposed[k];
    if (remove.has(n)) { lineDiff.push({ n, original, proposed: null, changed: ['(line removed)'] }); return; }
    lines.push(proposed);
    lineDiff.push({ n, original, proposed, changed: LINE_KEYS.filter((k) => String(original[k] ?? '') !== String(proposed[k] ?? '')) });
  });
  for (const add of overrides.add_lines ?? []) {
    for (const k of Object.keys(add ?? {})) if (!LINE_KEYS.includes(k) || (source === 'purchase_invoices' && k === 'description')) throw Error('add_lines: unsupported field ' + k);
    lines.push(add); lineDiff.push({ n: null, original: null, proposed: add, changed: ['(line added)'] });
  }
  if (!lines.length) throw Error('The new document would have no lines');
  input.items = lines;

  // what is deliberately not copied, and what would change the total
  const notCopied = NEVER_COPIED.filter((k) => hasValue(header[k]) || (Array.isArray(header[k]) && header[k].length));
  for (const k of Object.keys(header)) if (/e.?invoice|zatca/i.test(k) && hasValue(header[k]) && !notCopied.includes(k)) notCopied.push(k);
  if (Array.isArray(payload?.data?.Payment) && payload.data.Payment.length) notCopied.push('payments');
  const totalAffecting = TOTAL_AFFECTING.filter((k) => hasValue(header[k]));
  if (source === 'purchase_invoices' && lines.some((l) => l.discount !== undefined)) warnings.push('Purchase invoice line discounts are not documented for creation: Daftra may ignore them; compare the total');
  warnings.unshift('THIS CREATES A NEW FINANCIAL DOCUMENT: if approved and executed, a new ' + (input.finalize === true ? 'FINAL' : 'DRAFT') + ' ' + spec.type.replace('_', ' ') + ' with its own number is created in Daftra. The source ' + source + '#' + sourceId + ' is not modified and is not treated as a duplicate of the copy; any OTHER matching document still blocks the proposal.');
  if (header.draft && String(header.draft) !== '0') warnings.push('The source is itself a draft');
  if (totalAffecting.length && overrides.accept_total_difference !== true)
    blocking.push('Source has header-level ' + totalAffecting.join('/') + ' that a copy cannot reproduce; the new total would differ. Re-propose with accept_total_difference:true after reviewing');
  else if (totalAffecting.length) warnings.push('Source header-level ' + totalAffecting.join('/') + ' is NOT reproduced; total differs from the original (accepted by requester)');
  if (notCopied.length) warnings.push('Not copied (the new document gets its own identity/state): ' + notCopied.join(', '));

  // The new total must equal the source total unless the requester changed lines/prices or accepted a difference.
  try {
    const dry = prepareFinancialAction(spec.type, input, { taxes: taxRows, requireDate: true });
    const srcTotal = header.summary_total;
    const edited = Object.keys(lineOv).length > 0 || remove.size > 0 || (overrides.add_lines ?? []).length > 0;
    if (srcTotal !== undefined && srcTotal !== null && srcTotal !== '' && !totalAffecting.length) {
      const a = parseDecimal(String(srcTotal), 'summary_total', { maxDecimals: 6 }); const b = parseDecimal(dry.totals.total, 'total', { maxDecimals: 6 });
      if (a !== b) {
        if (!edited && overrides.accept_total_difference !== true) blocking.push('The computed total of the copy (' + dry.totals.total + ') differs from the source total (' + srcTotal + ') although no line was changed (rounding, tax or discount semantics differ). Re-propose with accept_total_difference:true after reviewing');
        else warnings.push('Total of the copy ' + dry.totals.total + ' vs source ' + srcTotal + (edited ? ' (lines were changed)' : ' (difference accepted by requester)'));
      }
    }
  } catch (e) { throw e; }
  const headerDiff = [
    { field: partyKey, original: header[partyKey] ?? null, proposed: input[partyKey] },
    { field: 'date', original: header.date ?? null, proposed: input.date },
    { field: 'currency_code', original: header.currency_code ?? null, proposed: input.currency_code ?? null },
    { field: 'notes', original: header.notes ?? null, proposed: input.notes ?? null },
  ].filter((d) => String(d.original ?? '') !== String(d.proposed ?? '') || d.field === 'date');
  const original = redactRecord({ source, id: sourceId, number: header.no ?? null, date: header.date ?? null, [partyKey]: header[partyKey] ?? null,
    currency_code: header.currency_code ?? null, summary_total: header.summary_total ?? null, lines: items.length });
  const diff = { original, header: headerDiff, lines: lineDiff, not_copied: notCopied };
  return { type: spec.type, input, meta: { duplicate_of: { entity: source, id: sourceId }, source_fingerprint: sourceFingerprint(source, header, items), diff }, blocking, warnings, diff };
}

// Read-only end to end (GETs only). Nothing is sent to Daftra; the result is an approval proposal whose signed
// `meta` carries the original-vs-proposed comparison that the human reviews with `daftra-approve.mjs show`.
export async function proposeDuplicate({ source, id, overrides }, { env = process.env, fetcher = fetch, actor = 'unknown', now } = {}) {
  const built = await buildDuplicate({ source, id, overrides }, env, fetcher);
  return createProposal(built.type, built.input, { env, fetcher, actor, now, meta: built.meta, extraBlocking: built.blocking, extraWarnings: built.warnings });
}
