// BASHT/Daftra: intentionally read-only. No POST/PUT/PATCH/DELETE support in this module.
// (Approval-gated writes live in daftra-write.mjs behind a separate allowlist.)
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ENTITIES, REPORTS, buildQuery } from './daftra-entities.mjs';
import { extractList, extractOne, extractPage } from './daftra-normalize.mjs';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 50 * 1024 * 1024;
const RETRYABLE = new Set([429, 502, 503, 504]);

export class DaftraError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DaftraError';
    this.status = status;
  }
}

export function config(env = process.env) {
  let base;
  try { base = new URL(env.DAFTRA_BASE_URL || ''); } catch { throw new Error('DAFTRA_BASE_URL must be an HTTPS Daftra tenant root'); }
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.daftra.com') || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('DAFTRA_BASE_URL must be an HTTPS Daftra tenant root');
  }
  if (!env.DAFTRA_API_KEY) throw new Error('DAFTRA_API_KEY is required');
  return { base, apiKey: env.DAFTRA_API_KEY };
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

function retryDelayMs(response, attempt) {
  const raw = response.headers?.get?.('retry-after');
  const header = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, 10000);
  return Math.min(500 * 2 ** attempt, 4000);
}

// The ONLY network primitive of this module: GET, same tenant origin, /api2/ paths, no redirects.
async function apiGet(path, { query, env = process.env, fetcher = fetch, sleep = defaultSleep, retries = 3 } = {}) {
  const { base, apiKey } = config(env);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/api2/')) throw new Error('API path denied');
  if (query) for (const [k, v] of query) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(url, {
      method: 'GET', redirect: 'manual',
      headers: { APIKEY: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    // GET is idempotent, so throttling / transient gateway errors are safe to retry.
    if (RETRYABLE.has(response.status) && attempt < retries) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    return readResponse(response);
  }
}

async function readResponse(response) {
  if (!response.ok) {
    let detail = '';
    if (response.status >= 400 && response.status < 500) {
      try {
        const body = await response.json();
        if (typeof body?.message === 'string') detail = ': ' + body.message.replace(/[^\p{L}\p{N} .,:;()_\-]/gu, '').slice(0, 200);
      } catch { /* body is not JSON; status alone is enough */ }
    }
    throw new DaftraError('Daftra request failed (HTTP ' + response.status + ')' + detail, response.status);
  }
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new DaftraError('Daftra response too large', response.status);
  try { return JSON.parse(text); } catch { throw new DaftraError('Daftra returned non-JSON content', response.status); }
}

export function invoiceId(value) {
  const id = String(value);
  if (!/^[1-9][0-9]{0,14}$/.test(id)) throw new Error('Invalid invoice ID');
  return id;
}

export const READABLE_ENTITIES = Object.freeze(Object.fromEntries(
  Object.entries(ENTITIES).map(([name, spec]) => [name, spec.path])));

function entitySpec(entity) {
  if (typeof entity !== 'string' || !Object.hasOwn(ENTITIES, entity)) throw new Error('Entity not authorized');
  return ENTITIES[entity];
}

// One page, raw payload.
export async function listRecords(entity, env, fetcher, query = {}, extra = {}) {
  const spec = entitySpec(entity);
  return apiGet('/api2/' + spec.path + '.json', { query: buildQuery(spec.params, query), env, fetcher, ...extra });
}

export async function getRecord(entity, id, env, fetcher) {
  const spec = entitySpec(entity);
  return apiGet('/api2/' + spec.path + '/' + invoiceId(id) + '.json', { env, fetcher });
}

export async function getInvoice(id, env, fetcher) {
  return getRecord('invoices', id, env, fetcher);
}
export async function listInvoices(env, fetcher) {
  return listRecords('invoices', env, fetcher);
}

// A single page, validated, with an honest `complete` flag.
export async function listPage(entity, query, env, fetcher, extra) {
  return extractList(await listRecords(entity, env, fetcher, query, extra), entity);
}

export async function getOne(entity, id, env, fetcher) {
  return extractOne(await getRecord(entity, id, env, fetcher), entity);
}

// Walk every page and prove the result is the whole collection, or throw.
// Completeness means ALL of: page numbers arrive in order, page_count and total_results stay
// stable, every non-final page links to `next`, the final page does not, ids are unique,
// and the number of rows collected equals total_results.
export async function fetchAllRecords(entity, options = {}, env = process.env, fetcher = fetch) {
  const { query = {}, pageSize = 100, maxPages = 500, maxRecords = 50000, sleep = defaultSleep } = options;
  entitySpec(entity);
  if (Object.hasOwn(query, 'page') || Object.hasOwn(query, 'limit')) throw new Error('page and limit are managed by fetchAllRecords');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('pageSize must be 1-500');
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await walkPages(entity, query, pageSize, maxPages, maxRecords, env, fetcher, sleep);
    } catch (error) {
      if (!(error instanceof PaginationChanged)) throw error;
      lastError = error; // data changed while reading: restart once from page 1
    }
  }
  throw new Error('Export blocked: ' + lastError.message);
}

class PaginationChanged extends Error {}

async function walkPages(entity, query, pageSize, maxPages, maxRecords, env, fetcher, sleep) {
  const records = [];
  const seen = new Set();
  let total = null;
  let pageCount = null;
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error('Export blocked: more than ' + maxPages + ' pages; narrow the date range or filters');
    const payload = await listRecords(entity, env, fetcher, { ...query, limit: pageSize, page }, { sleep });
    const p = extractPage(payload, entity);
    if (p.total === null || p.pageCount === null || p.page === null)
      throw new Error('Export blocked: pagination metadata (page, page_count, total_results) missing; completeness cannot be proven');
    if (p.page !== page) throw new PaginationChanged('server returned page ' + p.page + ' for page ' + page);
    if (total === null) { total = p.total; pageCount = p.pageCount; }
    else if (p.total !== total || p.pageCount !== pageCount) throw new PaginationChanged('collection changed while reading');
    if (total > maxRecords) throw new Error('Export blocked: ' + total + ' records exceeds limit of ' + maxRecords);
    for (const record of p.records) {
      const id = record?.id;
      if (id !== undefined && id !== null) {
        const key = String(id);
        if (seen.has(key)) throw new PaginationChanged('duplicate record id across pages');
        seen.add(key);
      }
      records.push(record);
    }
    const last = pageCount === 0 || page >= pageCount;
    if (last) {
      if (p.hasNext) throw new PaginationChanged('final page still links to a next page');
      break;
    }
    if (!p.hasNext) throw new Error('Export blocked: page ' + page + ' of ' + pageCount + ' has no next link');
  }
  if (records.length !== total) throw new PaginationChanged('collected ' + records.length + ' of ' + total + ' records');
  return Object.freeze({
    records, entity, complete: true, count: records.length, total,
    pages: Math.max(pageCount, 1), warning: null, fetched_at: new Date().toISOString(),
  });
}

// Reports: GET /api2/reports/<name>, no `.json` suffix, not paginated, 400 above server size ceilings.
export async function getReport(name, params = {}, env, fetcher) {
  if (typeof name !== 'string' || !Object.hasOwn(REPORTS, name)) throw new Error('Report not authorized');
  const spec = REPORTS[name];
  for (const key of spec.required) if (params[key] === undefined || params[key] === '') throw new Error('Report parameter required: ' + key);
  const payload = await apiGet('/api2/reports/' + name, { query: buildQuery(spec.params, params), env, fetcher });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Daftra report response');
  return payload;
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

export function assertPdfBytes(bytes) {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.byteLength - 1024)));
  if (bytes.byteLength > MAX_PDF_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' || !tail.includes('%%EOF'))
    throw new Error('Invalid, truncated or oversized PDF');
}

// Official Daftra PDF (the invoice's own `invoice_pdf_url`). Never fabricated locally.
export async function downloadInvoicePdf(id, outPath, env = process.env, fetcher = fetch) {
  const invoice = await getInvoice(id, env, fetcher);
  const url = pdfUrl(invoice, env);
  // The PDF link is hash-authenticated; never send the API key to a document URL.
  const response = await fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('PDF download failed (HTTP ' + response.status + ')');
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/pdf') && !contentType.includes('octet-stream')) throw new Error('Response is not PDF');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PDF_BYTES) throw new Error('PDF exceeds size limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertPdfBytes(bytes);
  await writeFile(resolve(outPath), bytes, { flag: 'wx', mode: 0o600 });
  return { path: resolve(outPath), size: bytes.byteLength, source: 'daftra_official' };
}
