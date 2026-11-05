// BASHT/Daftra: intentionally read-only. No POST/PUT/PATCH/DELETE support.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
function config(env = process.env) {
  const base = new URL(env.DAFTRA_BASE_URL || '');
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.daftra.com') || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('DAFTRA_BASE_URL must be an HTTPS Daftra tenant root');
  }
  if (!env.DAFTRA_API_KEY) throw new Error('DAFTRA_API_KEY is required');
  return { base, apiKey: env.DAFTRA_API_KEY };
}
async function readResponse(response) {
  if (!response.ok) throw new Error('Daftra request failed (HTTP ' + response.status + ')');
  return response.json();
}
async function apiGet(path, env = process.env, fetcher = fetch) {
  const { base, apiKey } = config(env);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/api2/')) throw new Error('API path denied');
  const response = await fetcher(url, {
    method: 'GET', redirect: 'manual',
    headers: { APIKEY: apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  return readResponse(response);
}
export function invoiceId(value) {
  const id = String(value);
  if (!/^[1-9][0-9]{0,14}$/.test(id)) throw new Error('Invalid invoice ID');
  return id;
}
export async function getInvoice(id, env, fetcher) {
  return apiGet('/api2/invoices/' + invoiceId(id) + '.json', env, fetcher);
}
export const READABLE_ENTITIES = Object.freeze({
  invoices: 'invoices',
  estimates: 'estimates',
  clients: 'clients',
  products: 'products',
  invoice_payments: 'invoice_payments',
  client_payments: 'client_payments',
  expenses: 'expenses',
});
export async function listRecords(entity, env, fetcher) {
  if (!Object.hasOwn(READABLE_ENTITIES, entity)) throw new Error('Entity not authorized');
  return apiGet('/api2/' + READABLE_ENTITIES[entity] + '.json', env, fetcher);
}
export async function getRecord(entity, id, env, fetcher) {
  if (!Object.hasOwn(READABLE_ENTITIES, entity)) throw new Error('Entity not authorized');
  return apiGet('/api2/' + READABLE_ENTITIES[entity] + '/' + invoiceId(id) + '.json', env, fetcher);
}
export async function listInvoices(env, fetcher) {
  return listRecords('invoices', env, fetcher);
}
export function pdfUrl(invoice, env = process.env) {
  const { base } = config(env);
  const candidate = invoice?.data?.Invoice?.invoice_pdf_url
    ?? invoice?.Invoice?.invoice_pdf_url
    ?? invoice?.data?.invoice_pdf_url;
  if (!candidate || typeof candidate !== 'string') throw new Error('Invoice has no PDF URL');
  const url = new URL(candidate);
  if (url.protocol !== 'https:' || url.origin !== base.origin || !/\.pdf$/i.test(url.pathname) || url.username || url.password)
    throw new Error('PDF URL is not a same-tenant HTTPS PDF');
  return url;
}
export async function downloadInvoicePdf(id, outPath, env = process.env, fetcher = fetch) {
  const invoice = await getInvoice(id, env, fetcher);
  const url = pdfUrl(invoice, env);
  // The PDF link may be hash-authenticated; never send the API key to a document URL.
  const response = await fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('PDF download failed (HTTP ' + response.status + ')');
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/pdf') && !contentType.includes('octet-stream')) throw new Error('Response is not PDF');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PDF_BYTES) throw new Error('PDF exceeds size limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new Error('Invalid or oversized PDF');
  await writeFile(resolve(outPath), bytes, { flag: 'wx', mode: 0o600 });
  return { path: resolve(outPath), size: bytes.byteLength };
}
if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const [command, id, output] = process.argv.slice(2);
  try {
    if (command === 'list') console.log(JSON.stringify(await listRecords(id || 'invoices')));
    else if (command === 'get') console.log(JSON.stringify(await getRecord(id || 'invoices', output)));
    else if (command === 'pdf' && output) console.log(JSON.stringify(await downloadInvoicePdf(id, output)));
    else throw new Error('Usage: node src/daftra-readonly.mjs list [entity] | get <entity> <id> | pdf <invoice-id> <output.pdf>');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
