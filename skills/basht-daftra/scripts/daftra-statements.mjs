// Client account statement, computed locally from COMPLETE paginated data (fetchAllRecords refuses
// to return anything it cannot prove complete). This is NOT an official Daftra statement:
// always label it so. Money is exact decimal arithmetic.
//
// Self-check: Daftra stores a per-invoice `summary_unpaid`. If
//     sum(invoice totals) - sum(invoice payments)  !=  sum(summary_unpaid)
// the statement says so (`reconciles: false`) instead of presenting a confident balance.
import { fetchAllRecords } from './daftra-readonly.mjs';
import { isCalendarDate, UNSUPPORTED_READS } from './daftra-entities.mjs';
import { parseDecimal, format, ZERO } from './daftra-money.mjs';

export const money = (v, field) => {
  // Daftra returns amounts as numbers or strings, possibly negative for refunds/credits.
  const s = String(v ?? '0').trim();
  const neg = s.startsWith('-');
  const units = parseDecimal(neg ? s.slice(1) : s, field, { maxDecimals: 6 });
  return neg ? -units : units;
};
const isTrue = (v) => v === true || v === 1 || v === '1';

export function buildClientStatement({ clientId, from, to, invoices, invoicePayments, clientPayments }) {
  const rows = [];
  for (const inv of invoices) {
    if (isTrue(inv.draft)) continue;                       // drafts are not accounting entries
    const type = Number(inv.type ?? 0);
    if (type !== 0 && type !== 16) continue;               // invoices and debit notes only
    rows.push({ date: inv.date, kind: type === 16 ? 'debit_note' : 'invoice', reference: String(inv.no ?? inv.id), id: String(inv.id), debit: money(inv.summary_total, 'summary_total'), credit: ZERO });
  }
  for (const p of invoicePayments) {
    rows.push({ date: p.date, kind: 'invoice_payment', reference: String(p.invoice_id ?? p.id), id: String(p.id), debit: ZERO, credit: money(p.amount, 'amount') });
  }
  for (const p of clientPayments) {
    rows.push({ date: p.date, kind: 'client_payment', reference: String(p.id), id: String(p.id), debit: ZERO, credit: money(p.amount, 'amount') });
  }
  rows.sort((a, b) => (String(a.date).slice(0, 10) < String(b.date).slice(0, 10) ? -1 : String(a.date).slice(0, 10) > String(b.date).slice(0, 10) ? 1 : a.kind.localeCompare(b.kind) || Number(a.id) - Number(b.id)));
  let running = ZERO; let debit = ZERO; let credit = ZERO;
  const out = rows.map((r) => {
    running += r.debit - r.credit; debit += r.debit; credit += r.credit;
    return { date: String(r.date).slice(0, 10), kind: r.kind, reference: r.reference, debit: format(r.debit), credit: format(r.credit), balance: format(running) };
  });
  const unpaid = invoices.filter((i) => !isTrue(i.draft) && [0, 16].includes(Number(i.type ?? 0)))
    .reduce((s, i) => s + money(i.summary_unpaid, 'summary_unpaid'), ZERO);
  const invoicePaid = invoicePayments.reduce((s, p) => s + money(p.amount, 'amount'), ZERO);
  const invoiceTotal = invoices.filter((i) => !isTrue(i.draft) && [0, 16].includes(Number(i.type ?? 0)))
    .reduce((s, i) => s + money(i.summary_total, 'summary_total'), ZERO);
  const reconciles = invoiceTotal - invoicePaid === unpaid;
  const warnings = [
    'Computed locally from Daftra records; not an official Daftra statement. Opening balance before the period is NOT included.',
    'Credit notes and refund receipts are not included.',
  ];
  if (clientPayments.length) warnings.push('On-account client payments may already be applied to invoices by Daftra; if so the balance double-counts them. Compare with the official Daftra report.');
  if (!reconciles) warnings.push('Does not reconcile with Daftra per-invoice unpaid balances (' + format(invoiceTotal - invoicePaid) + ' vs ' + format(unpaid) + '): do not rely on the balance.');
  return {
    client_id: String(clientId), from, to, official: false,
    rows: out,
    totals: { debit: format(debit), credit: format(credit), balance: format(running), open_invoices_unpaid: format(unpaid) },
    reconciles, warnings,
  };
}

export async function clientStatement({ clientId, from, to }, env, fetcher, options = {}) {
  if (!/^[1-9]\d{0,14}$/.test(String(clientId))) throw Error('Invalid client id');
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw Error('from/to must be valid YYYY-MM-DD dates with from <= to');
  const q = { client_id: String(clientId), date_from: from, date_to: to };
  const opts = { sleep: options.sleep };
  const [invoices, invoicePayments, clientPayments] = await Promise.all([
    fetchAllRecords('invoices', { ...opts, query: q }, env, fetcher),
    fetchAllRecords('invoice_payments', { ...opts, query: { ...q, status: '1' } }, env, fetcher),
    fetchAllRecords('client_payments', { ...opts, query: { ...q, status: '1' } }, env, fetcher),
  ]);
  const statement = buildClientStatement({ clientId, from, to, invoices: invoices.records, invoicePayments: invoicePayments.records, clientPayments: clientPayments.records });
  return { ...statement, official_statement: { available: false, reason: UNSUPPORTED_READS.client_statement_official }, provenance: { source: 'Daftra API', complete: true, counts: { invoices: invoices.count, invoice_payments: invoicePayments.count, client_payments: clientPayments.count }, fetched_at: new Date().toISOString() } };
}
