// Classification of Daftra read failures. Source: the "Responses" sections of docs.daftara.dev (every /api2/reports/* page and the
// list/single pages), which define the meaning of each status. Nothing here is guessed:
//
//   400  validation   a parameter failed validation (`validation_errors` names it) or the report exceeded its size ceiling
//   401  unauthorized no / unrecognised credentials (arrives as text/html around a JSON body)
//   403  forbidden    "Authenticated, but not allowed". FOUR indistinguishable causes: plugin inactive, user lacks the permission,
//                     OAuth token without report.read, report not opted in to machine access for API keys. For entity reads: the API-key
//                     role (Only Allow / Only Block) or the account permission.
//   404  report       "The report is not exposed on this deployment. The allow-list is per deployment" -> NOT a permission problem.
//   404  record       no record with this id is accessible to the user (single GETs), or the path is not a route.
//   404  invalid_page a 404/4xx whose message is "Invalid page": the pagination request itself was refused.
//   405  method       wrong method (reads are GET only)
//   429  rate_limited throttled; retried
//   500  upstream_error the endpoint crashed server-side (detail is logged by Daftra, never returned)
//   502/503/504 transient gateway / database unavailable; retried
//
// `category` is the machine-readable class; `owner_action` is what a human with access to the Daftra account has to do (null when
// nothing the account owner can change would help).
export const CATEGORIES = Object.freeze([
  'validation', 'invalid_page', 'unauthorized', 'forbidden', 'report_not_exposed', 'not_found', 'method_not_allowed',
  'rate_limited', 'transient', 'upstream_error', 'unknown',
]);

const clean = (s, n) => String(s).replace(/[^\p{L}\p{N} .,:;()_\-\[\]=\/]/gu, '').slice(0, n);

// Reduce Daftra's `validation_errors` ({ param: "message" | ["message"] | {…} }) to a short, log-safe string.
export function summariseValidationErrors(errors) {
  if (errors === null || errors === undefined) return '';
  if (typeof errors === 'string') return clean(errors, 200);
  if (typeof errors !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(errors).slice(0, 8)) {
    let text = '';
    if (typeof value === 'string') text = value;
    else if (Array.isArray(value)) text = value.filter((v) => typeof v === 'string').join(' / ');
    else if (value && typeof value === 'object') text = Object.values(value).filter((v) => typeof v === 'string').join(' / ');
    parts.push(clean(key, 40) + (text ? '=' + clean(text, 100) : ''));
  }
  return parts.join('; ').slice(0, 400);
}

export function classifyFailure(status, { isReport = false, message = '' } = {}) {
  const msg = String(message ?? '');
  if (/invalid page/i.test(msg) && status >= 400 && status < 500) {
    return { category: 'invalid_page', retryable: false, owner_action: null,
      hint: 'Daftra refused the pagination request itself ("Invalid page"). It is not a permission problem. Retry the first page without limit/page, or without the filter that triggers it.' };
  }
  switch (status) {
    case 400: return { category: 'validation', retryable: false, owner_action: null,
      hint: isReport
        ? 'A parameter failed validation or the report exceeded its size ceiling. Daftra refuses unknown parameters instead of ignoring them; narrow the dates/filters and check the allowed values.'
        : 'A parameter was refused by Daftra. Check the allowed filters and values.' };
    case 401: return { category: 'unauthorized', retryable: false,
      owner_action: 'The broker\'s Daftra API key was not recognised. Check that the read key is still valid (Settings -> API -> API Key).',
      hint: 'No credentials, or credentials Daftra did not recognise.' };
    case 403: return { category: 'forbidden', retryable: false,
      owner_action: isReport
        ? 'Daftra gives one 403 for four causes: (1) the report\'s plugin is not active, (2) the API-key user lacks the report\'s permission (e.g. "View all journals", "View all expenses"), (3) an OAuth token without report.read, (4) the report is not enabled for machine/API-key access. Check these in Daftra for the key\'s user; do not widen the key\'s role beyond what is needed.'
        : 'The API key\'s role (Settings -> API -> API Key -> Roles: Only Allow / Only Block) or the key user\'s account permission does not cover this entity. Add only this entity to an "Only Allow" list or remove it from the "Only Block" list.',
      hint: 'Authenticated but not allowed (role, permission, inactive plugin or machine access). This is the ONLY status that means a missing permission.' };
    case 404: return isReport
      ? { category: 'report_not_exposed', retryable: false,
        owner_action: 'Nothing to change in the key. Daftra states the report allow-list is per deployment: this report is not exposed on this account\'s deployment. Ask Daftra support whether it can be enabled, or use the equivalent entity/report that is available.',
        hint: 'Daftra: "The report is not exposed on this deployment." This is NOT a permission problem (that would be 403) and not a code bug.' }
      : { category: 'not_found', retryable: false, owner_action: null,
        hint: 'No such record is accessible to this user (wrong id, record of another branch/staff, or the id is a document number rather than the internal id).' };
    case 405: return { category: 'method_not_allowed', retryable: false, owner_action: null, hint: 'Only GET is supported on read endpoints.' };
    case 429: return { category: 'rate_limited', retryable: true, owner_action: null, hint: 'Throttled by Daftra; retried automatically.' };
    case 500: return { category: 'upstream_error', retryable: false, owner_action: null,
      hint: 'Daftra failed while building this response (logged on their side, detail never returned). Try a narrower request or the list endpoint; report to Daftra support if it persists.' };
    case 502: case 503: case 504: return { category: 'transient', retryable: true, owner_action: null,
      hint: 'Temporary gateway/database unavailability at Daftra or between the broker and Daftra; retried automatically. Try again shortly.' };
    default: return { category: 'unknown', retryable: false, owner_action: null, hint: 'Unexpected HTTP status.' };
  }
}
