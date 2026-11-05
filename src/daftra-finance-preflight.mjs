// Pure preflight for Daftra financial actions. Never calls the API or creates a record.
const TYPES = Object.freeze({
  sales_invoice: { resource: 'invoices', approvedVerb: 'create invoice' },
  estimate: { resource: 'estimates', approvedVerb: 'create estimate' },
  expense: { resource: 'expenses', approvedVerb: 'create expense' },
  invoice_payment: { resource: 'invoice_payments', approvedVerb: 'record invoice payment' },
  client_payment: { resource: 'client_payments', approvedVerb: 'record client payment' },
});
const MONEY = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const ID = /^[1-9]\d{0,14}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function money(value, field) {
  const s = String(value);
  if (!MONEY.test(s)) throw Error(field + ' must be a non-negative amount with up to 2 decimals');
  return s;
}
function id(value, field) {
  const s = String(value);
  if (!ID.test(s)) throw Error(field + ' invalid');
  return s;
}
function date(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')))
    throw Error('Invalid date');
  return value;
}
export function prepareFinancialAction(type, input) {
  if (!Object.hasOwn(TYPES, type)) throw Error('Unsupported financial action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid input');
  const common = { type, resource: TYPES[type].resource, date: date(input.date) };
  if (type === 'sales_invoice' || type === 'estimate') {
    common.client_id = id(input.client_id, 'client_id');
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100)
      throw Error('Must include 1–100 line items');
    common.items = input.items.map((item) => {
      if (!item || typeof item !== 'object' || typeof item.item !== 'string' || !item.item.trim() || item.item.length > 300) throw Error('Invalid line item');
      const quantity = money(item.quantity, 'quantity');
      const unit_price = money(item.unit_price, 'unit_price');
      if (Number(quantity) === 0) throw Error('Quantity must be positive');
      return { item: item.item.trim(), quantity, unit_price, product_id: item.product_id === undefined ? undefined : id(item.product_id, 'product_id') };
    });
  } else if (type === 'invoice_payment') {
    common.invoice_id = id(input.invoice_id, 'invoice_id');
    common.amount = money(input.amount, 'amount');
    if (Number(common.amount) === 0) throw Error('Payment cannot be zero');
    if (typeof input.payment_method !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(input.payment_method)) throw Error('Invalid payment method');
    common.payment_method = input.payment_method;
  } else if (type === 'client_payment') {
    common.client_id = id(input.client_id, 'client_id');
    common.amount = money(input.amount, 'amount');
    if (Number(common.amount) === 0) throw Error('Payment cannot be zero');
  } else if (type === 'expense') {
    common.amount = money(input.amount, 'amount');
    if (Number(common.amount) === 0) throw Error('Expense cannot be zero');
    if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 500) throw Error('Invalid description');
    common.description = input.description.trim();
  }
  return Object.freeze({
    ...common,
    status: 'PREVIEW_ONLY_NOT_SUBMITTED',
    canSubmit: false,
    requiresExplicitApproval: true,
    warning: 'No tax, account, duplicate, payment method, or Daftra required-field verification has occurred',
  });
}
