// Pure preflight for Daftra financial actions. Never calls the API and never creates a record.
// It validates input, computes exact totals, and builds the EXACT request that would be sent
// (endpoint + body) so a human can approve a hash of it. Request shapes follow the official docs:
//   POST /api2/invoices.json          { Invoice:{client_id,date,draft,...}, InvoiceItem:[{item,unit_price,quantity,tax1,...}] }
//   POST /api2/estimates.json         same shape as invoices (type set by the endpoint)
//   POST /api2/purchase_invoices.json { PurchaseOrder:{supplier_id,date}, PurchaseOrderItem:[...] }   (?send=draft)
//   POST /api2/expenses.json          { Expense:{amount,date,unique_id,status} }                        (?send=draft)
//   POST /api2/invoice_payments.json  { InvoicePayment:{invoice_id,amount,payment_method,date} }
//   POST /api2/client_payments.json   { ClientPayment:{client_id,amount,payment_method,date} }
import { parseDecimal, roundTo, mul, div, format, ONE, ZERO } from './daftra-money.mjs';
import { isCalendarDate } from './daftra-entities.mjs';
import { CATALOG_TYPES, prepareCatalogAction } from './daftra-catalog.mjs';

const FINANCE_TYPES = {
  sales_invoice:     { resource: 'invoices',          endpoint: '/api2/invoices.json',          draftable: true,  verb: 'create sales invoice' },
  estimate:          { resource: 'estimates',         endpoint: '/api2/estimates.json',         draftable: true,  verb: 'create estimate' },
  purchase_invoice:  { resource: 'purchase_invoices', endpoint: '/api2/purchase_invoices.json', draftable: true,  verb: 'create purchase invoice' },
  expense:           { resource: 'expenses',          endpoint: '/api2/expenses.json',          draftable: true,  verb: 'create expense' },
  invoice_payment:   { resource: 'invoice_payments',  endpoint: '/api2/invoice_payments.json',  draftable: false, verb: 'record invoice payment' },
  client_payment:    { resource: 'client_payments',   endpoint: '/api2/client_payments.json',   draftable: false, verb: 'record client payment' },
};
for (const spec of Object.values(FINANCE_TYPES)) spec.method = 'POST';
export const ACTION_TYPES = Object.freeze({ ...FINANCE_TYPES, ...Object.fromEntries(Object.entries(CATALOG_TYPES).map(([k, v]) => [k, { ...v, draftable: false, catalog: true }])) });
// Backwards-compatible alias used by earlier tests/docs.
const TYPES = ACTION_TYPES;

const ID = /^[1-9]\d{0,14}$/;
const DOCUMENTED_METHODS = new Set(['cash', 'bank', 'cheque', 'credit', 'offline']);
const METHOD = /^[a-zA-Z0-9_-]{1,40}$/;

function id(value, field) {
  const s = String(value);
  if (!ID.test(s)) throw Error(field + ' invalid');
  return s;
}
function optId(value, field) { return value === undefined || value === null ? undefined : id(value, field); }
function date(value, { required = false } = {}) {
  if (value === undefined) { if (required) throw Error('date is required (YYYY-MM-DD)'); return undefined; }
  if (!isCalendarDate(value)) throw Error('Invalid date');
  return value;
}
function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') { if (required) throw Error(field + ' is required'); return undefined; }
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw Error('Invalid ' + field);
  return value.trim();
}
function money(value, field, opts) { return parseDecimal(value, field, { maxDecimals: 2, ...opts }); }

// ---- tax / totals --------------------------------------------------------------------------
// `taxes` is the tenant tax table from GET /api2/taxes.json: [{id, value, included, is_active, name}].
function taxIndex(taxes) {
  if (!taxes) return null;
  return new Map(taxes.map((t) => [String(t.id), t]));
}
function lineTax(taxRef, net, gross, index, warnings, label) {
  if (taxRef === undefined || taxRef === '0') return { tax: ZERO, net };
  if (!index) { warnings.push(label + ': tax not verified (tax table not loaded)'); return { tax: ZERO, net, unverified: true }; }
  const tax = index.get(taxRef);
  if (!tax) throw Error(label + ': tax id ' + taxRef + ' does not exist in this tenant');
  if (Number(tax.is_active) === 0) throw Error(label + ': tax id ' + taxRef + ' is inactive');
  const rate = parseDecimal(String(tax.value), 'tax value', { maxDecimals: 4 });
  const hundred = 100n * ONE;
  if (Number(tax.included) === 1) {
    // Price already contains tax: net = gross / (1 + rate), tax = gross - net.
    const base = div(gross * 1n, ONE + div(rate, hundred));
    const netEx = roundTo(base, 2);
    return { tax: roundTo(gross, 2) - netEx, net: netEx };
  }
  return { tax: roundTo(mul(net, div(rate, hundred)), 2), net };
}

function buildItems(rawItems, kind, index, warnings) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 100) throw Error('Must include 1–100 line items');
  let subtotal = ZERO; let tax1Total = ZERO; let tax2Total = ZERO;
  const items = rawItems.map((item, i) => {
    const label = 'line ' + (i + 1);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('Invalid line item');
    const name = text(item.item, 'item', 300, { required: true });
    const quantity = parseDecimal(item.quantity, label + ' quantity', { maxDecimals: 4 });
    const unitPrice = parseDecimal(item.unit_price, label + ' unit_price', { maxDecimals: 4 });
    if (quantity === ZERO) throw Error('Quantity must be positive');
    // Taxes must be explicit: omitting tax1 makes Daftra inherit it from the product (undeterminable here).
    if (item.tax1 === undefined) throw Error(label + ': tax1 is required (tax id, or 0 for no tax)');
    const tax1 = String(item.tax1 ?? 0);
    const tax2 = String(item.tax2 ?? 0);
    for (const [k, v] of [['tax1', tax1], ['tax2', tax2]]) if (v !== '0' && !ID.test(v)) throw Error(label + ': ' + k + ' invalid');
    // Discount: type 1 = percentage (default), type 2 = absolute amount (per Daftra docs: discount_type 1/2).
    const dtype = item.discount_type === undefined || item.discount_type === null ? 1 : Number(item.discount_type);
    if (![1, 2].includes(dtype)) throw Error(label + ': discount_type must be 1 (percentage) or 2 (absolute)');
    let discountVal = ZERO;
    if (item.discount !== undefined && item.discount !== null) discountVal = parseDecimal(item.discount, label + ' discount', { maxDecimals: 2 });
    if (dtype === 1 && discountVal > 100n * ONE) throw Error(label + ': discount cannot exceed 100%');
    const gross = mul(quantity, unitPrice);
    if (dtype === 2 && discountVal > gross) throw Error(label + ': absolute discount exceeds the line amount');
    const afterDiscount = dtype === 1 ? roundTo(mul(gross, ONE - div(discountVal, 100n * ONE)), 2) : roundTo(gross - discountVal, 2);
    const t1 = lineTax(tax1, afterDiscount, afterDiscount, index, warnings, label + ' tax1');
    if (tax2 !== '0' && index?.get(tax2) && Number(index.get(tax2).included) === 1) throw Error(label + ': tax-inclusive tax2 is not supported; use tax1 for the inclusive tax');
    const t2 = lineTax(tax2, afterDiscount, afterDiscount, index, warnings, label + ' tax2');
    subtotal += t1.net; tax1Total += t1.tax; tax2Total += t2.tax;
    const body = {
      item: name,
      quantity: format(quantity, 4).replace(/\.?0+$/, '') || '0',
      unit_price: format(unitPrice, 4).replace(/\.?0+$/, '') || '0',
      tax1: Number(tax1), tax2: Number(tax2),
    };
    if (discountVal > ZERO) { body.discount = Number(format(discountVal, 2)); body.discount_type = dtype; }
    if (item.product_id !== undefined) body.product_id = Number(id(item.product_id, label + ' product_id'));
    if (kind === 'docs' && item.description !== undefined) body.description = text(item.description, 'description', 2000);
    return body;
  });
  const total = subtotal + tax1Total + tax2Total;
  if (total >= 10n ** 12n * ONE) throw Error('Document total exceeds the supported maximum');
  return { items, totals: { subtotal: format(subtotal), tax1: format(tax1Total), tax2: format(tax2Total), total: format(total), estimated: true } };
}

export { canonicalJson, hashRequest } from './daftra-canonical.mjs';
import { hashRequest as _hashRequest } from './daftra-canonical.mjs';

// ---- main ----------------------------------------------------------------------------------
// options.taxes: tenant tax table (enables tax verification). options.idempotencyKey: only expenses
// send it (documented `unique_id`); invoices must NOT, because Daftra then recalculates offers/discounts.
export function prepareFinancialAction(type, input, options = {}) {
  if (Object.hasOwn(CATALOG_TYPES, type)) return prepareCatalogAction(type, input, options);
  if (!Object.hasOwn(TYPES, type)) throw Error('Unsupported financial action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid input');
  const spec = TYPES[type];
  const warnings = [];
  const index = taxIndex(options.taxes);
  const finalize = input.finalize === true;
  if (input.finalize !== undefined && typeof input.finalize !== 'boolean') throw Error('finalize must be true or false');
  const isDraft = spec.draftable && !finalize;
  const common = { type, resource: spec.resource, date: date(input.date, { required: options.requireDate ?? false }) };
  let body; let query = '';
  let totals;

  if (type === 'sales_invoice' || type === 'estimate') {
    common.client_id = id(input.client_id, 'client_id');
    const built = buildItems(input.items, 'docs', index, warnings);
    common.items = built.items; totals = built.totals;
    const invoice = { client_id: Number(common.client_id), draft: isDraft ? 1 : 0 };
    if (common.date) invoice.date = common.date;
    const notes = text(input.notes, 'notes', 2000); if (notes) invoice.notes = notes;
    const currency = text(input.currency_code, 'currency_code', 10); if (currency) invoice.currency_code = currency.toUpperCase();
    body = { Invoice: invoice, InvoiceItem: built.items };
  } else if (type === 'purchase_invoice') {
    common.supplier_id = id(input.supplier_id, 'supplier_id');
    const built = buildItems(input.items, 'purchase', index, warnings);
    common.items = built.items; totals = built.totals;
    const order = { supplier_id: Number(common.supplier_id) };
    if (common.date) order.date = common.date;
    const currency = text(input.currency_code, 'currency_code', 10); if (currency) order.currency_code = currency.toUpperCase();
    // Purchase lines carry item/unit_price/quantity only; tax fields are not documented for this endpoint.
    for (const line of built.items) if (line.tax1 || line.tax2) warnings.push('purchase invoice tax fields are not documented; Daftra may ignore tax1/tax2');
    body = { PurchaseOrder: order, PurchaseOrderItem: built.items };
    if (isDraft) query = 'send=draft';
  } else if (type === 'invoice_payment') {
    common.invoice_id = id(input.invoice_id, 'invoice_id');
    const amount = money(input.amount, 'amount');
    if (amount === ZERO) throw Error('Payment cannot be zero');
    common.amount = format(amount);
    const method = input.payment_method;
    if (typeof method !== 'string' || !METHOD.test(method)) throw Error('Invalid payment method');
    common.payment_method = method;
    if (!DOCUMENTED_METHODS.has(method)) warnings.push('payment_method "' + method + '" is not one of the documented built-in methods; Daftra will reject it unless it is an active method of this tenant');
    totals = { total: common.amount, estimated: false };
    body = { InvoicePayment: { invoice_id: Number(common.invoice_id), amount: common.amount, payment_method: method } };
    if (common.date) body.InvoicePayment.date = common.date;
    const ref = text(input.transaction_id, 'transaction_id', 100); if (ref) body.InvoicePayment.transaction_id = ref;
    const treasury = optId(input.treasury_id, 'treasury_id'); if (treasury) body.InvoicePayment.treasury_id = Number(treasury);
  } else if (type === 'client_payment') {
    common.client_id = id(input.client_id, 'client_id');
    const amount = money(input.amount, 'amount');
    if (amount === ZERO) throw Error('Payment cannot be zero');
    common.amount = format(amount);
    const method = input.payment_method;
    if (typeof method !== 'string' || !METHOD.test(method)) throw Error('Invalid payment method');
    common.payment_method = method;
    if (!DOCUMENTED_METHODS.has(method)) warnings.push('payment_method "' + method + '" is not one of the documented built-in methods; Daftra will reject it unless it is an active method of this tenant');
    totals = { total: common.amount, estimated: false };
    body = { ClientPayment: { client_id: Number(common.client_id), amount: common.amount, payment_method: method } };
    if (common.date) body.ClientPayment.date = common.date;
    const ref = text(input.transaction_id, 'transaction_id', 100); if (ref) body.ClientPayment.transaction_id = ref;
    const treasury = optId(input.treasury_id, 'treasury_id'); if (treasury) body.ClientPayment.treasury_id = Number(treasury);
    const notes = text(input.notes, 'notes', 2000); if (notes) body.ClientPayment.notes = notes;
    warnings.push('Daftra may auto-apply a client payment to an outstanding invoice of the same amount');
  } else if (type === 'expense') {
    const amount = money(input.amount, 'amount');
    if (amount === ZERO) throw Error('Expense cannot be zero');
    common.amount = format(amount);
    common.description = text(input.description, 'description', 500, { required: true });
    totals = { total: common.amount, estimated: false };
    const expense = { amount: common.amount, date: date(input.date, { required: true }), note: common.description };
    common.date = expense.date;
    const category = optId(input.expense_category_id, 'expense_category_id'); if (category) expense.expense_category_id = Number(category);
    const supplier = optId(input.supplier_id, 'supplier_id'); if (supplier) expense.supplier_id = Number(supplier);
    const treasury = optId(input.treasury_id, 'treasury_id'); if (treasury) expense.treasury_id = Number(treasury);
    const vendor = text(input.vendor, 'vendor', 200); if (vendor) expense.vendor = vendor;
    if (options.idempotencyKey) expense.unique_id = options.idempotencyKey; // documented idempotency
    if (isDraft) { expense.status = 'draft'; query = 'send=draft'; }
    body = { Expense: expense };
  }
  if ((type === 'sales_invoice' || type === 'estimate' || type === 'purchase_invoice') && !common.date)
    warnings.push('No date given: Daftra will default it, which may fall in a closed financial period');
  if (!index && (type === 'sales_invoice' || type === 'estimate' || type === 'purchase_invoice'))
    warnings.push('Tax table not loaded: taxes were not verified');
  warnings.push('Open/closed financial period and tenant-specific required fields are validated by Daftra, not by this preview');

  const request = { method: 'POST', path: spec.endpoint, query, body };
  const effects = isDraft ? ['creates_draft_document'] : (type === 'estimate' ? ['creates_estimate'] : ['posts_to_accounts']);
  if (!isDraft && (type === 'sales_invoice')) effects.push('may_trigger_e_invoice_submission');
  return Object.freeze({
    ...common,
    totals,
    request,
    request_hash: _hashRequest(request),
    mode: isDraft ? 'draft' : 'final',
    effects,
    reversible: isDraft ? 'draft can be deleted in Daftra' : 'no: posted/recorded entries need a reversing document in Daftra',
    warnings,
    status: 'PREVIEW_ONLY_NOT_SUBMITTED',
    canSubmit: false,
    requiresExplicitApproval: true,
  });
}

// ---- strict body shape (defence in depth: execute rebuilds nothing, it only sends what fits this) ------
import { PRODUCT_FIELDS } from './daftra-catalog.mjs';
const PRODUCT_KEYS = PRODUCT_FIELDS;
const LINE_KEYS = ['item', 'quantity', 'unit_price', 'tax1', 'tax2', 'discount', 'discount_type', 'product_id', 'description'];
export const BODY_SHAPES = Object.freeze({
  sales_invoice:    { Invoice: ['client_id', 'draft', 'date', 'notes', 'currency_code'], InvoiceItem: LINE_KEYS },
  estimate:         { Invoice: ['client_id', 'draft', 'date', 'notes', 'currency_code'], InvoiceItem: LINE_KEYS },
  purchase_invoice: { PurchaseOrder: ['supplier_id', 'date', 'currency_code'], PurchaseOrderItem: LINE_KEYS },
  expense:          { Expense: ['amount', 'date', 'note', 'expense_category_id', 'supplier_id', 'treasury_id', 'vendor', 'unique_id', 'status'] },
  invoice_payment:  { InvoicePayment: ['invoice_id', 'amount', 'payment_method', 'date', 'transaction_id', 'treasury_id'] },
  product_create:   { Product: PRODUCT_KEYS },
  product_update:   { Product: PRODUCT_KEYS },
  category_create:  { Category: ['name', 'category_type', 'parent_id', 'description', 'display_order'] },
  category_update:  { Category: ['name', 'parent_id', 'description', 'display_order'] },
  client_payment:   { ClientPayment: ['client_id', 'amount', 'payment_method', 'date', 'transaction_id', 'treasury_id', 'notes'] },
});
export function assertBodyShape(type, body) {
  const shape = Object.hasOwn(BODY_SHAPES, type) ? BODY_SHAPES[type] : null;
  if (!shape || !body || typeof body !== 'object' || Array.isArray(body)) throw Error('Unknown request body');
  const top = Object.keys(body);
  if (top.length !== Object.keys(shape).length || top.some((k) => !Object.hasOwn(shape, k))) throw Error('Request body has unexpected sections');
  for (const [section, keys] of Object.entries(shape)) {
    const value = body[section];
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.length || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !keys.includes(k))))
      throw Error('Request body has unexpected fields in ' + section);
  }
}
