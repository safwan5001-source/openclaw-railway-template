// Normalise only a known Daftra list shape; fail closed on unclear pagination.
// This module neither calls Daftra nor writes financial data.
//
// Official pagination block (docs.daftara.dev, every list endpoint):
//   pagination: { prev, next, page, page_count, total_results }
// `total_results` counts ALL matching rows across ALL pages, so a single response is
// "complete" only when it is page 1 of 1 and holds exactly `total_results` rows.
// Multi-page collections are assembled by fetchAllRecords() in daftra-readonly.mjs.
import { ENTITIES } from './daftra-entities.mjs';

const UINT = /^(0|[1-9]\d{0,14})$/;

// Strict non-negative integer: accepts integers and canonical digit strings only
// (Number('') === 0 and Number(true) === 1 would otherwise slip through).
function toUint(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && UINT.test(value)) return Number(value);
  throw Error('Invalid ' + field);
}

export function parsePagination(payload, itemCount) {
  const pagination = payload.pagination ?? payload.meta?.pagination ?? null;
  if (pagination !== null && (typeof pagination !== 'object' || Array.isArray(pagination))) throw Error('Invalid pagination');
  const rawTotal = pagination?.total_results ?? payload.total_results ?? pagination?.total ?? payload.total ?? null;
  const total = rawTotal === null ? null : toUint(rawTotal, 'pagination');
  if (total !== null && total < itemCount) throw Error('Invalid pagination');
  const pageCount = pagination?.page_count === undefined || pagination?.page_count === null
    ? null : toUint(pagination.page_count, 'page_count');
  const page = pagination?.page === undefined || pagination?.page === null
    ? null : toUint(pagination.page, 'page');
  // An empty collection may legitimately report page_count 0; anything else must be >= 1.
  if (pageCount !== null && pageCount < 1 && !(pageCount === 0 && total === 0)) throw Error('Invalid page_count');
  // An EMPTY collection (total 0, no rows) may report page 0 or page 1 / page_count 0 depending on the endpoint; that is not a malformed
  // page. Every non-empty response still needs page >= 1.
  const emptyCollection = total === 0 && itemCount === 0;
  if (page !== null && page < 1 && !(page === 0 && emptyCollection)) throw Error('Invalid page');
  if (page !== null && pageCount !== null && pageCount >= 1 && page > pageCount) throw Error('Invalid page');
  const next = pagination?.next ?? null;
  if (next !== null && typeof next !== 'string') throw Error('Invalid pagination');
  return { total, pageCount, page, hasNext: next !== null && next !== '' };
}

export function extractPage(payload, entity) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid Daftra response');
  if (!Object.hasOwn(ENTITIES, entity)) throw Error('Unsupported entity');
  const key = ENTITIES[entity].model;
  // An API schema may vary by version. Do not silently output zero records for unknown responses.
  const root = payload.data;
  if (!Array.isArray(root)) throw Error('Unrecognised list response: expected data array');
  const records = root.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('Invalid row');
    const model = entry[key];
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw Error('Missing model ' + key);
    return model;
  });
  return { records, ...parsePagination(payload, records.length) };
}

// A single response is a complete report only if it is provably the whole collection.
export function extractList(payload, entity) {
  const { records, total, pageCount, page, hasNext } = extractPage(payload, entity);
  const knownComplete = total !== null && total === records.length
    && (pageCount === null || pageCount === 1 || (pageCount === 0 && total === 0))
    && (page === null || page === 1 || (page === 0 && total === 0))
    && !hasNext;
  return Object.freeze({
    records,
    entity,
    complete: knownComplete,
    count: records.length,
    total,
    warning: knownComplete ? null : 'Pagination not proven complete: do not call this a full report',
  });
}

// Unpaginated collections (entity spec `unpaginated: true`, e.g. taxes). Source: Daftra docs 15115346e0 ("GET All Taxes"):
// "Results are not paginated - every tax is returned in a single response; the `pagination` object is included only for
// envelope consistency". Therefore completeness is proven by the RESPONSE CONTRACT, never by pagination counters:
//   - envelope: object; code === 200; result, when present, is a success string ('success' / 'successful', case-insensitive)
//   - data: array (may be empty); each element has the model key with a unique positive-integer id (name, if present, is a non-empty string)
//   - value: numeric string/number; is_active (if present): 0 or 1
// `pagination` is ignored (any values, including contradictory ones, are not an error for this endpoint).
// Body completeness (not truncated) is enforced by the transport: readResponse() parses the full body as JSON.
const SUCCESS_RESULT = /^success(ful)?$/i;
const POSITIVE_ID = /^[1-9][0-9]{0,14}$/;

export function extractUnpaged(payload, entity) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid Daftra response: envelope is not an object');
  if (!Object.hasOwn(ENTITIES, entity)) throw Error('Unsupported entity');
  const key = ENTITIES[entity].model;
  const code = payload.code;
  if (!(code === 200 || code === '200')) throw Error('Invalid Daftra response: envelope code is ' + String(code).slice(0, 20));
  // `result` is informational: some envelopes (and the offline fake) omit it. When present it must say success.
  if (payload.result !== undefined && (typeof payload.result !== 'string' || !SUCCESS_RESULT.test(payload.result))) throw Error('Invalid Daftra response: envelope result is not success');
  if (!Array.isArray(payload.data)) throw Error('Unrecognised list response: expected data array');
  const seen = new Set();
  const records = payload.data.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('Invalid row');
    const model = entry[key];
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw Error('Missing model ' + key);
    const id = String(model.id ?? '');
    if (!POSITIVE_ID.test(id)) throw Error('Invalid ' + key + ' id');
    if (seen.has(id)) throw Error('Duplicate ' + key + ' id ' + id + ' in one response');
    seen.add(id);
    if (model.name !== undefined && (typeof model.name !== 'string' || model.name.trim() === '')) throw Error('Invalid ' + key + ' name for id ' + id);
    if (!(typeof model.value === 'string' || typeof model.value === 'number') || !/^\d{1,3}(\.\d{1,4})?$/.test(String(model.value)))
      throw Error('Invalid ' + key + ' value for id ' + id);
    if (model.is_active !== undefined && !['0', '1', 0, 1].includes(model.is_active)) throw Error('Invalid ' + key + ' is_active for id ' + id);
    return model;
  });
  return Object.freeze({ records, entity, complete: true, count: records.length, total: records.length, warning: null });
}

// GET /api2/<entity>/<id>.json -> { data: { <Model>: {...}, ... } }
export function extractOne(payload, entity) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid Daftra response');
  if (!Object.hasOwn(ENTITIES, entity)) throw Error('Unsupported entity');
  const key = ENTITIES[entity].singleModel ?? ENTITIES[entity].model;
  const model = payload.data?.[key];
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw Error('Missing model ' + key);
  return model;
}

export function pickColumns(records, columns) {
  if (!Array.isArray(records) || !Array.isArray(columns)) throw Error('Invalid arguments');
  if (columns.length < 1 || columns.length > 100 || columns.some(c => !/^[a-zA-Z0-9_]+$/.test(c))) throw Error('Invalid columns');
  return records.map(record => Object.fromEntries(columns.map(col => [col, record?.[col] ?? null])));
}

// Daftra list rows can carry secrets: invoices include `password` plus hash-authenticated
// `invoice_pdf_url` / `invoice_html_url` links. These must never reach an export or a chat reply
// unless the caller explicitly allowlists the column (and even then URLs/passwords stay blocked).
// Keys are normalised (lower-case, no `_`/`-`/spaces) so accessToken, access-token and passwordConfirm match too.
const SENSITIVE_NORMALISED = /(password|passwd|token|secret|apikey|hash|signature|credential)|(url|link|uri)$/;
// Values: any URL carrying a credential-looking query parameter is dropped even under an innocent key.
const SENSITIVE_VALUE = /^https?:\/\/\S*[?&](hash|token|key|signature|sig|apikey|access_token)=/i;
export function isSensitiveKey(key) { return SENSITIVE_NORMALISED.test(String(key).toLowerCase().replace(/[\s_-]+/g, '')); }
export function redactRecord(value) {
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k, v]) => !isSensitiveKey(k) && !(typeof v === 'string' && SENSITIVE_VALUE.test(v))).map(([k, v]) => [k, redactRecord(v)]));
  }
  return value;
}
