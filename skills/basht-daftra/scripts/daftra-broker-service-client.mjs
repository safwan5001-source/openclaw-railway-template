// Agent-side client for the SEPARATE-SERVICE broker (daftra-broker-service.mjs).
// SSRF guard on the CLIENT too: the URL must be a Railway private-network address
//   http://<service>.railway.internal:<port>
// (loopback is accepted only with DAFTRA_BROKER_ALLOW_LOOPBACK=1, for tests). No credentials/paths/queries in the URL,
// no redirects followed. The agent only ever holds DAFTRA_BROKER_TOKEN, which buys propose/show/status and nothing else.
import { BrokerRefused } from './daftra-broker-client.mjs';

const MAX_RESPONSE = 4 * 1024 * 1024;
const ROUTES = Object.freeze({ propose: '/v1/propose', propose_duplicate: '/v1/propose_duplicate', show: '/v1/show', status: '/v1/status' });

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
  const text = await response.text();
  if (text.length > MAX_RESPONSE) throw new Error('Broker response too large');
  let reply; try { reply = JSON.parse(text); } catch { throw new Error('Broker returned invalid JSON (HTTP ' + response.status + ')'); }
  if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') throw new Error('Broker returned an invalid reply');
  if (!reply.ok) throw reply.refused ? new BrokerRefused(String(reply.refused), String(reply.error)) : new Error(String(reply.error));
  return reply.result;
}
