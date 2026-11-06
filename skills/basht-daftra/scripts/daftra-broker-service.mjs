#!/usr/bin/env node
// SEPARATE-SERVICE BROKER (Railway) with an authenticated operator approval console.
//
// Two listeners, two trust levels, one process that is the ONLY holder of the write-capable Daftra key,
// DAFTRA_APPROVAL_SECRET (HMAC key for proposals/ledger/audit) and the operator credentials:
//
//   PRIVATE agent API  (BROKER_PRIVATE_PORT, default 8081, bound to `::`; reachable only over Railway private
//                       networking `<service>.railway.internal`). Bearer-token authenticated. Routes: propose,
//                       propose_duplicate, show, status. There is NO execute / approve / resolve / enable-writes route.
//                       Defence in depth if the owner ever mis-targets the public domain at this port: requests must carry a
//                       private Host and no edge-added headers, else a uniform 404 before any auth/body handling.
//   PUBLIC operator console (PORT, default 8080; the ONLY port the public domain may target). Password + TOTP login,
//                       fresh TOTP step-up for every approve/reject/resolve, CSRF, strict CSP. Approval therefore
//                       originates from the operator's own device/browser; nothing the agent can see or relay authorises a write.
//
// Fail-closed: not configured => health only, no writes. Writes are OFF unless the SERVICE env sets DAFTRA_WRITES_ENABLED=1;
// no request can change that.
import http from 'node:http';
import net from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat, appendFile, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { approvalSecret, approvalPhrase, readSecret, resolveCode, tenantOf, macEqual } from './daftra-auth.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { proposeDuplicate } from './daftra-duplicate.mjs';
import { executeProposal, resolveProposal, WriteRefused } from './daftra-write.mjs';
import { acquireLock, loadProposal, readLedger, updateProposal, ledgerDir, stateForHash } from './daftra-ledger.mjs';
import { publicProposal, safeText } from './daftra-public.mjs';
import { reviewLines } from './daftra-approve.mjs';
import { validateRequest } from './daftra-broker.mjs';
import { createOperatorAuth, constantTimeEqual, totpBase32, otpauthUri } from './daftra-operator-auth.mjs';

const MAX_API_BODY = 256 * 1024;
const MAX_FORM_BODY = 16 * 1024;
const PROPOSAL_FILE = /^prop_[0-9a-f]{16}\.json$/;
const PROPOSAL_ID = /^prop_[0-9a-f]{16}$/;
// Headers that only a proxy/edge adds. Private-network calls never carry them; their presence means "came through the public edge".
const EDGE_HEADER = /^(x-forwarded-.*|forwarded|x-real-ip|x-railway-.*|cf-.*|true-client-ip|x-envoy-.*|x-request-start|via)$/;
const API_ROUTES = Object.freeze({ '/v1/propose': 'propose', '/v1/propose_duplicate': 'propose_duplicate', '/v1/show': 'show', '/v1/status': 'status' });

// ---------------------------------------------------------------------------------------------------------------
// configuration (never throws: problems become `issues`, which keep the service read-only/unavailable but alive)
// ---------------------------------------------------------------------------------------------------------------
export function loadServiceConfig(env = process.env) {
  const issues = [];
  const need = (ok, msg) => { if (!ok) issues.push(msg); };
  const tenant = tenantOf(env);
  need(Boolean(tenant) && /\.daftra\.com$/.test(tenant), 'DAFTRA_BASE_URL must be an https *.daftra.com tenant');
  let writeKey; try { writeKey = readSecret(env, 'DAFTRA_WRITE_API_KEY') ?? env.DAFTRA_API_KEY; } catch (e) { issues.push('write key unreadable: ' + e.message); }
  need(typeof writeKey === 'string' && writeKey.length >= 8, 'DAFTRA_WRITE_API_KEY (or DAFTRA_API_KEY) is missing');
  let secret; try { secret = approvalSecret(env); } catch (e) { issues.push(e.message); }
  const tokens = [env.BROKER_AGENT_TOKEN, env.BROKER_AGENT_TOKEN_PREVIOUS].filter((t) => typeof t === 'string' && t.length > 0);
  need(typeof env.BROKER_AGENT_TOKEN === 'string' && env.BROKER_AGENT_TOKEN.length >= 32, 'BROKER_AGENT_TOKEN must be at least 32 characters');
  need(typeof env.OPERATOR_PASSWORD === 'string' && env.OPERATOR_PASSWORD.length >= 20, 'OPERATOR_PASSWORD must be at least 20 characters');
  need(typeof env.OPERATOR_TOTP_SEED === 'string' && env.OPERATOR_TOTP_SEED.length >= 32, 'OPERATOR_TOTP_SEED must be at least 32 characters');
  const stateDir = resolve(env.BROKER_STATE_DIR || '/broker-data');
  const hosts = new Set();
  const addHost = (h) => { if (h && typeof h === 'string') hosts.add(h.trim().toLowerCase().replace(/:\d+$/, '')); };
  addHost(env.RAILWAY_PRIVATE_DOMAIN);
  for (const h of String(env.BROKER_PRIVATE_HOSTS || '').split(',')) addHost(h);
  if (env.BROKER_ALLOW_LOOPBACK_HOST === '1') for (const h of ['localhost', '127.0.0.1', '[::1]']) hosts.add(h);   // tests only
  const publicNames = new Set([env.RAILWAY_PUBLIC_DOMAIN, ...String(env.BROKER_PUBLIC_DOMAINS || '').split(',')].filter(Boolean).map((h) => h.trim().toLowerCase()));
  need(hosts.size > 0, 'no private Host is configured (RAILWAY_PRIVATE_DOMAIN / BROKER_PRIVATE_HOSTS): the private API refuses every request');
  return { issues, tenant, writeKey, secret, tokens, stateDir, privateHosts: hosts, publicNames, writesEnabled: env.DAFTRA_WRITES_ENABLED === '1' };
}

function checkStateDir(dir, { create = true } = {}) {
  try {
    let st;
    try { st = lstatSync(dir); } catch (e) { if (e.code === 'ENOENT' && create) { mkdirSync(dir, { mode: 0o700 }); st = lstatSync(dir); } else throw e; }
    if (st.isSymbolicLink()) return 'BROKER_STATE_DIR is a symlink';
    if (!st.isDirectory()) return 'BROKER_STATE_DIR is not a directory';
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'BROKER_STATE_DIR is not owned by the running user';
    if ((st.mode & 0o027) !== 0) return 'BROKER_STATE_DIR must not be group-writable or accessible by others (chmod 700)';
    for (const rel of ['daftra-ledger', 'daftra-ledger/proposals', 'daftra-ledger/locks', 'daftra-ledger/ledger.jsonl', 'audit.jsonl', 'operator-state.json']) {
      try { if (lstatSync(join(dir, rel)).isSymbolicLink()) return 'a symlink was found inside the state directory (' + rel + ')'; } catch { /* absent */ }
    }
    return null;
  } catch (e) { return 'BROKER_STATE_DIR is unusable: ' + (e.code || e.message); }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
const esc = (v) => safeText(v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
});

function readBody(req, limit) {
  return new Promise((ok, fail) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); return fail(Object.assign(Error('too large'), { status: 413 })); }
    const chunks = []; let size = 0; let over = false;
    req.on('data', (d) => { if (over) return; size += d.length; if (size > limit) { over = true; chunks.length = 0; fail(Object.assign(Error('too large'), { status: 413 })); } else chunks.push(d); });
    req.on('end', () => { if (!over) ok(Buffer.concat(chunks)); });
    req.on('close', () => { if (!over && !req.complete) fail(Object.assign(Error('aborted'), { status: 400 })); });
    req.on('error', () => { if (!over) fail(Object.assign(Error('read error'), { status: 400 })); });
    req.on('aborted', () => { if (!over) fail(Object.assign(Error('aborted'), { status: 400 })); });
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

const STATUS_OUTCOME = Object.freeze({
  READY_FOR_APPROVAL: 'pending_operator_approval', BLOCKED: 'blocked', SUBMITTING: 'executing', SUBMITTED: 'submitted', DUPLICATE_ECHOED: 'submitted',
  REJECTED: 'rejected_by_daftra', AMBIGUOUS: 'ambiguous_needs_operator', EXPIRED: 'expired', DECLINED: 'declined_by_operator',
  RESOLVED_CREATED: 'resolved_created', RESOLVED_NOT_CREATED: 'resolved_not_created',
});

// ---------------------------------------------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------------------------------------------
// options: { env, fetcher, now, log, publicHost, privateHost }
export function createBrokerService(options = {}) {
  const env = { ...(options.env ?? process.env) };
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cfg = loadServiceConfig(env);
  const issues = [...cfg.issues];
  const stateIssue = checkStateDir(cfg.stateDir);
  if (stateIssue) issues.push(stateIssue);
  const configured = issues.length === 0;
  const secrets = [cfg.writeKey, cfg.secret, env.BROKER_AGENT_TOKEN, env.BROKER_AGENT_TOKEN_PREVIOUS, env.OPERATOR_PASSWORD, env.OPERATOR_TOTP_SEED,
    env.DAFTRA_API_KEY, env.DAFTRA_WRITE_API_KEY].filter((s) => typeof s === 'string' && s.length >= 6);
  const scrub = (text) => { let out = String(text); for (const s of secrets) out = out.split(s).join('[redacted]'); return out; };
  const rawLog = options.log ?? ((line) => console.log(line));
  const log = (obj) => { try { rawLog(scrub(JSON.stringify({ ts: new Date(now()).toISOString(), svc: 'basht-broker', ...obj }))); } catch { /* logging must never break a request */ } };

  // environment for the Daftra libraries: write key as THE key, approval secret, state dir as workspace. No operator/agent secrets.
  const brokerEnv = {
    DAFTRA_BASE_URL: env.DAFTRA_BASE_URL, DAFTRA_API_KEY: cfg.writeKey, DAFTRA_APPROVAL_SECRET: cfg.secret,
    OPENCLAW_WORKSPACE_DIR: cfg.stateDir, DAFTRA_WRITES_ENABLED: cfg.writesEnabled && configured ? '1' : '0',
    DAFTRA_MAX_WRITES_PER_HOUR: env.DAFTRA_MAX_WRITES_PER_HOUR,
  };
  const writesEnabled = () => configured && cfg.writesEnabled;

  const auth = createOperatorAuth({ env, stateDir: cfg.stateDir, now });
  const exposure = { alarm: false, count: 0, last: null };
  const lastAuditKey = new Map();

  // ---- audit (HMAC chain, fail-closed) ------------------------------------------------------------------------
  const auditFile = join(cfg.stateDir, 'audit.jsonl');
  const auditKey = cfg.secret ? createHash('sha256').update('audit-key\n' + cfg.secret).digest() : null;
  let auditQueue = Promise.resolve();
  const auditMac = (body) => createHmac('sha256', auditKey).update(JSON.stringify(body)).digest('hex');
  // Verifies the WHOLE chain on every append: a tampered audit log stops further audited actions (and so all approvals).
  async function lastAuditMac() {
    let raw = ''; try { raw = await readFile(auditFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let prev = 'genesis';
    for (const line of raw.split('\n').filter(Boolean)) {
      const { mac, ...body } = JSON.parse(line);
      if (body.prev !== prev || typeof mac !== 'string' || !macEqual(mac, auditMac(body))) { const e = new Error('Audit chain broken'); e.code = 'AUDIT_TAMPERED'; throw e; }
      prev = mac;
    }
    return prev;
  }
  function audit(event, fields = {}) {
    log({ audit: event, ...fields });
    if (!auditKey) return Promise.resolve();
    auditQueue = auditQueue.then(async () => {
      const prev = await lastAuditMac();
      const body = { ts: new Date(now()).toISOString(), event, ...fields, prev };
      await appendFile(auditFile, JSON.stringify({ ...body, mac: auditMac(body) }) + '\n', { mode: 0o600 });
    });
    return auditQueue;
  }
  const auditThrottled = (key, event, fields, everyMs = 60_000) => {
    const t = now(); if (t - (lastAuditKey.get(key) ?? 0) < everyMs) return Promise.resolve();
    lastAuditKey.set(key, t); return audit(event, fields).catch(() => {});
  };
  const ipHash = (ip) => createHash('sha256').update('ip\n' + ip).digest('hex').slice(0, 10);

  // ---- proposals listing ---------------------------------------------------------------------------------------
  async function listProposalFiles(limit = 100) {
    let names = [];
    try { names = (await readdir(join(ledgerDir(brokerEnv), 'proposals'))).filter((n) => PROPOSAL_FILE.test(n)); } catch { return []; }
    const withTime = [];
    for (const n of names) { try { withTime.push([n, (await stat(join(ledgerDir(brokerEnv), 'proposals', n))).mtimeMs]); } catch { /* raced */ } }
    return withTime.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n.slice(0, -5));
  }
  async function pendingCount() {
    let n = 0;
    for (const id of await listProposalFiles(500)) {
      try {
        const p = JSON.parse(await readFile(join(ledgerDir(brokerEnv), 'proposals', id + '.json'), 'utf8'));
        if (p.status === 'READY_FOR_APPROVAL' && Date.parse(p.expires_at) >= now()) n++;
      } catch { /* unreadable: ignored for the quota */ }
    }
    return n;
  }
  const outcomeOf = (p) => {
    if (p.status === 'READY_FOR_APPROVAL' && !(Date.parse(p.expires_at) >= now())) return 'expired';
    return STATUS_OUTCOME[p.status] ?? 'unknown';
  };

  // ===========================================================================================================
  // PRIVATE agent API
  // ===========================================================================================================
  const tokenDigests = cfg.tokens.map((t) => createHash('sha256').update(t).digest());
  const rate = new Map();                                            // key -> [timestamps]
  const hit = (key, limit, windowMs = 60_000) => {
    const t = now(); const arr = (rate.get(key) ?? []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) { rate.set(key, arr); return false; }
    arr.push(t); rate.set(key, arr); if (rate.size > 5000) rate.delete(rate.keys().next().value); return true;
  };
  const perMin = Number(env.BROKER_RATE_PER_MIN) > 0 ? Number(env.BROKER_RATE_PER_MIN) : 60;
  const proposePerMin = Number(env.BROKER_PROPOSE_PER_MIN) > 0 ? Number(env.BROKER_PROPOSE_PER_MIN) : 10;
  const maxPending = Number(env.BROKER_MAX_PENDING) > 0 ? Number(env.BROKER_MAX_PENDING) : 20;

  function jsonReply(res, status, obj) {
    const body = scrub(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 413 || status === 400 ? { Connection: 'close' } : {}) });
    res.end(body);
  }
  const notFound = (res) => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 9, 'Cache-Control': 'no-store' }); res.end('Not Found'); };

  function hostOnly(h) { return String(h ?? '').trim().toLowerCase().replace(/:\d+$/, ''); }

  async function apiStatus(id) {
    const p = await loadProposal(id, brokerEnv);
    const out = { ok: true, proposal_id: p.id, type: p.type, ready: p.ready === true, status: p.status, outcome: outcomeOf(p), expires_at: p.expires_at };
    if (p.record_id && ['SUBMITTED', 'DUPLICATE_ECHOED', 'RESOLVED_CREATED'].includes(p.status)) out.record_id = String(p.record_id);
    return out;
  }

  async function handleApi(req, res) {
    const peer = req.socket.remoteAddress ?? 'unknown';
    // (1) must look like a private-network call: private Host, no edge headers. Uniform 404 BEFORE auth/body handling.
    const edge = Object.keys(req.headers).filter((h) => EDGE_HEADER.test(h));
    const host = hostOnly(req.headers.host);
    const publicHost = cfg.publicNames.has(host) || /\.up\.railway\.app$/.test(host) || /\.railway\.app$/.test(host);
    if (edge.length || publicHost || !cfg.privateHosts.has(host)) {
      if (edge.length || publicHost) {
        exposure.alarm = true; exposure.count++; exposure.last = new Date(now()).toISOString();
        log({ level: 'ALERT', alert: 'PRIVATE_API_REACHABLE_VIA_PUBLIC_DOMAIN', edge_headers: edge.slice(0, 5), host: safeText(host).slice(0, 80) });
        auditThrottled('exposure', 'private_api_via_public', { host: safeText(host).slice(0, 80), edge: edge.slice(0, 5) });
      } else auditThrottled('badhost:' + host, 'private_api_bad_host', { host: safeText(host).slice(0, 80) });
      return notFound(res);
    }
    // (2) method / route / content type
    const url = new URL(req.url, 'http://x');
    const cmd = Object.hasOwn(API_ROUTES, url.pathname) ? API_ROUTES[url.pathname] : null;
    if (!cmd) return jsonReply(res, 404, { ok: false, error: 'Not found' });
    if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
    // (3) bearer token (constant time, exactly one Authorization header)
    const authHeaders = []; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'authorization') authHeaders.push(req.rawHeaders[i + 1]);
    if (!hit('authfail:' + peer, 30) ) return jsonReply(res, 429, { ok: false, error: 'Too many requests', refused: 'RATE_LIMIT' });
    const m = authHeaders.length === 1 ? /^Bearer ([^\s]{1,512})$/.exec(authHeaders[0]) : null;
    const given = m ? createHash('sha256').update(m[1]).digest() : null;
    let okToken = false; let matchedIndex = -1;
    tokenDigests.forEach((d, i) => { if (given && timingSafeEqual(d, given)) { okToken = true; matchedIndex = i; } });
    if (!okToken) {
      // count against a per-peer failure window (the successful path below does not consume it)
      auditThrottled('tokfail:' + peer, 'agent_auth_failed', { peer: ipHash(peer) }, 30_000);
      return jsonReply(res, 401, { ok: false, error: 'Unauthorized', refused: 'UNAUTHORIZED' });
    }
    rate.delete('authfail:' + peer);
    if (!hit('tok:' + matchedIndex, perMin)) { auditThrottled('ratelimit', 'agent_rate_limited', { peer: ipHash(peer) }); return jsonReply(res, 429, { ok: false, error: 'Rate limit', refused: 'RATE_LIMIT' }); }
    if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] ?? ''))) return jsonReply(res, 415, { ok: false, error: 'Content-Type must be application/json' });
    // (4) body
    let body;
    try {
      const raw = await readBody(req, MAX_API_BODY);
      body = JSON.parse(raw.toString('utf8'));
    } catch (e) { return jsonReply(res, e.status ?? 400, { ok: false, error: e.status === 413 ? 'Request too large' : 'Invalid JSON', refused: 'BAD_REQUEST' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'cmd')) return jsonReply(res, 400, { ok: false, error: 'Body must be a JSON object without cmd', refused: 'BAD_REQUEST' });
    if (!configured) return jsonReply(res, 503, { ok: false, error: 'Broker service is not configured', refused: 'NOT_CONFIGURED' });
    try {
      let result;
      if (cmd === 'status') {
        if (Object.keys(body).some((k) => k !== 'id') || typeof body.id !== 'string' || !PROPOSAL_ID.test(body.id)) return jsonReply(res, 400, { ok: false, error: 'Invalid id', refused: 'BAD_REQUEST' });
        result = await apiStatus(body.id);
      } else {
        const msg = validateRequest({ cmd, ...body });
        if (cmd === 'show' && !PROPOSAL_ID.test(msg.id)) return jsonReply(res, 400, { ok: false, error: 'Invalid id', refused: 'BAD_REQUEST' });
        if (cmd === 'show') result = publicProposal(await loadProposal(msg.id, brokerEnv), { service: true });
        else {
          if (!hit('propose:' + matchedIndex, proposePerMin)) { auditThrottled('proposerate', 'agent_propose_rate_limited', { peer: ipHash(peer) }); return jsonReply(res, 429, { ok: false, error: 'Propose rate limit', refused: 'RATE_LIMIT' }); }
          if ((await pendingCount()) >= maxPending) { auditThrottled('pendingcap', 'agent_pending_cap', {}); return jsonReply(res, 429, { ok: false, error: 'Too many proposals awaiting operator approval', refused: 'PENDING_CAP' }); }
          const actor = 'agent:' + (msg.actor ?? 'unknown');
          const p = cmd === 'propose'
            ? await createProposal(msg.type, msg.input, { env: brokerEnv, fetcher, actor, now: now() })
            : await proposeDuplicate({ source: msg.source, id: msg.docId, overrides: msg.overrides }, { env: brokerEnv, fetcher, actor, now: now() });
          result = publicProposal(p, { service: true });
          audit('proposal_created', { id: p.id, type: p.type, status: p.status }).catch(() => {});
        }
      }
      return jsonReply(res, 200, { ok: true, result });
    } catch (e) {
      if (e?.constructor?.name === 'BadRequest') return jsonReply(res, 400, { ok: false, error: e.message, refused: 'BAD_REQUEST' });
      const refused = typeof e?.code === 'string' ? e.code : undefined;
      return jsonReply(res, refused === 'LEDGER_TAMPERED' || refused === 'TAMPERED' || refused === 'CROSS_TENANT' ? 409 : 422, { ok: false, error: scrub(e?.message ?? 'Error').slice(0, 600), refused });
    }
  }

  // ===========================================================================================================
  // PUBLIC operator console
  // ===========================================================================================================
  const trustProxy = env.BROKER_TRUST_PROXY === '1';
  function clientIp(req) {
    if (trustProxy) { const v = String(req.headers['x-real-ip'] ?? '').trim(); if (net.isIP(v)) return v; }
    return req.socket.remoteAddress ?? 'unknown';
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return false;
    if (env.BROKER_PUBLIC_ORIGIN) return origin === env.BROKER_PUBLIC_ORIGIN;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function html(res, status, title, bodyHtml, { headers = {} } = {}) {
    const banner = (!configured ? '<div class="bad">⚠ Not configured / غير مهيأ</div>' : '')
      + (exposure.alarm ? '<div class="bad">⚠ PRIVATE API REACHABLE VIA PUBLIC DOMAIN — fix the domain target port NOW / الواجهة الخاصة متاحة عبر النطاق العام</div>' : '')
      + (configured && !writesEnabled() ? '<div class="warn">Writes are DISABLED on this service (read-only) / الكتابة معطّلة</div>' : '');
    const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
      + '<title>' + esc(title) + '</title><style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#111}main{max-width:720px;margin:auto}'
      + 'h1{font-size:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #ddd;padding:10px;border-radius:8px;unicode-bidi:plaintext}'
      + 'input,button,select{font:inherit;padding:12px;margin:6px 0;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #bbb}button{background:#0a58ca;color:#fff;border:0}button.danger{background:#b42318}button.ghost{background:#e5e7eb;color:#111}'
      + '.bad{background:#b42318;color:#fff;padding:10px;border-radius:8px;margin:8px 0;font-weight:600}.warn{background:#fff3cd;padding:10px;border-radius:8px;margin:8px 0}.ok{background:#d1fae5;padding:10px;border-radius:8px;margin:8px 0}'
      + 'a{color:#0a58ca}.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0}.dyn{unicode-bidi:plaintext}</style></head><body><main>'
      + banner + bodyHtml + '</main></body></html>';
    const out = scrub(page);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(out), ...headers });
    res.end(out);
  }
  const textReply = (res, status, text) => { res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...(status === 413 || status === 400 ? { Connection: 'close' } : {}) }); res.end(text); };
  const redirect = (res, to, headers = {}) => { res.writeHead(303, { ...SECURITY_HEADERS, Location: to, 'Content-Length': 0, ...headers }); res.end(); };

  const loginForm = (pre, msg) => '<h1>BASHT Daftra — Operator approval / اعتماد المشغّل</h1>' + (msg ? '<div class="warn">' + esc(msg) + '</div>' : '')
    + '<form method="post" action="/login" autocomplete="off"><input type="hidden" name="pre" value="' + esc(pre) + '">'
    + '<label>Password / كلمة المرور<input type="password" name="password" autocomplete="current-password" required></label>'
    + '<label>Authenticator code / رمز المصادقة<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>'
    + '<button type="submit">Sign in / دخول</button></form>' + (env.OPERATOR_ENROLLMENT === '1' ? '<p><a href="/enroll">Enroll authenticator / تسجيل المصادقة</a></p>' : '');

  const cookieAttrs = '; Path=/; Secure; HttpOnly; SameSite=Strict';
  const sessionCookie = (id, maxAgeSec) => '__Host-bsess=' + id + cookieAttrs + '; Max-Age=' + maxAgeSec;

  async function sessionOf(req) {
    return auth.session(parseCookies(req.headers.cookie)['__Host-bsess']);
  }
  function csrfOk(session, form) {
    return Boolean(session) && typeof form.get('csrf') === 'string' && constantTimeEqual(form.get('csrf'), session.csrf);
  }
  async function readForm(req) {
    if (!/^application\/x-www-form-urlencoded(\s*;.*)?$/i.test(String(req.headers['content-type'] ?? ''))) throw Object.assign(Error('bad content type'), { status: 415 });
    return new URLSearchParams((await readBody(req, MAX_FORM_BODY)).toString('utf8'));
  }

  const proposalLink = (id) => '/proposal/' + esc(id);

  async function consolePage(res, session) {
    const ids = await listProposalFiles(40); const rows = [];
    for (const id of ids) {
      try {
        const p = await loadProposal(id, brokerEnv);
        rows.push('<div class="card"><a href="' + proposalLink(id) + '"><b>' + esc(p.type) + '</b> <span class="dyn">' + esc(id) + '</span></a><br>' + esc(outcomeOf(p)) + ' · ' + esc(p.expires_at) + '</div>');
      } catch (e) { rows.push('<div class="card bad">' + esc(id) + ': integrity check failed (' + esc(e.code ?? 'error') + ')</div>'); }
    }
    html(res, 200, 'Console', '<h1>Proposals / المقترحات</h1>' + (rows.join('') || '<p>No proposals / لا توجد مقترحات</p>')
      + '<form method="post" action="/logout"><input type="hidden" name="csrf" value="' + esc(session.csrf) + '"><button class="ghost">Sign out / خروج</button></form>');
  }

  async function proposalPage(res, session, id, { message, kind = 'warn' } = {}) {
    let p;
    try { p = await loadProposal(id, brokerEnv); }
    catch (e) { audit('proposal_integrity_failure', { id: safeText(id).slice(0, 30), code: e.code ?? 'error' }).catch(() => {}); return html(res, 404, 'Proposal', '<div class="bad">Cannot show this proposal: ' + esc(e.code === 'ENOENT' || /not found/i.test(e.message) ? 'not found' : (e.code ?? 'integrity check failed')) + '</div><a href="/console">← Back</a>'); }
    const outcome = outcomeOf(p);
    const ledgerState = stateForHash(await readLedger(brokerEnv).catch(() => []), p.request_hash);
    const canDecide = outcome === 'pending_operator_approval';
    const canResolve = (p.status === 'AMBIGUOUS' || p.status === 'SUBMITTING') && ['ambiguous', 'submitting'].includes(ledgerState);
    const csrf = '<input type="hidden" name="csrf" value="' + esc(session.csrf) + '"><input type="hidden" name="hash" value="' + esc(p.request_hash) + '">';
    const codeField = '<label>Fresh authenticator code (a NEW code, not the one used to sign in) / رمز جديد<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>';
    let actions = '';
    if (canDecide && writesEnabled()) {
      actions += '<form method="post" action="/proposal/' + esc(p.id) + '/approve">' + csrf + codeField + '<button type="submit">APPROVE &amp; SEND to Daftra / اعتماد وإرسال</button></form>';
    } else if (canDecide) actions += '<div class="warn">Approval disabled: writes are off on this service.</div>';
    if (canDecide) actions += '<form method="post" action="/proposal/' + esc(p.id) + '/reject">' + csrf + codeField + '<button class="danger" type="submit">Reject / رفض</button></form>';
    if (canResolve) actions += '<h2>Ambiguous outcome / نتيجة غير مؤكدة</h2><p>Check Daftra, then record what happened.</p><form method="post" action="/proposal/' + esc(p.id) + '/resolve">' + csrf
      + '<select name="created"><option value="false">NOT created in Daftra / لم يُنشأ</option><option value="true">Created in Daftra / أُنشئ</option></select><input name="record_id" inputmode="numeric" maxlength="15" placeholder="record id (optional)">' + codeField + '<button class="danger" type="submit">Record decision / تسجيل</button></form>';
    html(res, 200, 'Proposal', (message ? '<div class="' + kind + '">' + esc(message) + '</div>' : '') + '<h1>Review / مراجعة</h1><p><b>' + esc(outcome) + '</b></p><pre>' + reviewLines(p).map((l) => esc(l)).join('\n') + '</pre>'
      + '<p>Request hash: <code class="dyn">' + esc(p.request_hash) + '</code></p>' + actions + '<p><a href="/console">← Back</a></p>');
  }

  const busy = new Set();
  const ledgerOk = async () => { await readLedger(brokerEnv); };

  async function decide(req, res, session, id, action) {
    let form;
    try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
    if (!sameOrigin(req) || !csrfOk(session, form)) { audit('csrf_rejected', { id }).catch(() => {}); return textReply(res, 403, 'Forbidden'); }
    if (!configured) return html(res, 503, 'Unavailable', '<div class="bad">Not configured</div>');
    if (busy.has(id)) return html(res, 409, 'Busy', '<div class="warn">Another decision on this proposal is in progress.</div><a href="' + proposalLink(id) + '">← Back</a>');
    busy.add(id);
    const ip = clientIp(req);
    try {
      let p;
      try { p = await loadProposal(id, brokerEnv); await ledgerOk(); }
      catch (e) { audit('integrity_failure', { id, code: e.code ?? 'error' }).catch(() => {}); return html(res, 409, 'Integrity', '<div class="bad">Integrity check failed (' + esc(e.code ?? 'error') + '): nothing was done.</div>'); }
      const hash = String(form.get('hash') ?? '');
      if (!/^[0-9a-f]{64}$/.test(hash) || hash !== p.request_hash) return html(res, 409, 'Changed', '<div class="bad">The request on this page is not the current request. Reload.</div>');
      const code = String(form.get('code') ?? '').trim();
      const outcome = outcomeOf(p);
      if (action === 'resolve') {
        const ledgerState = stateForHash(await readLedger(brokerEnv), p.request_hash);
        if (!['ambiguous', 'submitting'].includes(ledgerState)) return html(res, 409, 'Not ambiguous', '<div class="warn">This proposal is not awaiting a decision.</div>');
      } else if (outcome !== 'pending_operator_approval') return html(res, 409, 'Not pending', '<div class="warn">This proposal is not pending (' + esc(outcome) + ').</div><a href="' + proposalLink(id) + '">← Back</a>');
      if (action === 'approve' && !writesEnabled()) return html(res, 409, 'Writes disabled', '<div class="bad">Writes are disabled on this service. Nothing was sent.</div>');
      const su = await auth.stepUp({ ip, code });
      if (!su.ok) {
        audit('stepup_failed', { id, action, status: su.status, ip: ipHash(ip), session: session.short }).catch(() => {});
        return html(res, su.status === 429 ? 429 : su.status === 503 ? 503 : 401, 'Code rejected', '<div class="bad">Code rejected' + (su.status === 429 ? ' — locked out, try later' : '') + '. Wait for a NEW code and retry. / الرمز مرفوض</div><a href="' + proposalLink(id) + '">← Back</a>');
      }
      const actor = 'operator:' + session.short;
      await audit('operator_' + action, { id, hash: p.request_hash.slice(0, 12), step: su.step, session: session.short });     // audit BEFORE acting: tamper/IO failure => nothing happens
      if (action === 'approve') {
        let result;
        try { result = await executeProposal({ id, phrase: approvalPhrase(brokerEnv, p), actor }, { env: brokerEnv, fetcher, now: now() }); }
        catch (e) {
          await audit('approve_refused', { id, code: e.code ?? 'error' }).catch(() => {});
          return html(res, 409, 'Refused', '<div class="bad">Refused (' + esc(e.code ?? 'error') + '): ' + esc(e.message) + '</div><a href="' + proposalLink(id) + '">← Back</a>');
        }
        await audit('approve_result', { id, status: result.status, record_id: result.record_id ?? null, http: result.http_status ?? null }).catch(() => {});
        const good = result.ok === true;
        return html(res, 200, 'Result', '<div class="' + (good ? 'ok' : 'bad') + '"><b>' + esc(result.status) + '</b>' + (result.record_id ? ' · record ' + esc(result.record_id) : '') + '<br>' + esc(result.message ?? '')
          + (result.needs_review ? '<br><b>' + esc(result.needs_review) + '</b>' : '') + '</div><a href="/console">← Back</a>');
      }
      if (action === 'reject') {
        const claimed = await acquireLock(brokerEnv, p.id + '.claim');                      // consumes the proposal for good
        if (!claimed) return html(res, 409, 'Already used', '<div class="warn">Already used.</div>');
        await updateProposal(p.id, { status: 'DECLINED', approved_by: actor }, brokerEnv);
        return html(res, 200, 'Rejected', '<div class="ok">Rejected — nothing was sent. / تم الرفض</div><a href="/console">← Back</a>');
      }
      // resolve
      const created = form.get('created') === 'true'; const recordId = String(form.get('record_id') ?? '').trim();
      if (recordId && !/^[0-9]{1,15}$/.test(recordId)) return html(res, 400, 'Invalid', '<div class="bad">Invalid record id.</div>');
      try {
        await resolveProposal({ id, created, recordId: recordId || undefined, code: resolveCode(brokerEnv, id, created), actor }, { env: brokerEnv });
      } catch (e) { return html(res, 409, 'Refused', '<div class="bad">Refused (' + esc(e.code ?? 'error') + '): ' + esc(e.message) + '</div>'); }
      return html(res, 200, 'Recorded', '<div class="ok">Recorded. / تم التسجيل</div><a href="/console">← Back</a>');
    } finally { busy.delete(id); }
  }

  async function handleConsole(req, res) {
    const url = new URL(req.url, 'http://x'); const path = url.pathname; const method = req.method;
    if (method === 'GET' && (path === '/healthz' || path === '/setup/healthz')) return textReply(res, 200, 'ok');
    if (path.startsWith('/v1/')) return textReply(res, 404, 'Not Found');
    const ip = clientIp(req);
    await auth.ready();
    if (method === 'GET' && path === '/') {
      if (!configured) return html(res, 503, 'BASHT Daftra', '<h1>BASHT Daftra</h1><div class="bad">Service not configured / الخدمة غير مهيأة</div>');
      return html(res, 200, 'Sign in', loginForm(auth.issuePre()));
    }
    if (method === 'POST' && path === '/login') {
      let form; try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
      if (!sameOrigin(req)) return textReply(res, 403, 'Forbidden');
      if (!configured) return html(res, 503, 'BASHT Daftra', '<div class="bad">Service not configured</div>');
      if (!auth.consumePre(form.get('pre'))) return html(res, 400, 'Sign in', loginForm(auth.issuePre(), 'Form expired — try again / انتهت صلاحية النموذج'));
      const r = await auth.login({ password: form.get('password') ?? '', code: form.get('code') ?? '', ip });
      if (!r.ok) {
        audit('login_failed', { ip: ipHash(ip), status: r.status }).catch(() => {});
        return html(res, r.status, 'Sign in', loginForm(auth.issuePre(), r.status === 429 ? 'Too many attempts — try later / محاولات كثيرة' : r.status === 503 ? 'Unavailable' : 'Invalid credentials / بيانات غير صحيحة'));
      }
      audit('login_ok', { ip: ipHash(ip), session: r.session.short }).catch(() => {});
      return redirect(res, '/console', { 'Set-Cookie': sessionCookie(r.session.id, 1800) });
    }
    if (path === '/enroll') {
      if (env.OPERATOR_ENROLLMENT !== '1' || !configured) return textReply(res, 404, 'Not Found');
      if (method === 'GET') return html(res, 200, 'Enroll', '<h1>Authenticator enrollment / تسجيل المصادقة</h1><form method="post" action="/enroll"><input type="hidden" name="pre" value="' + esc(auth.issuePre()) + '"><label>Password<input type="password" name="password" required></label><button>Show setup key</button></form>');
      if (method === 'POST') {
        let form; try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
        if (!sameOrigin(req) || !auth.consumePre(form.get('pre'))) return textReply(res, 403, 'Forbidden');
        const r = await auth.verifyPasswordOnly({ password: form.get('password') ?? '', ip });
        if (!r.ok) { audit('enroll_failed', { ip: ipHash(ip), status: r.status }).catch(() => {}); return html(res, r.status, 'Enroll', '<div class="bad">Invalid / غير صحيح</div>'); }
        audit('enroll_shown', { ip: ipHash(ip) }).catch(() => {});
        const b32 = totpBase32(env.OPERATOR_TOTP_SEED);
        return html(res, 200, 'Enroll', '<h1>Setup key / مفتاح الإعداد</h1><p>Add to your authenticator (iPhone: Passwords → verification code → Enter Setup Key). Type: time-based, 6 digits, 30 s, SHA-1.</p><pre>' + esc(b32) + '</pre><pre>' + esc(otpauthUri(b32)) + '</pre><div class="warn"><b>Now remove the OPERATOR_ENROLLMENT variable and redeploy.</b> / احذف المتغير OPERATOR_ENROLLMENT</div>');
      }
      return textReply(res, 405, 'Method Not Allowed');
    }
    const session = await sessionOf(req);
    if (method === 'POST' && path === '/logout') {
      let form; try { form = await readForm(req); } catch { return textReply(res, 400, 'Bad request'); }
      if (!sameOrigin(req) || !csrfOk(session, form)) return textReply(res, 403, 'Forbidden');
      auth.logout(session.id); audit('logout', { session: session.short }).catch(() => {});
      return redirect(res, '/', { 'Set-Cookie': '__Host-bsess=deleted' + cookieAttrs + '; Max-Age=0' });
    }
    if (path === '/console' || path.startsWith('/proposal/')) {
      if (!session) return redirect(res, '/');
      if (!configured) return html(res, 503, 'Unavailable', '<div class="bad">Not configured</div>');
      if (method === 'GET' && path === '/console') return consolePage(res, session);
      const m = /^\/proposal\/(prop_[0-9a-f]{16})(?:\/(approve|reject|resolve))?$/.exec(path);
      if (!m) return textReply(res, 404, 'Not Found');
      if (method === 'GET' && !m[2]) return proposalPage(res, session, m[1]);
      if (method === 'POST' && m[2]) return decide(req, res, session, m[1], m[2]);
      return textReply(res, 405, 'Method Not Allowed');
    }
    return textReply(res, 404, 'Not Found');
  }

  // ---- servers ----------------------------------------------------------------------------------------------
  const guard = (fn) => (req, res) => {
    fn(req, res).catch((e) => {
      log({ level: 'error', error: scrub(e?.message ?? 'error').slice(0, 200) });
      if (!res.headersSent) { try { res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Internal error'); } catch { /* closed */ } }
    });
  };
  const timeouts = options.timeoutsMs ?? {};
  const harden = (s) => {
    s.headersTimeout = timeouts.headers ?? 10_000; s.requestTimeout = timeouts.request ?? 30_000;
    s.connectionsCheckingInterval = timeouts.check ?? 2_000;      // node enforces the two timeouts only at this cadence (default 30 s) s.keepAliveTimeout = 5_000; s.maxRequestsPerSocket = 100;
    s.on('clientError', (err, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); } catch { socket.destroy(); } });
    return s;
  };
  // node enforces headersTimeout/requestTimeout only every `connectionsCheckingInterval` (constructor option; default 30 s)
  const serverOptions = { maxHeaderSize: 16384, headersTimeout: timeouts.headers ?? 10_000, requestTimeout: timeouts.request ?? 30_000, connectionsCheckingInterval: timeouts.check ?? 2_000 };
  const publicServer = harden(http.createServer(serverOptions, guard(handleConsole)));
  const privateServer = harden(http.createServer(serverOptions, guard(handleApi)));
  const listenOn = (server, port, host) => new Promise((ok, fail) => { server.once('error', fail); server.listen(Number(port), host, () => { server.off('error', fail); ok(server.address()); }); });

  async function listen() {
    const pubPort = options.publicPort ?? env.PORT ?? 8080; const privPort = options.privatePort ?? env.BROKER_PRIVATE_PORT ?? 8081;
    if (String(pubPort) === String(privPort) && String(pubPort) !== '0') throw new Error('PORT and BROKER_PRIVATE_PORT must differ');
    if (!configured) log({ level: 'warn', msg: 'SERVICE NOT CONFIGURED: writes impossible', issues });
    else if (!writesEnabled()) log({ level: 'info', msg: 'writes are DISABLED (DAFTRA_WRITES_ENABLED is not 1)' });
    await auth.ready();
    if (auth.broken && env.OPERATOR_STATE_RESET === '1') { await auth.reset(); await audit('operator_state_reset', {}).catch(() => {}); log({ level: 'warn', msg: 'operator state was reset (OPERATOR_STATE_RESET=1): unset it' }); }
    else if (auth.broken) log({ level: 'error', msg: 'operator state failed authentication: logins refused. Set OPERATOR_STATE_RESET=1 once to recover.', reason: auth.broken });
    const pub = await listenOn(publicServer, pubPort, options.publicHost ?? env.BROKER_PUBLIC_HOST ?? '::');
    const priv = await listenOn(privateServer, privPort, options.privateHost ?? env.BROKER_PRIVATE_HOST ?? '::');
    return { public: pub, private: priv };
  }
  async function close() {
    await auditQueue.catch(() => {});                       // let in-flight audit appends finish before the volume is released
    await Promise.all([publicServer, privateServer].map((s) => new Promise((ok) => { s.close(() => ok()); s.closeAllConnections?.(); })));
  }
  return {
    listen, close, publicServer, privateServer, issues, configured, writesEnabled, exposure,
    publicAddress: () => publicServer.address(), privateAddress: () => privateServer.address(),
    _auth: auth, _brokerEnv: brokerEnv, _stateDir: cfg.stateDir,
  };
}

// Verify the audit chain of a state directory (used by tests and operators).
export async function readAudit({ stateDir, secret }) {
  const key = createHash('sha256').update('audit-key\n' + secret).digest();
  let raw = ''; try { raw = await readFile(join(stateDir, 'audit.jsonl'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = []; let prev = 'genesis';
  for (const line of raw.split('\n').filter(Boolean)) {
    const e = JSON.parse(line); const { mac, ...body } = e;
    if (body.prev !== prev || typeof mac !== 'string' || !macEqual(mac, createHmac('sha256', key).update(JSON.stringify(body)).digest('hex'))) {
      const err = new Error('Audit chain broken'); err.code = 'AUDIT_TAMPERED'; throw err;
    }
    out.push(e); prev = mac;
  }
  return out;
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const service = createBrokerService();
  try {
    const addr = await service.listen();
    console.log(JSON.stringify({ ok: true, svc: 'basht-broker', configured: service.configured, writes_enabled: service.writesEnabled(), public_port: addr.public.port, private_port: addr.private.port }));
    const stop = () => service.close().then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
void lstat; void writeFile; void WriteRefused;
