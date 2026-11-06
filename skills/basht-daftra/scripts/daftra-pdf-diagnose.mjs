// READ-ONLY diagnosis of a final "official PDF" response that is not a PDF.
// It answers ONE question: what kind of page did Daftra serve instead (login / invoice view / error / unknown)?
// The output is a fixed vocabulary: HTTP status, media type (no parameters), redirect count and a page class.
// The body is inspected in memory (first 64 KiB) and discarded: it is never stored, returned, logged or echoed,
// and neither is any URL, path, query or hash.

export const PAGE_KINDS = Object.freeze(['login', 'invoice_view', 'error', 'empty', 'not_html', 'unknown']);
const MAX_SNIFF_BYTES = 64 * 1024;

const TITLE_RE = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i;
const LOGIN_TEXT_RE = /log\s?in|sign\s?in|تسجيل\s+الدخول|تسجيل\s+دخول/i;
const PASSWORD_INPUT_RE = /<input\b[^>]*\btype\s*=\s*["']?password/i;
const ERROR_TEXT_RE = /\b(?:401|403|404|410|500|502|503)\b|not\s+found|forbidden|unauthori[sz]ed|access\s+denied|expired|invalid|\berror\b|غير\s+موجود|غير\s+مصرح|ممنوع|منتهي|غير\s+صالح|خطأ/i;
const INVOICE_TEXT_RE = /invoice|فاتورة/i;
const TOTALS_RE = /sub\s?total|grand\s?total|\btotal\b|الإجمالي|المجموع|الاجمالي/i;

export function mediaType(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase().replace(/[^a-z0-9.+\/-]/g, '').slice(0, 60) || 'none';
}

function isTextual(media) { return media === 'none' || media === 'text/html' || media === 'application/xhtml+xml' || media === 'text/plain'; }

// Pure classifier. `text` is the (already truncated) page; `loginPath` says the final hop's path looked like a login route.
// Returns one of PAGE_KINDS and nothing else. Order matters: login > error > invoice view.
export function classifyPage(text, { status = 200, loginPath = false } = {}) {
  const html = typeof text === 'string' ? text : '';
  if (!html.trim()) return 'empty';
  const title = (TITLE_RE.exec(html)?.[1] ?? '').trim();
  const h1 = (H1_RE.exec(html)?.[1] ?? '').replace(/<[^>]*>/g, ' ').trim();
  if (loginPath || PASSWORD_INPUT_RE.test(html) || LOGIN_TEXT_RE.test(title) || LOGIN_TEXT_RE.test(h1)) return 'login';
  if (status >= 400 || ERROR_TEXT_RE.test(title) || ERROR_TEXT_RE.test(h1)) return 'error';
  if (INVOICE_TEXT_RE.test(title) || (INVOICE_TEXT_RE.test(html) && /<table\b/i.test(html) && TOTALS_RE.test(html))) return 'invoice_view';
  return 'unknown';
}

async function sniff(response, cap = MAX_SNIFF_BYTES) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
  } finally { try { await reader.cancel(); } catch { /* already closed */ } }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, cap));
}

// Returns null when the response looks like a usable PDF (HTTP ok + PDF/octet-stream); otherwise
// { http_status, content_type, redirects, page }. Consumes (and discards) the body only in the non-PDF case.
export async function diagnosePdfResponse(response, { redirects = 0, landedOnLogin = false } = {}) {
  const media = mediaType(response.headers?.get?.('content-type'));
  if (response.ok && (media.includes('application/pdf') || media.includes('octet-stream'))) return null;
  let page = 'not_html';
  if (isTextual(media)) {
    try { page = classifyPage(await sniff(response), { status: response.status, loginPath: landedOnLogin }); }
    catch { page = landedOnLogin ? 'login' : 'unknown'; }
  }
  return { http_status: response.status, content_type: media, redirects, page };
}
