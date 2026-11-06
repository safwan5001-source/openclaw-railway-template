// READ PROXY of the separate-service broker. The agent holds NO Daftra credential: Daftra API-key roles are per ENTITY
// (Only Allow / Only Block lists), not per method, so any key that can read invoices can also create/edit/delete them.
// Every agent read therefore goes through the broker, which performs it with its own key and ONLY as a GET.
//
//   POST /v1/get         { path, query? }  -> upstream GET of an allowlisted /api2 path with an allowlisted query
//   POST /v1/invoice_pdf { id }            -> the invoice's official PDF (same-tenant link, downloaded WITHOUT the API key)
//
// Nothing the agent sends is forwarded verbatim: not headers, not a URL, not a method, not a host. The path must match a
// strict regex built from the registry in daftra-entities.mjs and the query is rebuilt with buildQuery() (allowlist + per-key
// validation), exactly as the in-process reader does.
import { ENTITIES, REPORTS, buildQuery, buildReportQuery } from './daftra-entities.mjs';
import { config, pdfUrl, assertPdfBytes, fetchOfficialPdfResponse, pdfResponseProblem, diagnosePdfResponse, invoiceIsDraft } from './daftra-readonly.mjs';
import { summariseValidationErrors } from './daftra-errors.mjs';

// Response caps: list/single-record reads 6 MiB (a page is <= 500 rows), reports 16 MiB (single response, no pagination).
export const MAX_LIST_RESPONSE = 6 * 1024 * 1024;
export const MAX_REPORT_RESPONSE = 16 * 1024 * 1024;
export const MAX_GET_RESPONSE = MAX_REPORT_RESPONSE;
export const MAX_LIMIT = 500;                       // page size clamp: bigger pages only stall the event loop
export const MAX_PDF = 20 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

export class BadRead extends Error {
  constructor(message) { super(message); this.name = 'BadRead'; this.code = 'BAD_REQUEST'; }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ENTITY_BY_PATH = new Map(Object.values(ENTITIES).map((e) => [e.path, e]));
const alt = (names) => names.map(escapeRe).join('|');
const LIST_RE = new RegExp('^/api2/(' + alt([...ENTITY_BY_PATH.keys()]) + ')\\.json$');
const ONE_RE = new RegExp('^/api2/(' + alt([...ENTITY_BY_PATH.keys()]) + ')/([1-9][0-9]{0,14})\\.json$');
const REPORT_RE = new RegExp('^/api2/reports/(' + alt(Object.keys(REPORTS)) + ')$');
const SAFE_PATH = /^\/[A-Za-z0-9_./-]{1,150}$/;           // no %, ?, #, \, whitespace, control characters, unicode

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

// -> { path, search: URLSearchParams, kind: 'list'|'one'|'report', name }
export function validateGet(body) {
  if (!isPlain(body)) throw new BadRead('Body must be an object');
  for (const k of Object.keys(body)) if (k !== 'path' && k !== 'query') throw new BadRead('Unexpected field: ' + String(k).slice(0, 30));
  const { path } = body;
  if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('..') || path.includes('//')) throw new BadRead('Path not allowed');
  const rawQuery = body.query === undefined ? {} : body.query;
  if (!isPlain(rawQuery)) throw new BadRead('query must be an object');
  for (const [k, v] of Object.entries(rawQuery)) {
    if (!(typeof v === 'string' || typeof v === 'number')) throw new BadRead('query values must be strings or numbers (' + String(k).slice(0, 30) + ')');
    if (typeof v === 'number' && !Number.isSafeInteger(v) && !Number.isFinite(v)) throw new BadRead('Invalid query value');
  }
  let m;
  if ((m = LIST_RE.exec(path))) {
    const spec = ENTITY_BY_PATH.get(m[1]);
    const search = guardedQuery(spec.params, rawQuery);
    const ceiling = Math.min(spec.maxLimit ?? MAX_LIMIT, MAX_LIMIT);                  // documented per-endpoint ceiling (journals: 100)
    if (search.has('limit') && Number(search.get('limit')) > ceiling) search.set('limit', String(ceiling));   // clamp (fetchAll's pageSize is <= 500)
    return { path, kind: 'list', name: m[1], search };
  }
  if ((m = ONE_RE.exec(path))) {
    if (Object.keys(rawQuery).length) throw new BadRead('A single-record read takes no query');
    return { path, kind: 'one', name: m[1], search: new URLSearchParams() };
  }
  if ((m = REPORT_RE.exec(path))) {
    // Same documented contract as the in-process reader (spelling aliases, enumerations, cross-parameter rules, special branch/cost-centre values).
    let search;
    try { search = buildReportQuery(m[1], rawQuery); } catch (e) { throw new BadRead(String(e.message).slice(0, 300)); }
    return { path, kind: 'report', name: m[1], search };
  }
  throw new BadRead('Path not allowed');
}
function guardedQuery(allowed, query) {
  try { return buildQuery(allowed, query); } catch (e) { throw new BadRead(String(e.message).slice(0, 120)); }
}

async function readCapped(response, cap) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > cap) { try { await response.body?.cancel?.(); } catch { /* ignore */ } throw new BadRead('Upstream response too large'); }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > cap) throw new BadRead('Upstream response too large');
    return Buffer.from(text);
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } throw new BadRead('Upstream response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const clean = (s, n = 200) => String(s).replace(/[^\p{L}\p{N} .,:;()_\-]/gu, '').slice(0, n);
const validationDigest = (errors) => summariseValidationErrors(errors);

// The ONLY upstream primitive of the read proxy: GET, pinned tenant origin, /api2 path (validated above), redirect:'manual'.
// Returns what the agent-side reader needs to behave exactly as if it had called Daftra itself:
//   { status, body, retry_after?, message? }   (status 200..299 -> body is the parsed JSON)
export async function performGet(validated, { env, fetcher = fetch }) {
  const { base, apiKey } = config(env);
  const url = new URL(validated.path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/api2/')) throw new BadRead('Path not allowed');
  for (const [k, v] of validated.search) url.searchParams.set(k, v);
  const response = await fetcher(url, { method: 'GET', redirect: 'manual', headers: { APIKEY: apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  const status = response.status;
  if (status >= 300 && status < 400) return { status: 502, body: null, message: 'Upstream redirect refused' };
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    const ra = Number(response.headers?.get?.('retry-after'));
    try { await response.body?.cancel?.(); } catch { /* ignore */ }
    return { status, body: null, retry_after: Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 10) : undefined, ...(status !== 429 ? { upstream_status: status } : {}) };
  }
  const raw = await readCapped(response, validated.kind === 'report' ? MAX_REPORT_RESPONSE : MAX_LIST_RESPONSE);   // size guard BEFORE JSON.parse
  let json = null; try { json = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
  if (status >= 200 && status < 300) {
    if (json === null) return { status: 502, body: null, message: 'Upstream returned non-JSON content' };
    return { status, body: json };
  }
  // 4xx: Daftra's own message and (for 400) the named invalid parameters, so the agent can tell a bad parameter from a missing permission.
  if (status >= 400 && status < 500) return { status, body: null, message: typeof json?.message === 'string' ? clean(json.message) : undefined, ...(status === 400 && json?.validation_errors ? { validation_errors: validationDigest(json.validation_errors) } : {}) };
  // Any other 5xx stays a 502 toward the agent (never forwarded verbatim) but now says what Daftra really answered, so a Daftra 500 is not
  // mistaken for a transient gateway fault.
  return { status: 502, body: null, message: 'Upstream error', upstream_status: status };
}

export function validateInvoicePdfRequest(body) {
  if (!isPlain(body)) throw new BadRead('Body must be an object');
  for (const k of Object.keys(body)) if (k !== 'id') throw new BadRead('Unexpected field: ' + String(k).slice(0, 30));
  const id = typeof body.id === 'number' ? String(body.id) : body.id;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,14}$/.test(id)) throw new BadRead('Invalid invoice id');
  return id;
}

// Official PDF: invoice -> invoice_pdf_url (same tenant, https, *.pdf, no credentials) -> download WITHOUT the API key.
export async function fetchInvoicePdf(id, { env, fetcher = fetch }) {
  const got = await performGet(validateGet({ path: '/api2/invoices/' + id + '.json' }), { env, fetcher });
  if (got.status !== 200 || !got.body) return { status: got.status === 200 ? 502 : got.status, message: got.message ?? 'Invoice not available' };
  let url;
  try { url = pdfUrl(got.body, env); } catch (e) { return { status: 422, message: clean(e.message) }; }
  const draft = invoiceIsDraft(got.body);
  let fetched;
  try { fetched = await fetchOfficialPdfResponse(url, { env, fetcher }); } catch (e) { return { status: 502, message: clean(e.message), draft }; }
  const { response, redirects, landedOnLogin } = fetched;
  const diagnostic = await diagnosePdfResponse(response, { redirects, landedOnLogin });
  const problem = diagnostic && pdfResponseProblem(response, { draft, redirects, landedOnLogin, page: diagnostic.page });
  if (problem) return { status: 502, message: problem, draft, diagnostic };   // diagnostic: status / media type / redirects / page class only
  let bytes;
  try { bytes = await readCapped(response, MAX_PDF); } catch (e) { return { status: 502, message: clean(e.message) }; }
  try { assertPdfBytes(new Uint8Array(bytes)); } catch (e) { return { status: 502, message: clean(e.message) }; }
  return { status: 200, size: bytes.length, base64: bytes.toString('base64'), draft, redirects };
}
