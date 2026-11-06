// Agent-side client for the SEPARATE-SERVICE broker (daftra-broker-service.mjs).
// SSRF guard on the CLIENT too: the URL must be a Railway private-network address
//   http://<service>.railway.internal:<port>
// (loopback is accepted only with DAFTRA_BROKER_ALLOW_LOOPBACK=1, for tests). No credentials/paths/queries in the URL,
// no redirects followed. The agent only ever holds DAFTRA_BROKER_TOKEN, which buys propose/show/status and nothing else.
import { writeFile } from 'node:fs/promises';
import { BrokerRefused } from './daftra-broker-client.mjs';
import { assertPdfBytes } from './daftra-readonly.mjs';

const MAX_RESPONSE = 4 * 1024 * 1024;
const ROUTES = Object.freeze({
  propose: '/v1/propose', propose_duplicate: '/v1/propose_duplicate', show: '/v1/show', status: '/v1/status',
  get: '/v1/get', invoice_pdf: '/v1/invoice_pdf',                       // keyless READ proxy (the agent holds no Daftra credential)
});
const MAX_RESPONSE_BY_CMD = Object.freeze({ get: 20 * 1024 * 1024, invoice_pdf: 30 * 1024 * 1024 });

export function validateServiceUrl(raw, env = process.env) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('DAFTRA_BROKER_URL is not a valid URL'); }
  const loopback = env.DAFTRA_BROKER_ALLOW_LOOPBACK === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  const privateName = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/.test(u.hostname);
  if (u.protocol !== 'http:' || (!privateName && !loopback)) throw new Error('DAFTRA_BROKER_URL must be http://<service>.railway.internal:<port> (Railway private network)');
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('DAFTRA_BROKER_URL must not contain credentials, a path or a query');
  if (!/^[1-9]\d{0,4}$/.test(u.port) || Number(u.port) > 65535) throw new Error('DAFTRA_BROKER_URL needs an explicit port');
  return u;
}

export async function callBrokerService({ url, token, cmd, body, env = process.env, fetcher = fetch, timeoutMs = 30_000 }) {
  const base = validateServiceUrl(url, env);
  if (typeof token !== 'string' || token.length < 32) throw new Error('DAFTRA_BROKER_TOKEN is missing or too short');
  const route = Object.hasOwn(ROUTES, cmd) ? ROUTES[cmd] : null;
  if (!route) throw new BrokerRefused('AGENT_CANNOT_APPROVE', 'This command is not available to the agent in service mode');
  const payload = JSON.stringify(body ?? {});
  if (Buffer.byteLength(payload) > 256 * 1024) throw new Error('Request too large for the broker');
  const response = await fetcher(new URL(route, base), {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: payload,
  }).catch((e) => { throw new Error('Cannot reach the broker service (' + (e.cause?.code || e.name || 'error') + ')'); });
  const cap = MAX_RESPONSE_BY_CMD[cmd] ?? MAX_RESPONSE;
  const text = await response.text();
  if (text.length > cap) throw new Error('Broker response too large');
  let reply; try { reply = JSON.parse(text); } catch { throw new Error('Broker returned invalid JSON (HTTP ' + response.status + ')'); }
  if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') throw new Error('Broker returned an invalid reply');
  if (!reply.ok) throw reply.refused ? new BrokerRefused(String(reply.refused), String(reply.error)) : new Error(String(reply.error));
  return reply.result;
}

// ---- keyless reads ---------------------------------------------------------------------------------------------
// A fetch-compatible shim: the existing in-process readers (listRecords, fetchAllRecords, getReport, statements, exports...)
// call fetcher(url, {method:'GET'}); in service mode that call becomes POST /v1/get on the broker. Only GET is accepted, only
// the pinned tenant's /api2 paths, nothing else (headers/method/URL) is ever forwarded. Upstream status codes are reproduced,
// including 429 + Retry-After, so the reader's own retry logic works unchanged.
export function createBrokerFetcher({ url, token, env = process.env, fetcher = fetch, timeoutMs }) {
  let tenantOrigin;
  try { tenantOrigin = new URL(env.DAFTRA_BASE_URL).origin; } catch { throw new Error('DAFTRA_BASE_URL is required (it is only used to build request paths; it is not a secret)'); }
  validateServiceUrl(url, env);
  return async function brokerFetch(input, options = {}) {
    const method = options?.method ?? 'GET';
    if (method !== 'GET') throw new BrokerRefused('AGENT_CANNOT_WRITE', 'Service mode reads are GET only; writes are proposals approved by the operator');
    const u = input instanceof URL ? input : new URL(String(input));
    if (u.origin !== tenantOrigin || !u.pathname.startsWith('/api2/')) throw new Error('Only the tenant /api2 read paths can be fetched through the broker');
    const query = {};
    for (const k of new Set(u.searchParams.keys())) {
      const all = u.searchParams.getAll(k);
      if (all.length !== 1) throw new Error('Repeated query parameter: ' + k);
      query[k] = all[0];
    }
    let result;
    try { result = await callBrokerService({ url, token, cmd: 'get', body: { path: u.pathname, query }, env, fetcher, timeoutMs }); }
    catch (e) {
      if (e instanceof BrokerRefused && ['RATE_LIMIT', 'CONCURRENCY'].includes(e.code)) return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } });
      throw e;
    }
    const headers = { 'content-type': 'application/json' };
    if (result.retry_after !== undefined) headers['retry-after'] = String(result.retry_after);
    const status = Number(result.status);
    const body = status >= 200 && status < 300 ? JSON.stringify(result.body)
      : JSON.stringify({ message: result.message ?? null, validation_errors: result.validation_errors ?? undefined, upstream_status: result.upstream_status ?? undefined });
    return new Response(body, { status, headers });
  };
}

// Official invoice PDF through the broker (the broker downloads it; the agent never sees a document link or a key).
export async function downloadInvoicePdfViaBroker({ id, outPath, url, token, env = process.env, fetcher = fetch }) {
  const reply = await callBrokerService({ url, token, cmd: 'invoice_pdf', body: { id: String(id) }, env, fetcher, timeoutMs: 60_000 });
  if (reply?.status !== 200 || typeof reply.base64 !== 'string') throw new Error('PDF not available: ' + String(reply?.message ?? 'unknown').slice(0, 120));
  const bytes = Buffer.from(reply.base64, 'base64');
  assertPdfBytes(new Uint8Array(bytes));
  await writeFile(outPath, bytes, { flag: 'wx', mode: 0o600 });
  return { path: outPath, size: bytes.length, source: 'daftra_official', draft: reply.draft === true, redirects: Number.isInteger(reply.redirects) ? reply.redirects : 0 };
}
