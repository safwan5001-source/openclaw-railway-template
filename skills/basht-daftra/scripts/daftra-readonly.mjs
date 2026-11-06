// BASHT/Daftra: intentionally read-only. No POST/PUT/PATCH/DELETE support in this module.
// (Approval-gated writes live in daftra-write.mjs behind a separate allowlist.)
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ENTITIES, REPORTS, buildQuery, buildReportQuery, normalizeReportParams } from './daftra-entities.mjs';
import { extractList, extractOne, extractPage, extractUnpaged } from './daftra-normalize.mjs';
import { classifyFailure, summariseValidationErrors } from './daftra-errors.mjs';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 50 * 1024 * 1024;
const RETRYABLE = new Set([429, 502, 503, 504]);

// `category` / `hint` / `owner_action` come from classifyFailure() (daftra-errors.mjs); `validationErrors` is Daftra's own
// `validation_errors` summarised for 400 responses. They let a caller tell a bad parameter from a missing permission from a
// report that this deployment does not expose from a temporary outage, instead of guessing from a bare status code.
export class DaftraError extends Error {
  constructor(message, status, info = {}) {
    super(message);
    this.name = 'DaftraError';
    this.status = status;
    if (info.category) {
      this.category = info.category;
      this.hint = info.hint;
      this.owner_action = info.owner_action ?? null;
      this.retryable = Boolean(info.retryable);
    }
    if (info.validationErrors) this.validationErrors = info.validationErrors;
    if (info.upstreamStatus) this.upstreamStatus = info.upstreamStatus;
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
    return readResponse(response, url.pathname.startsWith('/api2/reports/'));
  }
}

async function readResponse(response, isReport = false) {
  if (!response.ok) {
    let detail = '';
    let message = '';
    let validationErrors = '';
    let upstreamStatus;
    // 4xx carries Daftra's own explanation; the broker shim also forwards `upstream_status` for a masked 5xx.
    if (response.status >= 400) {
      try {
        const body = await response.json();
        if (typeof body?.message === 'string') {
          message = body.message.replace(/[^\p{L}\p{N} .,:;()_\-]/gu, '').slice(0, 200);
          if (response.status < 500) detail = ': ' + message;
        }
        if (response.status === 400) validationErrors = summariseValidationErrors(body?.validation_errors ?? body?.errors);
        if (Number.isSafeInteger(body?.upstream_status) && body.upstream_status >= 500 && body.upstream_status < 600) upstreamStatus = body.upstream_status;
      } catch { /* body is not JSON; status alone is enough */ }
    }
    if (validationErrors) detail += ' [validation_errors: ' + validationErrors + ']';
    // A broker-masked upstream 500 arrives as 502; classify by what Daftra really answered.
    const effective = upstreamStatus === 500 && response.status === 502 ? 500 : response.status;
    const info = classifyFailure(effective, { isReport, message });
    throw new DaftraError('Daftra request failed (HTTP ' + effective + ')' + detail, effective, { ...info, validationErrors, upstreamStatus });
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
  const search = buildQuery(spec.params, query);
  // Documented per-endpoint ceiling (e.g. journals: 100). Larger page sizes are clamped, never forwarded.
  if (spec.maxLimit && search.has('limit') && Number(search.get('limit')) > spec.maxLimit) search.set('limit', String(spec.maxLimit));
  return apiGet('/api2/' + spec.path + '.json', { query: search, env, fetcher, ...extra });
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
  if (entitySpec(entity).unpaginated) return extractUnpaged(await listRecords(entity, env, fetcher, query, extra), entity);
  return extractList(await listRecords(entity, env, fetcher, query, extra), entity);
}

export async function getOne(entity, id, env, fetcher) {
  return extractOne(await getRecord(entity, id, env, fetcher), entity);
}

// Small reference collections whose single-record GET may fail on Daftra's side while the documented list endpoint (same model, same
// permission) still answers. For these, a 5xx on `GET /<entity>/<id>.json` falls back to the COMPLETE list (proven complete by
// fetchAllRecords) and picks the row by id. The caller is told which source answered; nothing is invented when the row is absent.
const SINGLE_FALLBACK_TO_LIST = new Set(['treasuries', 'product_categories', 'journal_cats', 'journal_accounts']);

export async function getOneDetailed(entity, id, env, fetcher, { sleep } = {}) {
  try {
    return { record: await getOne(entity, id, env, fetcher), source: 'single' };
  } catch (error) {
    const recoverable = error instanceof DaftraError && (error.category === 'transient' || error.category === 'upstream_error');
    if (!recoverable || !SINGLE_FALLBACK_TO_LIST.has(entity)) throw error;
    const wanted = invoiceId(id);
    let all;
    try { all = await fetchAllRecords(entity, { sleep }, env, fetcher); } catch { throw error; }   // list failed too: report the original failure
    const hit = all.records.find((r) => String(r?.id) === wanted);
    if (!hit) throw new DaftraError('Daftra request failed (HTTP 404): ' + entity + ' id ' + wanted + ' is not in the complete list', 404, classifyFailure(404));
    return { record: hit, source: 'list_fallback', note: 'The single-record endpoint failed (' + error.category + '); this row comes from the complete ' + entity + ' list (' + all.count + ' rows) and may omit single-record-only fields.' };
  }
}

// Walk every page and prove the result is the whole collection, or throw.
// Completeness means ALL of: page numbers arrive in order, page_count and total_results stay
// stable, every non-final page links to `next`, the final page does not, ids are unique,
// and the number of rows collected equals total_results.
export async function fetchAllRecords(entity, options = {}, env = process.env, fetcher = fetch) {
  const { query = {}, pageSize = 100, maxPages = 500, maxRecords = 50000, sleep = defaultSleep } = options;
  const spec = entitySpec(entity);
  if (Object.hasOwn(query, 'page') || Object.hasOwn(query, 'limit')) throw new Error('page and limit are managed by fetchAllRecords');
  if (spec.unpaginated) {
    // Single request, no page/limit. Only returned when the response proves completeness; otherwise blocked.
    const page = extractUnpaged(await listRecords(entity, env, fetcher, query, { sleep }), entity);
    if (!page.complete) throw new Error('Export blocked: ' + page.warning);
    return Object.freeze({ records: page.records, entity, complete: true, count: page.count, total: page.total, pages: 1, warning: null, fetched_at: new Date().toISOString() });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('pageSize must be 1-500');
  if (spec.maxLimit && pageSize > spec.maxLimit) options = { ...options, pageSize: spec.maxLimit };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await walkPages(entity, query, options.pageSize ?? pageSize, maxPages, maxRecords, env, fetcher, sleep);
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
  let sizeParam = true;
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error('Export blocked: more than ' + maxPages + ' pages; narrow the date range or filters');
    let payload;
    try {
      payload = await listRecords(entity, env, fetcher, { ...query, ...(sizeParam ? { limit: pageSize } : {}), page }, { sleep });
    } catch (error) {
      // Daftra answered the FIRST page with "Invalid page". Pagination is not a permission problem, so retry the bare request
      // (server-default page size, no page number) once; completeness is still proven below from the returned metadata.
      if (!(page === 1 && error instanceof DaftraError && error.category === 'invalid_page')) throw error;
      sizeParam = false;
      try { payload = await listRecords(entity, env, fetcher, { ...query }, { sleep }); } catch { throw error; }
    }
    const p = extractPage(payload, entity);
    if (p.total === null || p.pageCount === null || p.page === null)
      throw new Error('Export blocked: pagination metadata (page, page_count, total_results) missing; completeness cannot be proven');
    if (p.page !== page && !(p.total === 0 && p.records.length === 0)) throw new PaginationChanged('server returned page ' + p.page + ' for page ' + page);
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

// Reports: GET /api2/reports/<name>, no `.json` suffix. All are single-response and "bounded" (HTTP 400
// above the server's size ceilings instead of truncating) EXCEPT `financial_transactions`, which is paged
// (300 rows/page, pagination { page, per_page, total_rows, total_pages }, per-page totals).
export const PAGED_REPORTS = Object.freeze(['financial_transactions']);

export function isPartialReport(name, params = {}) {
  return PAGED_REPORTS.includes(name) && params.page !== undefined;
}

async function reportRequest(name, params, env, fetcher, sleep) {
  const payload = await apiGet('/api2/reports/' + name, { query: buildReportQuery(name, params), env, fetcher, sleep });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Daftra report response');
  return payload;
}

const posInt = (v) => Number.isSafeInteger(v) && v >= 0;

async function walkReportPages(name, params, env, fetcher, sleep) {
  const maxPages = 200;
  const rows = [];
  let first = null; let totalPages = null; let totalRows = null;
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error('Report blocked: more than ' + maxPages + ' pages; narrow the date range');
    const payload = await reportRequest(name, { ...params, page }, env, fetcher, sleep);
    const pg = payload.pagination;
    if (!pg || !posInt(pg.page) || !posInt(pg.total_pages) || !posInt(pg.total_rows) || !Array.isArray(payload.rows))
      throw new Error('Report blocked: pagination metadata (page, total_pages, total_rows) missing; completeness cannot be proven');
    if (pg.page !== page) throw new Error('Report blocked: server returned page ' + pg.page + ' for page ' + page);
    if (first === null) { first = payload; totalPages = pg.total_pages; totalRows = pg.total_rows; }
    else if (pg.total_pages !== totalPages || pg.total_rows !== totalRows) throw new Error('Report blocked: report changed while reading');
    rows.push(...payload.rows);
    if (page >= totalPages) break;
  }
  if (rows.length !== totalRows) throw new Error('Report blocked: collected ' + rows.length + ' of ' + totalRows + ' rows');
  // Per-page totals/opening balance of later pages are meaningless when merged: keep the first page's
  // opening balance only and drop `totals` so nobody mistakes page-1 totals for the whole report.
  const { totals: _pageTotals, pagination: _pagination, ...rest } = first;
  return { ...rest, rows, pagination: { pages: Math.max(totalPages, 1), total_rows: totalRows, complete: true }, totals_note: 'Per-page totals omitted when pages are merged' };
}

export async function getReport(name, rawParams = {}, env, fetcher, { sleep = defaultSleep } = {}) {
  if (typeof name !== 'string' || !Object.hasOwn(REPORTS, name)) throw new Error('Report not authorized');
  const spec = REPORTS[name];
  // Documented spellings/enumerations/cross-parameter rules are applied (and violations explained) BEFORE any request is made.
  const params = normalizeReportParams(name, rawParams);
  for (const key of spec.required) if (params[key] === undefined || params[key] === '') throw new Error('Report parameter required: ' + key);
  if (PAGED_REPORTS.includes(name) && params.page === undefined) return walkReportPages(name, params, env, fetcher, sleep);
  return reportRequest(name, params, env, fetcher, sleep);
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
