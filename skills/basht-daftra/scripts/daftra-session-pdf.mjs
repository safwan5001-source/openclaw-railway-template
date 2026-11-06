// Official Daftra PDF through the operator's own, already-authorized Daftra session (see daftra-session-store.mjs).
//
// This is NOT a browser and NOT a login: it is one read-only HTTPS GET of the invoice's PDF page, exactly what the Daftra UI's
// "download PDF" does, carrying the cookie the operator pasted. Hard limits, all enforced here:
//   * method GET only; the URL is built from the tenant origin + a validated numeric id + one of TWO fixed paths (never from input);
//   * the cookie is sent ONLY to the tenant host (https, default port); no API key, no Authorization header;
//   * redirects are never followed blindly: a redirect to a login route ends the attempt WITHOUT being requested ("session expired"),
//     a redirect to the same invoice's PDF/view path is followed (max 3), anything else is refused;
//   * nothing is returned or thrown that contains a URL, path, cookie, hash or page content: only status / media type / redirect
//     count / page class (daftra-pdf-diagnose.mjs).
import { config, assertPdfBytes } from './daftra-readonly.mjs';
import { diagnosePdfResponse } from './daftra-pdf-diagnose.mjs';

const MAX_PDF = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const LOGIN_PATH_RE = /(^|\/)(login|log-in|signin|sign-in|sign_in|auth)(\/|$|\.)/i;
export const SESSION_PDF_PATHS = Object.freeze((id) => [`/owner/invoices/view/${id}.pdf`, `/invoices/view/${id}.pdf`]);

async function readCapped(response, cap) {
  const reader = response.body?.getReader?.();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* closed */ } throw new Error('PDF exceeds size limit'); }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

function problem(message, diagnostic, { expired = false } = {}) { return { kind: 'problem', message, diagnostic, expired }; }

// Returns { kind: 'pdf', bytes, redirects } or { kind: 'problem', message, diagnostic, expired }.
export async function fetchSessionPdf(id, { cookieHeader, env = process.env, fetcher = fetch } = {}) {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,14}$/.test(id)) throw new Error('Invalid invoice id');
  if (typeof cookieHeader !== 'string' || !cookieHeader) throw new Error('No Daftra session');
  const { base } = config(env);
  const host = base.hostname.toLowerCase();
  const allowedRedirect = new RegExp('^/(?:owner/)?invoices/(?:view|download|pdf|preview)/' + id + '(?:\\.pdf)?$');
  let last = null;
  for (const path of SESSION_PDF_PATHS(id)) {
    let current = new URL(path, base.origin);
    let hops = 0; let response;
    for (;; hops++) {
      response = await fetcher(current, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { Cookie: cookieHeader, Accept: 'application/pdf,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 (compatible; BASHT-Broker/1.0)' },
      });
      if (!REDIRECT_STATUS.has(response.status)) break;
      try { await response.body?.cancel?.(); } catch { /* closed */ }
      const location = response.headers?.get?.('location');
      let next = null;
      try { if (location && location.length <= 2048 && !/[\u0000-\u001f\u007f\\]/.test(location)) next = new URL(location, current); } catch { next = null; }
      const diag = { http_status: response.status, content_type: 'none', redirects: hops + 1 };
      if (!next || next.protocol !== 'https:' || next.hostname.toLowerCase() !== host || next.port !== '' || next.username || next.password)
        return problem('Daftra redirected the PDF request to an unexpected destination [HTTP ' + response.status + ', ' + (hops + 1) + ' redirect(s)]', { ...diag, page: 'unknown' });
      if (LOGIN_PATH_RE.test(next.pathname))                    // not requested: the session is simply not accepted
        return problem('Daftra session expired or rejected [HTTP ' + response.status + ', ' + (hops + 1) + ' redirect(s), page=login]: reconnect it in the operator console', { ...diag, page: 'login' }, { expired: true });
      if (!allowedRedirect.test(next.pathname))
        return problem('Daftra redirected the PDF request to an unexpected page [HTTP ' + response.status + ', ' + (hops + 1) + ' redirect(s)]', { ...diag, page: 'unknown' });
      if (hops >= MAX_REDIRECTS) return problem('PDF download failed: too many redirects', { ...diag, page: 'unknown' });
      next.hash = ''; current = next;
    }
    const diagnostic = await diagnosePdfResponse(response, { redirects: hops });
    if (!diagnostic) {
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_PDF) return problem('PDF exceeds size limit', { http_status: response.status, content_type: 'application/pdf', redirects: hops, page: 'not_html' });
      let bytes;
      try { bytes = await readCapped(response, MAX_PDF); assertPdfBytes(bytes); }
      catch (e) { return problem(String(e.message).slice(0, 80), { http_status: response.status, content_type: 'application/pdf', redirects: hops, page: 'not_html' }); }
      return { kind: 'pdf', bytes, redirects: hops };
    }
    if (diagnostic.page === 'login')
      return problem('Daftra session expired or rejected [HTTP ' + diagnostic.http_status + ', ' + diagnostic.content_type + ', ' + hops + ' redirect(s), page=login]: reconnect it in the operator console', diagnostic, { expired: true });
    last = diagnostic;                                         // 404 / error / HTML view: try the other fixed path
  }
  return problem('Daftra did not return a PDF for this invoice [HTTP ' + last.http_status + ', ' + last.content_type + ', ' + last.redirects + ' redirect(s), page=' + last.page + ']', last);
}
