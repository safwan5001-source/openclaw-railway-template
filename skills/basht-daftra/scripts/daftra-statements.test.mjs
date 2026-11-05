import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientStatement, clientStatement } from './daftra-statements.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'dummy' };
const invoices = [
  { id: 2, no: 'INV-2', date: '2025-02-10', type: 0, draft: 0, summary_total: '300.10', summary_unpaid: '100.10' },
  { id: 1, no: 'INV-1', date: '2025-02-01', type: 0, draft: 0, summary_total: '100.00', summary_unpaid: '0.00' },
  { id: 3, no: 'INV-3', date: '2025-02-11', type: 0, draft: 1, summary_total: '999.00', summary_unpaid: '999.00' },
  { id: 4, no: 'EST-4', date: '2025-02-12', type: 3, draft: 0, summary_total: '888.00', summary_unpaid: '888.00' },
];
const invoicePayments = [
  { id: 10, invoice_id: 1, date: '2025-02-05', amount: '100.00' },
  { id: 11, invoice_id: 2, date: '2025-02-15', amount: '200.00' },
];

test('running balance is exact, drafts and estimates are excluded, and it reconciles with per-invoice unpaid', () => {
  const s = buildClientStatement({ clientId: 4, from: '2025-02-01', to: '2025-02-28', invoices, invoicePayments, clientPayments: [] });
  assert.equal(s.official, false);
  assert.deepEqual(s.rows.map((r) => [r.date, r.kind, r.reference, r.balance]), [
    ['2025-02-01', 'invoice', 'INV-1', '100.00'],
    ['2025-02-05', 'invoice_payment', '1', '0.00'],
    ['2025-02-10', 'invoice', 'INV-2', '300.10'],
    ['2025-02-15', 'invoice_payment', '2', '100.10'],
  ]);
  assert.deepEqual({ ...s.totals }, { debit: '400.10', credit: '300.00', balance: '100.10', open_invoices_unpaid: '100.10' });
  assert.equal(s.reconciles, true);
  assert.ok(s.warnings.some((w) => /not an official/.test(w)));
});

test('a balance that disagrees with Daftra per-invoice balances is flagged, not trusted', () => {
  const bad = invoices.map((i) => i.id === 2 ? { ...i, summary_unpaid: '50.00' } : i);
  const s = buildClientStatement({ clientId: 4, from: '2025-02-01', to: '2025-02-28', invoices: bad, invoicePayments, clientPayments: [] });
  assert.equal(s.reconciles, false);
  assert.ok(s.warnings.some((w) => /Does not reconcile/.test(w)));
});

test('on-account client payments carry a double-counting warning', () => {
  const s = buildClientStatement({ clientId: 4, from: 'a', to: 'b', invoices: [], invoicePayments: [], clientPayments: [{ id: 5, date: '2025-02-02', amount: '10' }] });
  assert.ok(s.warnings.some((w) => /double-counts/.test(w)));
  assert.equal(s.rows[0].balance, '-10.00');
});

test('clientStatement fetches every page of each collection and refuses unprovable data', async () => {
  const calls = [];
  const all = {
    invoices: invoices.slice(0, 2).map((r) => ({ Invoice: r })),
    invoice_payments: invoicePayments.slice(0, 1).map((r) => ({ InvoicePayment: r })),
    client_payments: [],
  };
  const fetcher = async (url) => {
    const res = url.pathname.replace('/api2/', '').replace('.json', '');
    calls.push(res + '?' + url.searchParams.toString());
    const rows = all[res];
    const limit = Number(url.searchParams.get('limit')); const page = Number(url.searchParams.get('page'));
    const pageCount = Math.ceil(rows.length / limit);
    return new Response(JSON.stringify({ data: rows.slice((page - 1) * limit, page * limit), pagination: { page, page_count: pageCount, total_results: rows.length, next: page < pageCount ? 'n' : null } }), { status: 200 });
  };
  const s = await clientStatement({ clientId: 4, from: '2025-02-01', to: '2025-02-28' }, env, fetcher, { sleep: async () => {} });
  assert.equal(s.provenance.complete, true);
  assert.deepEqual(s.provenance.counts, { invoices: 2, invoice_payments: 1, client_payments: 0 });
  assert.ok(calls.some((c) => c.startsWith('invoice_payments?') && c.includes('status=1') && c.includes('client_id=4') && c.includes('date_from=2025-02-01')));
  await assert.rejects(clientStatement({ clientId: 4, from: '2025-03-01', to: '2025-02-01' }, env, fetcher), /from <= to/);
  await assert.rejects(clientStatement({ clientId: '4/5', from: '2025-01-01', to: '2025-02-01' }, env, fetcher), /Invalid client id/);
  const noMeta = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  await assert.rejects(clientStatement({ clientId: 4, from: '2025-01-01', to: '2025-02-01' }, env, noMeta), /completeness cannot be proven/);
});
