// THE experiment: can an operator-authorized session download Daftra's OFFICIAL invoice PDF?
// Two independent observations, metadata only (HTTP status, media type, size, %PDF/%%EOF checks, redirect flags):
//   1. browser: the logged-in page itself GETs /owner/invoices/view/<id>.pdf (or /invoices/view/<id>.pdf);
//   2. server : the exported cookies + the browser's User-Agent do ONE GET from this server (exactly what the broker would do later).
// The verdict tells which architecture is viable; no PDF byte, URL, cookie value or page text ever leaves this function.
export async function runPdfProof({ invoiceId, tenantOrigin, browserProbe, cookieHeader, serverFetch }) {
  if (!/^[1-9][0-9]{0,14}$/.test(String(invoiceId))) throw new Error('Invalid invoice id');
  const result = { invoice_id: String(invoiceId), tenant: new URL(tenantOrigin).hostname, browser: [], cookies: { count: 0, names: [] }, server: null, verdict: 'failed' };
  try { result.browser = (await browserProbe()) ?? []; } catch { result.browser = [{ error: 'probe_failed' }]; }
  const browserOk = result.browser.some((r) => r.pdf_magic === true && r.has_eof === true && r.http_status === 200);
  let header = null;
  try {
    const got = await cookieHeader();
    header = got.header; result.cookies = { count: got.names.length, names: got.names.slice(0, 12) };
  } catch { result.cookies = { count: 0, names: [], error: 'cookie_read_failed' }; }
  if (header) {
    try {
      const r = await serverFetch(header);
      result.server = r.kind === 'pdf'
        ? { kind: 'pdf', size: r.bytes.length, redirects: r.redirects, pdf_magic: true }
        : { kind: 'problem', expired: Boolean(r.expired), diagnostic: r.diagnostic ?? null };
    } catch { result.server = { kind: 'problem', error: 'server_fetch_failed' }; }
    header = null;
  } else result.server = { kind: 'skipped', reason: 'no_cookies' };
  const serverOk = result.server?.kind === 'pdf';
  const notSignedIn = result.browser.some((r) => r.final_is_root === true) && !browserOk;
  result.verdict = browserOk && serverOk ? 'both_ok' : browserOk ? 'browser_only' : serverOk ? 'server_only' : notSignedIn ? 'not_signed_in' : 'failed';
  return result;
}
