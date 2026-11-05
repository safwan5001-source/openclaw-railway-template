// Normalise only a known Daftra list shape; fail closed on unclear pagination.
// This module neither calls Daftra nor writes financial data.
export function extractList(payload, entity) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid Daftra response');
  const key = Object.freeze({
    invoices: 'Invoice', estimates: 'Estimate', clients: 'Client',
    products: 'Product', expenses: 'Expense',
    invoice_payments: 'InvoicePayment', client_payments: 'ClientPayment',
  })[entity];
  if (!key) throw Error('Unsupported entity');
  // An API schema may vary by version. Do not silently output zero records for unknown responses.
  const root = payload.data;
  if (!Array.isArray(root)) throw Error('Unrecognised list response: expected data array');
  const items = root.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('Invalid row');
    const model = entry[key];
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw Error('Missing model ' + key);
    return model;
  });
  // An incomplete collection must not be labeled a complete report.
  const pagination = payload.pagination ?? payload.meta?.pagination ?? null;
  const total = pagination?.total ?? payload.total ?? null;
  if (total !== null && (!Number.isInteger(Number(total)) || Number(total) < items.length))
    throw Error('Invalid pagination');
  const knownComplete = total !== null && Number(total) === items.length ||
    payload.complete === true;
  return Object.freeze({
    records: items,
    entity,
    complete: knownComplete,
    count: items.length,
    total: total === null ? null : Number(total),
    warning: knownComplete ? null : 'Pagination not proven complete: do not call this a full report',
  });
}
export function pickColumns(records, columns) {
  if (!Array.isArray(records) || !Array.isArray(columns)) throw Error('Invalid arguments');
  if (columns.length < 1 || columns.length > 100 || columns.some(c => !/^[a-zA-Z0-9_]+$/.test(c))) throw Error('Invalid columns');
  return records.map(record => Object.fromEntries(columns.map(col => [col, record?.[col] ?? null])));
}
