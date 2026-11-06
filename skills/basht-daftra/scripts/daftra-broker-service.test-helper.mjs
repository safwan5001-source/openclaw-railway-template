// Test harness for the separate-service broker: real HTTP on loopback, FakeDaftra behind it, a controllable clock,
// a scripted operator (password + TOTP, cookie jar, CSRF) and a scripted agent. Never talks to the network.
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { createBrokerService } from './daftra-broker-service.mjs';
import { deriveTotpSecret, totpCode, stepAt } from './daftra-operator-auth.mjs';

export const WRITE_KEY = 'WRITE-KEY-service-aaaaaaaaaaaaaaaa';
export const READ_KEY = 'READ-KEY-agent-bbbbbbbbbbbbbbbbbb';
export const OP_SECRET = 'approval-hmac-secret-0123456789-0123456789-abcdef';
export const AGENT_TOKEN = 'agent-token-0123456789-0123456789-0123456789';
export const AGENT_TOKEN_PREVIOUS = 'agent-prev-token-0123456789-0123456789-0123';
export const OPERATOR_PASSWORD = 'correct horse battery staple 42';
export const TOTP_SEED = 'totp-seed-0123456789-0123456789-0123456789-abcdef';
export const PRIVATE_HOST = 'basht-broker.railway.internal';
export const PUBLIC_HOST = 'basht-broker-production.up.railway.app';
export const ALL_SECRETS = [WRITE_KEY, OP_SECRET, AGENT_TOKEN, AGENT_TOKEN_PREVIOUS, OPERATOR_PASSWORD, TOTP_SEED];
export const T0 = Date.UTC(2026, 10, 6, 12, 0, 5);

export const invoiceInput = { client_id: 4, date: '2025-03-01', items: [{ item: 'Diesel', quantity: '100', unit_price: '2', tax1: 1 }] };

export function rawRequest({ port, host = '127.0.0.1', method = 'GET', path = '/', headers = {}, body, rawBody, timeout = 5000, localAddress }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path, headers, timeout, setHost: false, ...(localAddress ? { localAddress, agent: false } : {}) }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); });
    req.on('error', reject);
    if (rawBody !== undefined) req.write(rawBody); else if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function startService({ env: over = {}, fake = new FakeDaftra(), clock = { t: T0 }, stateMode = 0o700, keepState, timeoutsMs } = {}) {
  const base = keepState ?? await mkdtemp(join(tmpdir(), 'basht-svc-'));
  const stateDir = join(base, 'broker-data');
  if (!keepState) await mkdir(stateDir, { mode: stateMode });
  fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
  const logs = [];
  const env = {
    DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_WRITE_API_KEY: WRITE_KEY, DAFTRA_APPROVAL_SECRET: OP_SECRET,
    BROKER_AGENT_TOKEN: AGENT_TOKEN, OPERATOR_PASSWORD, OPERATOR_TOTP_SEED: TOTP_SEED, DAFTRA_WRITES_ENABLED: '1',
    BROKER_STATE_DIR: stateDir, RAILWAY_PRIVATE_DOMAIN: PRIVATE_HOST, RAILWAY_PUBLIC_DOMAIN: PUBLIC_HOST, OPERATOR_FAIL_DELAY_MS: '0', ...over,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const service = createBrokerService({ env, fetcher: fake.fetch, now: () => clock.t, log: (l) => logs.push(l), publicHost: '127.0.0.1', privateHost: '127.0.0.1', publicPort: 0, privatePort: 0, timeoutsMs });
  const addr = await service.listen();
  const ctx = {
    service, fake, clock, logs, env, base, stateDir, publicPort: addr.public.port, privatePort: addr.private.port,
    publicOrigin: 'http://127.0.0.1:' + addr.public.port,
    async stop(removeState = true) { await service.close(); if (removeState && !keepState) await rm(base, { recursive: true, force: true }); },
    totp: (offsetSteps = 0, seed = TOTP_SEED) => totpCode(deriveTotpSecret(seed), stepAt(clock.t) + offsetSteps),
    // advance to the NEXT TOTP window and return a fresh code
    freshCode(seed = TOTP_SEED) { clock.t += 30_000; return totpCode(deriveTotpSecret(seed), stepAt(clock.t)); },
    agent: (route, body, { token = AGENT_TOKEN, headers = {}, host = PRIVATE_HOST, method = 'POST', contentType = 'application/json', raw, port } = {}) => rawRequest({
      port: port ?? addr.private.port, method, path: route, headers: { Host: host, ...(token === null ? {} : { Authorization: 'Bearer ' + token }), 'Content-Type': contentType, ...headers },
      body: raw === undefined ? (method === 'POST' ? JSON.stringify(body ?? {}) : undefined) : undefined, rawBody: raw,
    }).then((r) => ({ ...r, json: (() => { try { return JSON.parse(r.text); } catch { return null; } })() })),
  };
  ctx.operator = () => new Operator(ctx);
  return ctx;
}

export class Operator {
  constructor(ctx) { this.ctx = ctx; this.cookie = null; this.device = null; this.csrf = null; this.src = undefined; }
  request(method, path, { form, origin = this.ctx.publicOrigin, headers = {}, cookie = this.cookie, device = this.device, host, src = this.src } = {}) {
    const jar = [cookie, device].filter(Boolean).join('; ');
    const body = form ? new URLSearchParams(form).toString() : undefined;
    return rawRequest({ port: this.ctx.publicPort, method, path, host: '127.0.0.1', localAddress: src, headers: {
      ...(host ? { Host: host } : { Host: '127.0.0.1:' + this.ctx.publicPort }), ...(origin ? { Origin: origin } : {}), ...(jar ? { Cookie: jar } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers }, body });
  }
  async pre() { const r = await this.request('GET', '/'); return { r, pre: /name="pre" value="([^"]+)"/.exec(r.text)?.[1] }; }
  async login({ password = OPERATOR_PASSWORD, code, pre } = {}) {
    if (!pre) pre = (await this.pre()).pre;
    const r = await this.request('POST', '/login', { form: { pre, password, code: code ?? this.ctx.totp() }, cookie: null });
    for (const sc of r.headers['set-cookie'] ?? []) { const kv = sc.split(';')[0]; if (kv.startsWith('__Host-bdev=')) this.device = kv; else if (kv.startsWith('__Host-bsess=')) this.cookie = kv; }
    if (r.status === 303) await this.refreshCsrf();
    return r;
  }
  async refreshCsrf() { const r = await this.request('GET', '/console'); this.csrf = /name="csrf" value="([^"]+)"/.exec(r.text)?.[1] ?? null; return r; }
  async proposalPage(id) { const r = await this.request('GET', '/proposal/' + id); const m = /name="hash" value="([^"]+)"/.exec(r.text); this.hash = m?.[1]; this.csrf = /name="csrf" value="([^"]+)"/.exec(r.text)?.[1] ?? this.csrf; return r; }
  async decide(id, action, { code, hash, csrf, origin, extra = {} } = {}) {
    return this.request('POST', '/proposal/' + id + '/' + action, { origin, form: { csrf: csrf ?? this.csrf, hash: hash ?? this.hash, code: code ?? this.ctx.freshCode(), ...extra } });
  }
}

export async function proposeInvoice(ctx, input = invoiceInput, route = '/v1/propose') {
  const r = await ctx.agent(route, route === '/v1/propose' ? { type: 'sales_invoice', input, actor: 'bot' } : input);
  return r;
}
