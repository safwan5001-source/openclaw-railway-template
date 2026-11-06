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
import { readdir, readFile, stat, appendFile, lstat, writeFile, open, unlink } from 'node:fs/promises';
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
import { validateGet, performGet, validateInvoicePdfRequest, fetchInvoicePdf, BadRead } from './daftra-broker-reads.mjs';
import { createSessionStore, parseCookieInput } from './daftra-session-store.mjs';

const MAX_API_BODY = 256 * 1024;
const MAX_FORM_BODY = 16 * 1024;
const PROPOSAL_FILE = /^prop_[0-9a-f]{16}\.json$/;
const PROPOSAL_ID = /^prop_[0-9a-f]{16}$/;
// Headers that only a proxy/edge adds. Private-network calls never carry them; their presence means "came through the public edge".
const EDGE_HEADER = /^(x-forwarded-.*|forwarded|x-real-ip|x-railway-.*|cf-.*|true-client-ip|x-envoy-.*|x-request-start|via)$/;
const API_ROUTES = Object.freeze({ '/v1/propose': 'propose', '/v1/propose_duplicate': 'propose_duplicate', '/v1/show': 'show', '/v1/status': 'status', '/v1/get': 'get', '/v1/invoice_pdf': 'invoice_pdf' });
const READ_CMDS = new Set(['get', 'invoice_pdf']);
const MAX_PROPOSAL_BYTES = 96 * 1024;            // a stored proposal larger than this is refused (and deleted)
const MAX_APPROVABLE_BODY = 48 * 1024;           // ... and so is a request body a human could not sensibly review

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
  const tokens = [env.BROKER_AGENT_TOKEN, env.BROKER_AGENT_TOKEN_PREVIOUS].filter((t) => typeof t === 'string' && t.length >= 32);
  need(env.BROKER_AGENT_TOKEN_PREVIOUS === undefined || env.BROKER_AGENT_TOKEN_PREVIOUS === '' || (typeof env.BROKER_AGENT_TOKEN_PREVIOUS === 'string' && env.BROKER_AGENT_TOKEN_PREVIOUS.length >= 32), 'BROKER_AGENT_TOKEN_PREVIOUS must be at least 32 characters (or unset)');
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
    for (const rel of ['daftra-ledger', 'daftra-ledger/proposals', 'daftra-ledger/locks', 'daftra-ledger/ledger.jsonl', 'audit.jsonl', 'operator-state.json', 'daftra-session.json']) {
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
  // The operator's pasted Daftra session cookie values are added here at runtime so no log line or reply can ever carry them.
  const dynamicSecrets = new Set();
  const scrub = (text) => { let out = String(text); for (const s of [...secrets, ...dynamicSecrets]) if (out.includes(s)) out = out.split(s).join('[redacted]'); return out; };
  const containsSecret = (text) => secrets.some((s) => String(text).includes(s)) || [...dynamicSecrets].some((s) => String(text).includes(s));
  const rawLog = options.log ?? ((line) => console.log(line));
  const log = (obj) => { try { rawLog(scrub(JSON.stringify({ ts: new Date(now()).toISOString(), svc: 'basht-broker', ...obj }))); } catch { /* logging must never break a request */ } };

  // environment for the Daftra libraries: write key as THE key, approval secret, state dir as workspace. No operator/agent secrets.
  const brokerEnv = {
    DAFTRA_BASE_URL: env.DAFTRA_BASE_URL, DAFTRA_API_KEY: cfg.writeKey, DAFTRA_APPROVAL_SECRET: cfg.secret,
    OPENCLAW_WORKSPACE_DIR: cfg.stateDir, DAFTRA_WRITES_ENABLED: cfg.writesEnabled && configured ? '1' : '0',
    DAFTRA_MAX_WRITES_PER_HOUR: env.DAFTRA_MAX_WRITES_PER_HOUR, DAFTRA_PDF_REDIRECT_HOSTS: env.DAFTRA_PDF_REDIRECT_HOSTS,   // non-secret exact hostnames
  };
  const writesEnabled = () => configured && cfg.writesEnabled;

  const auth = createOperatorAuth({ env, stateDir: cfg.stateDir, now, deviceSecret: cfg.secret });
  const exposure = { alarm: false, count: 0, last: null };
  // Encrypted-at-rest Daftra browser session pasted by the operator (never by the agent); used only for GET of one invoice PDF.
  const sessionStore = configured ? createSessionStore({ dir: cfg.stateDir, secret: cfg.secret, now }) : null;
  const rememberSessionSecrets = async () => { for (const v of await sessionStore.secretValues().catch(() => [])) dynamicSecrets.add(v); };
  const lastAuditKey = new Map();

  // ---- audit (HMAC chain, fail-closed) ------------------------------------------------------------------------
  // The chain head is CACHED: the whole file is verified at start-up (and every 5 minutes), every append only checks that the
  // file's last line still carries the cached head (O(1)). Unauthenticated noise is never audited line by line: it is counted
  // and flushed as ONE `unauth_summary` line per minute, so an attacker cannot grow the log or slow the operator's approvals.
  const auditFile = join(cfg.stateDir, 'audit.jsonl');
  const auditKey = cfg.secret ? createHash('sha256').update('audit-key\n' + cfg.secret).digest() : null;
  const auditMac = (body) => createHmac('sha256', auditKey).update(JSON.stringify(body)).digest('hex');
  const tamper = () => { const e = new Error('Audit chain broken'); e.code = 'AUDIT_TAMPERED'; return e; };
  let auditHead = null; let auditVerifiedAt = 0; let auditBroken = null; let auditQueue = Promise.resolve();
  async function verifyAuditChain() {
    let raw = ''; try { raw = await readFile(auditFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let prev = 'genesis';
    for (const line of raw.split('\n').filter(Boolean)) {
      let parsed; try { parsed = JSON.parse(line); } catch { throw tamper(); }
      const { mac, ...body } = parsed;
      if (body.prev !== prev || typeof mac !== 'string' || !macEqual(mac, auditMac(body))) throw tamper();
      prev = mac;
    }
    return prev;
  }
  async function tailMac() {
    let fh; try { fh = await open(auditFile, 'r'); } catch (e) { if (e.code === 'ENOENT') return 'genesis'; throw e; }
    try {
      const { size } = await fh.stat(); if (size === 0) return 'genesis';
      const len = Math.min(size, 16384); const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      try { return JSON.parse(lines[lines.length - 1]).mac ?? 'broken'; } catch { return 'broken'; }
    } finally { await fh.close(); }
  }
  // Steady state is O(1) (tail check). Any change to the file that this process did not make itself (size / mtime / inode differ
  // from what the last append left behind) triggers a FULL chain verification, and so does a 5-minute timer.
  let auditStat = null;
  const statAudit = async () => { const s = await stat(auditFile).catch(() => null); return s ? { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino } : null; };
  const sameStat = (x, y) => (x === null && y === null) || (x !== null && y !== null && x.size === y.size && x.mtimeMs === y.mtimeMs && x.ino === y.ino);
  async function ensureAuditHead() {
    if (auditBroken) throw auditBroken;
    try {
      const cur = await statAudit();
      if (auditHead === null || !sameStat(cur, auditStat) || Date.now() - auditVerifiedAt > 5 * 60_000) { auditHead = await verifyAuditChain(); auditVerifiedAt = Date.now(); auditStat = await statAudit(); }
      else if ((await tailMac()) !== auditHead) throw tamper();
    } catch (e) { if (e.code === 'AUDIT_TAMPERED') auditBroken = e; throw e; }
  }
  // The queue RECOVERS after a transient I/O error: the failure is reported to the caller of THAT append only.
  function enqueueAudit(job) { const p = auditQueue.catch(() => {}).then(job); auditQueue = p.catch(() => {}); return p; }
  function audit(event, fields = {}) {
    log({ audit: event, ...fields });
    if (!auditKey) return Promise.resolve();
    return enqueueAudit(async () => {
      await ensureAuditHead();
      const body = { ts: new Date(now()).toISOString(), event, ...fields, prev: auditHead };
      const mac = auditMac(body);
      await appendFile(auditFile, JSON.stringify({ ...body, mac }) + '\n', { mode: 0o600 });
      auditHead = mac; auditStat = await statAudit();
    });
  }
  const auditThrottled = (key, event, fields, everyMs = 60_000) => {
    const t = now(); if (t - (lastAuditKey.get(key) ?? 0) < everyMs) return Promise.resolve();
    lastAuditKey.set(key, t); return audit(event, fields).catch(() => {});
  };
  // unauthenticated / high-volume events: counters only. Each summary line also carries the top peer hashes (and their counts), so an
  // attack leaves a trail without one line per request. Agent reads are logged to stdout once a minute as {entity, hash-of-request, n}.
  const agg = new Map(); const aggPeers = new Map(); const readLog = new Map(); let aggFlushedAt = now();
  function flushAgg() {
    const t = now(); aggFlushedAt = t;
    if (readLog.size) {
      const reads = [...readLog.values()].sort((x, y) => y.n - x.n).slice(0, 50); readLog.clear();
      log({ event: 'agent_reads', reads });
    }
    if (!agg.size) { aggPeers.clear(); return Promise.resolve(); }
    const counts = Object.fromEntries(agg); agg.clear();
    const top_peers = [...aggPeers].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([peer, n]) => ({ peer, n })); aggPeers.clear();
    return audit('unauth_summary', { counts, top_peers }).catch(() => {});
  }
  function noteEvent(type, peer) {
    if (!agg.has(type) && agg.size >= 128) return;                      // bounded key space (event names come from fixed sets)
    agg.set(type, (agg.get(type) ?? 0) + 1);
    if (peer) { const h = ipHash(peer); if (aggPeers.has(h) || aggPeers.size < 64) aggPeers.set(h, (aggPeers.get(h) ?? 0) + 1); }
    if (now() - aggFlushedAt >= 60_000) flushAgg();
  }
  function noteRead(v) {
    noteEvent('agent_get:' + v.name);
    const h = createHash('sha256').update(v.path + '?' + v.search.toString()).digest('hex').slice(0, 10);
    const key = v.name + '|' + h;
    if (readLog.has(key)) readLog.get(key).n++; else if (readLog.size < 200) readLog.set(key, { entity: v.name, h, n: 1 });
  }
  const ipHash = (ip) => createHash('sha256').update('ip\n' + ip).digest('hex').slice(0, 10);

  // ---- proposal index (in memory; advisory only — every action re-loads and re-authenticates the file) ------------
  // Bounded: at most BROKER_MAX_PROPOSALS files / BROKER_MAX_BYTES bytes. BLOCKED, DECLINED, REJECTED and expired proposals are
  // deleted once their 15-minute TTL has passed (+5 min); executed ones are kept BROKER_RETAIN_DAYS (default 90).
  const proposalsDir = () => join(ledgerDir(brokerEnv), 'proposals');
  const maxProposals = Number(env.BROKER_MAX_PROPOSALS) > 0 ? Number(env.BROKER_MAX_PROPOSALS) : 500;
  const maxBytes = Number(env.BROKER_MAX_BYTES) > 0 ? Number(env.BROKER_MAX_BYTES) : 64 * 1024 * 1024;
  const retainMs = (Number(env.BROKER_RETAIN_DAYS) > 0 ? Number(env.BROKER_RETAIN_DAYS) : 90) * 86_400_000;
  const declineTtlMs = (Number(env.BROKER_DECLINE_TTL_MIN) > 0 ? Number(env.BROKER_DECLINE_TTL_MIN) : 60) * 60_000;
  const index = new Map();                         // id -> { created, expires, status, bytes, hash }
  const declined = new Map();                      // request_hash -> until (ms): the operator said no
  let indexBytes = 0;
  const TRANSIENT = new Set(['BLOCKED', 'DECLINED', 'REJECTED', 'RESOLVED_NOT_CREATED', 'EXPIRED']);
  function indexSet(id, p, bytes) {
    const prev = index.get(id); if (prev) indexBytes -= prev.bytes;
    const entry = { created: Date.parse(p.created_at) || now(), expires: Date.parse(p.expires_at) || 0, status: p.status, bytes: bytes ?? prev?.bytes ?? 0, hash: p.request_hash };
    index.set(id, entry); indexBytes += entry.bytes;
    if (p.status === 'DECLINED' && p.request_hash) declined.set(p.request_hash, (Date.parse(p.approved_at) || entry.created) + declineTtlMs);
  }
  async function indexRefresh(id) {
    try {
      const file = join(proposalsDir(), id + '.json');
      const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      indexSet(id, JSON.parse(raw), st.size);
    } catch { const prev = index.get(id); if (prev) { indexBytes -= prev.bytes; index.delete(id); } }
  }
  async function indexLoad() {
    index.clear(); indexBytes = 0;
    let names = []; try { names = (await readdir(proposalsDir())).filter((n) => PROPOSAL_FILE.test(n)); } catch { return; }
    for (const n of names) await indexRefresh(n.slice(0, -5));
  }
  async function removeProposal(id) {
    const prev = index.get(id); if (prev) { indexBytes -= prev.bytes; index.delete(id); }
    await unlink(join(proposalsDir(), id + '.json')).catch(() => {});
    await unlink(join(ledgerDir(brokerEnv), 'locks', id + '.claim')).catch(() => {});
  }
  async function prune() {
    const t = now();
    for (const [h, until] of declined) if (until < t) declined.delete(h);
    for (const [id, e] of [...index]) {
      const dead = (TRANSIENT.has(e.status) || (e.status === 'READY_FOR_APPROVAL' && e.expires < t)) && t > e.expires + 5 * 60_000;
      const old = t - e.created > retainMs;
      if (dead || old) await removeProposal(id);
    }
  }
  const pendingCount = () => { const t = now(); let n = 0; for (const e of index.values()) if (e.status === 'READY_FOR_APPROVAL' && e.expires >= t) n++; return n; };
  const pendingIds = () => { const t = now(); return [...index].filter(([, e]) => e.status === 'READY_FOR_APPROVAL' && e.expires >= t).sort((a, b) => b[1].created - a[1].created).map(([id]) => id); };
  const recentIds = (limit) => [...index].filter(([, e]) => !(e.status === 'READY_FOR_APPROVAL' && e.expires >= now())).sort((a, b) => b[1].created - a[1].created).slice(0, limit).map(([id]) => id);
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
  const getPerMin = Number(env.BROKER_GET_PER_MIN) > 0 ? Number(env.BROKER_GET_PER_MIN) : 300;
  const getConcurrency = Number(env.BROKER_GET_CONCURRENCY) > 0 ? Number(env.BROKER_GET_CONCURRENCY) : 2;
  let getInflight = 0;
  // Pre-auth limiter (token bucket per PEER SOCKET ADDRESS + one global bucket) in front of BOTH listeners. It uses the socket
  // address, never X-Real-IP, so a caller on the private network cannot rotate buckets by spoofing a header.
  // Order matters: the PER-PEER bucket is charged first and the GLOBAL bucket only for requests that passed it, so one hostile peer is
  // throttled by its own bucket and can never drain the global one by itself. Requests of a logged-in operator (valid session cookie)
  // have their own sane bucket and are exempt from the global ANONYMOUS bucket; health checks are exempt from the global bucket too
  // (a drained bucket must never make Railway think the service is down).
  function makeLimiter({ perPeerRps, burst, globalRps, globalBurst, maxPeers = 2000, sessionRps = 20, sessionBurst = 60, coarseRps = 0 }) {
    const peers = new Map(); const coarse = new Map(); const sess = new Map(); const g = { tokens: globalBurst, last: Date.now() };
    const take = (b, r, cap, t) => { b.tokens = Math.min(cap, b.tokens + ((t - b.last) / 1000) * r); b.last = t; if (b.tokens < 1) return false; b.tokens -= 1; return true; };
    const bucketFor = (map, key, cap, t) => {
      let b = map.get(key);
      if (!b) { if (map.size >= maxPeers) map.delete(map.keys().next().value); b = { tokens: cap, last: t }; map.set(key, b); }
      else { map.delete(key); map.set(key, b); }                          // LRU
      return b;
    };
    return (peer, { session, socket, health } = {}) => {
      const t = Date.now();
      if (!take(bucketFor(peers, peer, burst, t), perPeerRps, burst, t)) return false;
      if (coarseRps && socket && !take(bucketFor(coarse, socket, coarseRps * 2, t), coarseRps, coarseRps * 2, t)) return false;
      if (health) return true;
      if (session) return take(bucketFor(sess, session, sessionBurst, t), sessionRps, sessionBurst, t);
      return take(g, globalRps, globalBurst, t);
    };
  }
  const rps = Number(env.BROKER_PREAUTH_RPS) > 0 ? Number(env.BROKER_PREAUTH_RPS) : 50;
  const publicLimiter = makeLimiter({ perPeerRps: rps, burst: rps * 2, globalRps: rps * 4, globalBurst: rps * 8, coarseRps: rps * 10 });
  const privateLimiter = makeLimiter({ perPeerRps: rps * 2, burst: rps * 4, globalRps: rps * 4, globalBurst: rps * 8 });
  const proposePerMin = Number(env.BROKER_PROPOSE_PER_MIN) > 0 ? Number(env.BROKER_PROPOSE_PER_MIN) : 10;
  const maxPending = Number(env.BROKER_MAX_PENDING) > 0 ? Number(env.BROKER_MAX_PENDING) : 20;

  function jsonReply(res, status, obj, { raw = false } = {}) {
    const body = raw ? JSON.stringify(obj) : scrub(JSON.stringify(obj));
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
      } else noteEvent('private_api_bad_host', peer);
      return notFound(res);
    }
    // (2) method / route / content type
    const url = new URL(req.url, 'http://x');
    const cmd = Object.hasOwn(API_ROUTES, url.pathname) ? API_ROUTES[url.pathname] : null;
    if (!cmd) return jsonReply(res, 404, { ok: false, error: 'Not found' });
    if (req.method !== 'POST') return jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
    // (3) bearer token (constant time, exactly one Authorization header)
    const authHeaders = []; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'authorization') authHeaders.push(req.rawHeaders[i + 1]);
    if (!hit('authfail:' + peer, 30)) { noteEvent('agent_auth_flood', peer); return jsonReply(res, 429, { ok: false, error: 'Too many requests', refused: 'RATE_LIMIT' }); }
    const m = authHeaders.length === 1 ? /^Bearer ([^\s]{1,512})$/.exec(authHeaders[0]) : null;
    const given = m ? createHash('sha256').update(m[1]).digest() : null;
    let okToken = false; let matchedIndex = -1;
    tokenDigests.forEach((d, i) => { if (given && timingSafeEqual(d, given)) { okToken = true; matchedIndex = i; } });
    if (!okToken) { noteEvent('agent_auth_failed', peer); return jsonReply(res, 401, { ok: false, error: 'Unauthorized', refused: 'UNAUTHORIZED' }); }
    rate.delete('authfail:' + peer);
    const isRead = READ_CMDS.has(cmd);
    if (isRead) {
      if (!hit('get:' + matchedIndex, getPerMin)) { noteEvent('agent_get_rate_limited'); return jsonReply(res, 429, { ok: false, error: 'Read rate limit', refused: 'RATE_LIMIT' }); }
    } else if (!hit('tok:' + matchedIndex, perMin)) { noteEvent('agent_rate_limited'); return jsonReply(res, 429, { ok: false, error: 'Rate limit', refused: 'RATE_LIMIT' }); }
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
      if (isRead) return await handleRead(res, cmd, body);
      if (cmd === 'status') {
        if (Object.keys(body).some((k) => k !== 'id') || typeof body.id !== 'string' || !PROPOSAL_ID.test(body.id)) return jsonReply(res, 400, { ok: false, error: 'Invalid id', refused: 'BAD_REQUEST' });
        result = await apiStatus(body.id);
      } else {
        const msg = validateRequest({ cmd, ...body });
        if (cmd === 'show' && !PROPOSAL_ID.test(msg.id)) return jsonReply(res, 400, { ok: false, error: 'Invalid id', refused: 'BAD_REQUEST' });
        if (cmd === 'show') result = publicProposal(await loadProposal(msg.id, brokerEnv), { service: true });
        else {
          // A request that contains any secret of this service is refused outright (never stored, never displayed): what the
          // operator reviews must be exactly what would be sent, so nothing is "redacted" behind their back.
          if (containsSecret(JSON.stringify(body))) return jsonReply(res, 400, { ok: false, error: 'The request contains a value that must never appear in a proposal', refused: 'SECRET_IN_REQUEST' });
          if (!hit('propose:' + matchedIndex, proposePerMin)) { noteEvent('agent_propose_rate_limited'); return jsonReply(res, 429, { ok: false, error: 'Propose rate limit', refused: 'RATE_LIMIT' }); }
          await prune();
          if (index.size >= maxProposals || indexBytes >= maxBytes) { noteEvent('agent_store_full'); return jsonReply(res, 429, { ok: false, error: 'Proposal store is full; wait for old proposals to expire', refused: 'STORE_FULL' }); }
          if (pendingCount() >= maxPending) { noteEvent('agent_pending_cap'); return jsonReply(res, 429, { ok: false, error: 'Too many proposals awaiting operator approval', refused: 'PENDING_CAP' }); }
          const actor = 'agent:' + (msg.actor ?? 'unknown');
          const p = cmd === 'propose'
            ? await createProposal(msg.type, msg.input, { env: brokerEnv, fetcher, actor, now: now() })
            : await proposeDuplicate({ source: msg.source, id: msg.docId, overrides: msg.overrides }, { env: brokerEnv, fetcher, actor, now: now() });
          const file = join(proposalsDir(), p.id + '.json'); const size = (await stat(file).catch(() => ({ size: 0 }))).size;
          if (size > MAX_PROPOSAL_BYTES || JSON.stringify(p.request).length > MAX_APPROVABLE_BODY) {
            await removeProposal(p.id);
            return jsonReply(res, 413, { ok: false, error: 'The proposal is too large to be reviewed by a person', refused: 'PROPOSAL_TOO_LARGE' });
          }
          indexSet(p.id, p, size);
          let shown = p;
          if (p.status === 'READY_FOR_APPROVAL' && (declined.get(p.request_hash) ?? 0) > now()) {       // the operator already said no to this exact request
            const claimed = await acquireLock(brokerEnv, p.id + '.claim');
            if (claimed) await updateProposal(p.id, { status: 'DECLINED', approved_by: 'operator:earlier-decision', approved_at: new Date(now()).toISOString() }, brokerEnv);
            await indexRefresh(p.id);
            shown = { ...p, status: 'DECLINED', blocking: ['Declined by the operator earlier; the identical request is refused until the decline expires'] };
            noteEvent('agent_repeat_of_declined');
          }
          result = publicProposal(shown, { service: true });
          audit('proposal_created', { id: p.id, type: p.type, status: shown.status }).catch(() => {});
        }
      }
      return jsonReply(res, 200, { ok: true, result });
    } catch (e) {
      if (e instanceof BadRead || e?.constructor?.name === 'BadRequest') return jsonReply(res, 400, { ok: false, error: e.message, refused: 'BAD_REQUEST' });
      const refused = typeof e?.code === 'string' ? e.code : undefined;
      return jsonReply(res, refused === 'LEDGER_TAMPERED' || refused === 'TAMPERED' || refused === 'CROSS_TENANT' ? 409 : 422, { ok: false, error: scrub(e?.message ?? 'Error').slice(0, 600), refused });
    }
  }

  // Keyless READ proxy (GET only, allowlisted path + query, the broker's own key). Reads are counted, never audited line by line.
  async function handleRead(res, cmd, body) {
    if (getInflight >= getConcurrency) { noteEvent('agent_get_concurrency'); return jsonReply(res, 429, { ok: false, error: 'Too many concurrent reads', refused: 'CONCURRENCY' }); }
    getInflight++;
    try {
      if (cmd === 'get') {
        const v = validateGet(body);
        noteEvent('agent_get'); noteRead(v);
        let result;
        try { result = await performGet(v, { env: brokerEnv, fetcher }); }
        catch (e) { if (e instanceof BadRead) throw e; result = { status: 502, body: null, message: 'Upstream unreachable' }; }
        return jsonReply(res, 200, { ok: true, result });
      }
      const id = validateInvoicePdfRequest(body);
      noteEvent('agent_invoice_pdf');
      let result;
      // `session` is passed whenever sessions are supported: cookieHeader is null until the operator connects one.
      const session = sessionStore ? {
        cookieHeader: await sessionStore.cookieHeader().catch(() => null),
        onResult: async (outcome) => {
          if (outcome === 'ok') { await sessionStore.markOk(); log({ evt: 'invoice_pdf_session', outcome: 'ok' }); }
          else { await sessionStore.markExpired(); log({ evt: 'invoice_pdf_session', outcome: 'expired' }); await auditThrottled('daftra_session_expired', 'daftra_session_expired', {}); }
        },
      } : undefined;
      if (session?.cookieHeader) await rememberSessionSecrets();
      try { result = await fetchInvoicePdf(id, { env: brokerEnv, fetcher, session }); }
      catch (e) { if (e instanceof BadRead) throw e; result = { status: 502, message: 'Upstream unreachable' }; }
      // Operator-visible reason for a non-PDF answer: fixed fields only (never the link, hash, path or page content).
      if (result.diagnostic) log({ evt: 'invoice_pdf_not_pdf', ...result.diagnostic, draft: result.draft === true });
      return jsonReply(res, 200, { ok: true, result }, { raw: true });
    } finally { getInflight--; }
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
    if (typeof origin === 'string' && origin !== 'null') {
      if (env.BROKER_PUBLIC_ORIGIN) return origin === env.BROKER_PUBLIC_ORIGIN;
      try { return new URL(origin).host === req.headers.host; } catch { return false; }
    }
    // Some iOS embedded browsers submit a same-origin HTML form with Origin: null,
    // rather than omitting Origin. Trust that exceptional case ONLY with browser
    // Fetch Metadata explicitly proving same-origin, an exact public Host match,
    // and the existing one-use HMAC pre-token / authenticated CSRF verification.
    // Cross-site, same-site (subdomains), and unmarked requests still fail closed.
    if ((origin !== undefined && origin !== 'null') || req.headers['sec-fetch-site'] !== 'same-origin' || !env.BROKER_PUBLIC_ORIGIN) return false;
    try { return req.headers.host === new URL(env.BROKER_PUBLIC_ORIGIN).host; } catch { return false; }
  }

  // Banners (exposure alarm, writes disabled, not configured) are shown ONLY on authenticated pages: an anonymous visitor
  // learns nothing about the configuration or state of this service.
  function html(res, status, title, bodyHtml, { headers = {}, banner: showBanner = false } = {}) {
    const banner = !showBanner ? '' : ((!configured ? '<div class="bad">⚠ Not configured / غير مهيأ</div>' : '')
      + (exposure.alarm ? '<div class="bad">⚠ PRIVATE API REACHABLE VIA PUBLIC DOMAIN — fix the domain target port NOW / الواجهة الخاصة متاحة عبر النطاق العام</div>' : '')
      + (configured && !writesEnabled() ? '<div class="warn">Writes are DISABLED on this service (read-only) / الكتابة معطّلة</div>' : ''));
    const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
      + '<title>' + esc(title) + '</title><style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#111}main{max-width:720px;margin:auto}'
      + 'h1{font-size:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #ddd;padding:10px;border-radius:8px;unicode-bidi:plaintext}'
      + 'input,button,select{font:inherit;padding:12px;margin:6px 0;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #bbb}button{background:#0a58ca;color:#fff;border:0}button.danger{background:#b42318}button.ghost{background:#e5e7eb;color:#111}'
      + '.bad{background:#b42318;color:#fff;padding:10px;border-radius:8px;margin:8px 0;font-weight:600}.warn{background:#fff3cd;padding:10px;border-radius:8px;margin:8px 0}.ok{background:#d1fae5;padding:10px;border-radius:8px;margin:8px 0}'
      + 'a{color:#0a58ca}.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0}.dyn{unicode-bidi:plaintext}</style></head><body><main>'
      + banner + bodyHtml + '</main></body></html>';
    // NOT scrubbed: the page shows exactly what is stored/sent (everything is HTML-escaped). Proposals containing a secret are refused at creation.
    const out = page;
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
  const deviceCookie = (value) => '__Host-bdev=' + value + cookieAttrs + '; Max-Age=2592000';
  const deviceOf = (req) => parseCookies(req.headers.cookie)['__Host-bdev'];
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
  const htmlA = (res, status, title, bodyHtml, o = {}) => html(res, status, title, bodyHtml, { ...o, banner: true });

  const PAGE_SIZE = 20;
  async function consolePage(res, session, pageNo = 1) {
    const rows = []; const card = async (id, pendingOnly) => {
      try {
        const p = await loadProposal(id, brokerEnv);
        if (pendingOnly && outcomeOf(p) !== 'pending_operator_approval') { await indexRefresh(id); return; }
        rows.push('<div class="card"><a href="' + proposalLink(id) + '"><b>' + esc(p.type) + '</b> <span class="dyn">' + esc(id) + '</span></a><br>' + esc(outcomeOf(p)) + ' · ' + esc(p.expires_at) + '</div>');
      } catch (e) { rows.push('<div class="card bad">' + esc(id) + ': integrity check failed (' + esc(e.code ?? 'error') + ')</div>'); }
    };
    const pending = pendingIds(); const pages = Math.max(1, Math.ceil(pending.length / PAGE_SIZE)); const pg = Math.min(Math.max(1, pageNo), pages);
    for (const id of pending.slice((pg - 1) * PAGE_SIZE, pg * PAGE_SIZE)) await card(id, true);
    const pendingHtml = rows.splice(0).join('') || '<p>Nothing awaiting approval / لا يوجد ما ينتظر الاعتماد</p>';
    for (const id of recentIds(15)) await card(id, false);
    const nav = pages > 1 ? '<p>' + (pg > 1 ? '<a href="/console?page=' + (pg - 1) + '">← Newer</a> ' : '') + 'Page ' + pg + '/' + pages + (pg < pages ? ' <a href="/console?page=' + (pg + 1) + '">Older →</a>' : '') + '</p>' : '';
    const ss = await sessionStore.status().catch(() => ({ state: 'not_connected' }));
    htmlA(res, 200, 'Console', '<h1>Awaiting approval / بانتظار الاعتماد (' + pending.length + ')</h1>' + pendingHtml + nav
      + '<p><a href="/console/daftra-session">Daftra session for official PDFs / جلسة دفترة لملفات PDF الرسمية</a> — <b>' + esc(ss.state) + '</b></p>'
      + '<h2>Recent / الأحدث</h2>' + (rows.join('') || '<p>—</p>')
      + (pending.length ? '<form method="post" action="/console/reject_all"><input type="hidden" name="csrf" value="' + esc(session.csrf) + '"><button class="danger" type="submit">Reject ALL ' + pending.length + ' pending / رفض الكل (no code needed)</button></form>' : '')
      + '<form method="post" action="/logout"><input type="hidden" name="csrf" value="' + esc(session.csrf) + '"><button class="ghost">Sign out / خروج</button></form>');
  }

  async function proposalPage(res, session, id, { message, kind = 'warn' } = {}) {
    let p;
    try { p = await loadProposal(id, brokerEnv); }
    catch (e) { audit('proposal_integrity_failure', { id: safeText(id).slice(0, 30), code: e.code ?? 'error' }).catch(() => {}); return htmlA(res, 404, 'Proposal', '<div class="bad">Cannot show this proposal: ' + esc(e.code === 'ENOENT' || /not found/i.test(e.message) ? 'not found' : (e.code ?? 'integrity check failed')) + '</div><a href="/console">← Back</a>'); }
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
    if (canDecide) actions += '<form method="post" action="/proposal/' + esc(p.id) + '/reject">' + csrf + '<button class="danger" type="submit">Reject / رفض (no code needed)</button></form>';
    if (canResolve) actions += '<h2>Ambiguous outcome / نتيجة غير مؤكدة</h2><p>Check Daftra, then record what happened.</p><form method="post" action="/proposal/' + esc(p.id) + '/resolve">' + csrf
      + '<select name="created"><option value="false">NOT created in Daftra / لم يُنشأ</option><option value="true">Created in Daftra / أُنشئ</option></select><input name="record_id" inputmode="numeric" maxlength="15" placeholder="record id (optional)">' + codeField + '<button class="danger" type="submit">Record decision / تسجيل</button></form>';
    htmlA(res, 200, 'Proposal', (message ? '<div class="' + kind + '">' + esc(message) + '</div>' : '') + '<h1>Review / مراجعة</h1><p><b>' + esc(outcome) + '</b></p><pre>' + reviewLines(p).map((l) => esc(l)).join('\n') + '</pre>'
      + '<p>Request hash: <code class="dyn">' + esc(p.request_hash) + '</code></p>' + actions + '<p><a href="/console">← Back</a></p>');
  }

  // Declines every live pending proposal at once (session + CSRF only): junk flooded by a compromised agent is cleared in one tap.
  async function rejectAll(req, res, session) {
    let form; try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
    if (!sameOrigin(req) || !csrfOk(session, form)) { audit('csrf_rejected', { id: 'reject_all' }).catch(() => {}); return textReply(res, 403, 'Forbidden'); }
    if (!configured) return htmlA(res, 503, 'Unavailable', '<div class="bad">Not configured</div>');
    let n = 0; const actor = 'operator:' + session.short;
    for (const id of pendingIds()) {
      if (busy.has(id)) continue;
      busy.add(id);
      try {
        const p = await loadProposal(id, brokerEnv);
        if (outcomeOf(p) !== 'pending_operator_approval') continue;
        if (!(await acquireLock(brokerEnv, p.id + '.claim'))) continue;
        await updateProposal(p.id, { status: 'DECLINED', approved_by: actor, approved_at: new Date(now()).toISOString() }, brokerEnv);
        declined.set(p.request_hash, now() + declineTtlMs); n++;
      } catch { /* an unreadable/tampered file is left for the integrity view */ } finally { busy.delete(id); await indexRefresh(id).catch(() => {}); }
    }
    await audit('operator_reject_all', { count: n, session: session.short }).catch(() => {});
    return htmlA(res, 200, 'Rejected', '<div class="ok">Rejected ' + n + ' proposal(s) — nothing was sent. / تم رفض ' + n + '</div><a href="/console">← Back</a>');
  }

  // ---- Daftra session for official PDFs (operator only: session + CSRF + a FRESH authenticator code to connect) ------------------
  async function sessionPage(res, session, { message, kind = 'warn' } = {}) {
    const st = await sessionStore.status().catch(() => ({ state: 'not_connected' }));
    const csrf = '<input type="hidden" name="csrf" value="' + esc(session.csrf) + '">';
    const facts = [['Status / الحالة', st.state], ['Saved / حُفظت', st.saved_at ?? '—'], ['Last successful PDF / آخر نجاح', st.last_ok_at ?? '—'], ['Last failure / آخر فشل', st.last_failure_at ?? '—']]
      .map(([k, v]) => '<tr><td>' + esc(k) + '</td><td class="dyn">' + esc(v) + '</td></tr>').join('');
    htmlA(res, 200, 'Daftra session', (message ? '<div class="' + kind + '">' + esc(message) + '</div>' : '')
      + '<h1>Daftra session for official PDFs / جلسة دفترة</h1>'
      + '<div class="card"><table>' + facts + '</table></div>'
      + '<div class="card"><p>Sign in to Daftra in <b>your own browser</b>, then copy the session cookie <code>OISystem</code> '
      + '(browser developer tools → Application/Storage → Cookies → your Daftra site) and paste it below. '
      + 'Your Daftra password is never entered here and never reaches BASHT. The cookie is stored encrypted, used only to download invoice PDFs '
      + '(GET only), and never shown again. When Daftra signs you out, paste a new one. / '
      + 'سجّل الدخول إلى دفترة في متصفحك ثم الصق قيمة الكوكي <code>OISystem</code> هنا؛ لا تُدخل كلمة مرور دفترة هنا.</p>'
      + '<form method="post" action="/console/daftra-session" autocomplete="off">' + csrf
      + '<label>Cookie value or Cookie header / قيمة الكوكي<input type="password" name="cookie" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>'
      + '<label>Fresh authenticator code / رمز جديد<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>'
      + '<button type="submit">Save session / حفظ الجلسة</button></form></div>'
      + (st.state !== 'not_connected' ? '<form method="post" action="/console/daftra-session/clear">' + csrf + '<button class="danger" type="submit">Disconnect and delete / فصل وحذف</button></form>' : '')
      + '<p><a href="/console">← Back</a></p>');
  }

  async function saveSession(req, res, session) {
    let form; try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
    if (!sameOrigin(req) || !csrfOk(session, form)) { audit('csrf_rejected', { id: 'daftra_session' }).catch(() => {}); return textReply(res, 403, 'Forbidden'); }
    const parsed = parseCookieInput(String(form.get('cookie') ?? ''));
    if (!parsed.ok) return sessionPage(res, session, { message: parsed.error + ' / الكوكي غير صالح', kind: 'bad' });
    const ip = clientIp(req);
    const su = await auth.stepUp({ ip, code: String(form.get('code') ?? '').trim(), device: deviceOf(req), session });
    if (!su.ok) {
      audit('stepup_failed', { id: 'daftra_session', action: 'session_save', status: su.status, ip: ipHash(ip), session: session.short, revoked: su.revoked === true }).catch(() => {});
      if (su.revoked) return redirect(res, '/', { 'Set-Cookie': '__Host-bsess=deleted' + cookieAttrs + '; Max-Age=0' });
      return htmlA(res, su.status === 429 ? 429 : su.status === 503 ? 503 : 401, 'Code rejected', '<div class="bad">Code rejected' + (su.status === 429 ? ' — locked out, try later' : '') + '. Wait for a NEW code and retry. / الرمز مرفوض</div><a href="/console/daftra-session">← Back</a>');
    }
    await audit('operator_daftra_session_save', { cookies: parsed.pairs.length, step: su.step, session: session.short });   // audit BEFORE acting; never the values
    for (const [, v] of parsed.pairs) if (v.length >= 6) dynamicSecrets.add(v);
    await sessionStore.save(parsed.pairs);
    return sessionPage(res, session, { message: 'Session saved. Ask BASHT for an invoice PDF to verify it. / تم حفظ الجلسة', kind: 'ok' });
  }

  async function clearSession(req, res, session) {
    let form; try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
    if (!sameOrigin(req) || !csrfOk(session, form)) { audit('csrf_rejected', { id: 'daftra_session' }).catch(() => {}); return textReply(res, 403, 'Forbidden'); }
    await audit('operator_daftra_session_clear', { session: session.short });
    await sessionStore.clear();
    return sessionPage(res, session, { message: 'Session deleted. / تم حذف الجلسة', kind: 'ok' });
  }

  const busy = new Set();
  let enrollShown = false;
  const ledgerOk = async () => { await readLedger(brokerEnv); };

  async function decide(req, res, session, id, action) {
    let form;
    try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
    if (!sameOrigin(req) || !csrfOk(session, form)) { audit('csrf_rejected', { id }).catch(() => {}); return textReply(res, 403, 'Forbidden'); }
    if (!configured) return htmlA(res, 503, 'Unavailable', '<div class="bad">Not configured</div>');
    if (busy.has(id)) return htmlA(res, 409, 'Busy', '<div class="warn">Another decision on this proposal is in progress.</div><a href="' + proposalLink(id) + '">← Back</a>');
    busy.add(id);
    const ip = clientIp(req);
    try {
      let p;
      try { p = await loadProposal(id, brokerEnv); await ledgerOk(); }
      catch (e) { audit('integrity_failure', { id, code: e.code ?? 'error' }).catch(() => {}); return htmlA(res, 409, 'Integrity', '<div class="bad">Integrity check failed (' + esc(e.code ?? 'error') + '): nothing was done.</div>'); }
      const hash = String(form.get('hash') ?? '');
      if (!/^[0-9a-f]{64}$/.test(hash) || hash !== p.request_hash) return htmlA(res, 409, 'Changed', '<div class="bad">The request on this page is not the current request. Reload.</div>');
      const code = String(form.get('code') ?? '').trim();
      const outcome = outcomeOf(p);
      if (action === 'resolve') {
        const ledgerState = stateForHash(await readLedger(brokerEnv), p.request_hash);
        if (!['ambiguous', 'submitting'].includes(ledgerState)) return htmlA(res, 409, 'Not ambiguous', '<div class="warn">This proposal is not awaiting a decision.</div>');
      } else if (outcome !== 'pending_operator_approval') return htmlA(res, 409, 'Not pending', '<div class="warn">This proposal is not pending (' + esc(outcome) + ').</div><a href="' + proposalLink(id) + '">← Back</a>');
      if (action === 'approve' && !writesEnabled()) return htmlA(res, 409, 'Writes disabled', '<div class="bad">Writes are disabled on this service. Nothing was sent.</div>');
      // Rejecting is always safe, so it needs only the authenticated session + CSRF (the operator can always clear junk quickly);
      // approve / resolve need a FRESH single-use authenticator code.
      let step = null;
      if (action !== 'reject') {
        const su = await auth.stepUp({ ip, code, device: deviceOf(req), session });
        if (!su.ok) {
          audit('stepup_failed', { id, action, status: su.status, ip: ipHash(ip), session: session.short, revoked: su.revoked === true }).catch(() => {});
          if (su.revoked) return redirect(res, '/', { 'Set-Cookie': '__Host-bsess=deleted' + cookieAttrs + '; Max-Age=0' });
          return htmlA(res, su.status === 429 ? 429 : su.status === 503 ? 503 : 401, 'Code rejected', '<div class="bad">Code rejected' + (su.status === 429 ? ' — locked out, try later' : '') + '. Wait for a NEW code and retry. / الرمز مرفوض</div><a href="' + proposalLink(id) + '">← Back</a>');
        }
        step = su.step;
      }
      const actor = 'operator:' + session.short;
      await audit('operator_' + action, { id, hash: p.request_hash.slice(0, 12), step, session: session.short });     // audit BEFORE acting: tamper/IO failure => nothing happens
      if (action === 'approve') {
        let result;
        try { result = await executeProposal({ id, phrase: approvalPhrase(brokerEnv, p), actor }, { env: brokerEnv, fetcher, now: now() }); }
        catch (e) {
          await audit('approve_refused', { id, code: e.code ?? 'error' }).catch(() => {});
          return htmlA(res, 409, 'Refused', '<div class="bad">Refused (' + esc(e.code ?? 'error') + '): ' + esc(scrub(e.message)) + '</div><a href="' + proposalLink(id) + '">← Back</a>');
        }
        await audit('approve_result', { id, status: result.status, record_id: result.record_id ?? null, http: result.http_status ?? null }).catch(() => {});
        const good = result.ok === true;
        return htmlA(res, 200, 'Result', '<div class="' + (good ? 'ok' : 'bad') + '"><b>' + esc(result.status) + '</b>' + (result.record_id ? ' · record ' + esc(result.record_id) : '') + '<br>' + esc(scrub(result.message ?? ''))
          + (result.needs_review ? '<br><b>' + esc(result.needs_review) + '</b>' : '') + '</div><a href="/console">← Back</a>');
      }
      if (action === 'reject') {
        const claimed = await acquireLock(brokerEnv, p.id + '.claim');                      // consumes the proposal for good
        if (!claimed) return htmlA(res, 409, 'Already used', '<div class="warn">Already used.</div>');
        await updateProposal(p.id, { status: 'DECLINED', approved_by: actor, approved_at: new Date(now()).toISOString() }, brokerEnv);
        declined.set(p.request_hash, now() + declineTtlMs);                                  // the agent cannot nag with the identical request
        return htmlA(res, 200, 'Rejected', '<div class="ok">Rejected — nothing was sent. / تم الرفض</div><a href="/console">← Back</a>');
      }
      // resolve
      const created = form.get('created') === 'true'; const recordId = String(form.get('record_id') ?? '').trim();
      if (recordId && !/^[0-9]{1,15}$/.test(recordId)) return htmlA(res, 400, 'Invalid', '<div class="bad">Invalid record id.</div>');
      try {
        await resolveProposal({ id, created, recordId: recordId || undefined, code: resolveCode(brokerEnv, id, created), actor }, { env: brokerEnv });
      } catch (e) { return htmlA(res, 409, 'Refused', '<div class="bad">Refused (' + esc(e.code ?? 'error') + '): ' + esc(scrub(e.message)) + '</div>'); }
      return htmlA(res, 200, 'Recorded', '<div class="ok">Recorded. / تم التسجيل</div><a href="/console">← Back</a>');
    } finally { busy.delete(id); await indexRefresh(id).catch(() => {}); }
  }

  async function handleConsole(req, res) {
    const url = new URL(req.url, 'http://x'); const path = url.pathname; const method = req.method;
    if (method === 'GET' && (path === '/healthz' || path === '/setup/healthz')) return textReply(res, 200, 'ok');
    if (path.startsWith('/v1/')) return textReply(res, 404, 'Not Found');
    // Optional hardening: when Railway's edge is known to add its headers, a console request WITHOUT them did not come through the
    // public edge (e.g. it came over the private network) and is refused. Off by default (the exact edge headers are not proven).
    if (env.BROKER_CONSOLE_REQUIRE_EDGE === '1' && !Object.keys(req.headers).some((h) => EDGE_HEADER.test(h))) return textReply(res, 404, 'Not Found');
    const ip = clientIp(req);
    await auth.ready();
    if (method === 'GET' && path === '/') {
      if (!configured) return html(res, 503, 'BASHT Daftra', '<h1>BASHT Daftra</h1><p>Service unavailable / الخدمة غير متاحة</p>');
      return html(res, 200, 'Sign in', loginForm(auth.issuePre()));
    }
    if (method === 'POST' && path === '/login') {
      let form; try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
      if (!sameOrigin(req)) return textReply(res, 403, 'Forbidden');
      if (!configured) return html(res, 503, 'BASHT Daftra', '<p>Service unavailable / الخدمة غير متاحة</p>');
      if (!auth.consumePre(form.get('pre'))) return html(res, 400, 'Sign in', loginForm(auth.issuePre(), 'Form expired — try again / انتهت صلاحية النموذج'));
      const r = await auth.login({ password: form.get('password') ?? '', code: form.get('code') ?? '', ip, device: deviceOf(req) });
      if (!r.ok) {
        noteEvent('login_failed', ip);
        return html(res, r.status, 'Sign in', loginForm(auth.issuePre(), r.status === 429 ? 'Too many attempts — try later / محاولات كثيرة' : r.status === 503 ? 'Unavailable' : 'Invalid credentials / بيانات غير صحيحة'));
      }
      await flushAgg();                                     // failures that preceded this success must appear BEFORE it in the audit chain
      await audit('login_ok', { ip: ipHash(ip), session: r.session.short, device: r.device ? 'issued' : 'presented' }).catch(() => {});
      const cookies = [sessionCookie(r.session.id, 1800)]; if (r.device) cookies.push(deviceCookie(r.device));
      return redirect(res, '/console', { 'Set-Cookie': cookies });
    }
    if (path === '/enroll') {
      if (env.OPERATOR_ENROLLMENT !== '1' || !configured || enrollShown) return textReply(res, 404, 'Not Found');   // one successful display per start
      if (method === 'GET') return html(res, 200, 'Enroll', '<h1>Authenticator enrollment / تسجيل المصادقة</h1><form method="post" action="/enroll"><input type="hidden" name="pre" value="' + esc(auth.issuePre()) + '"><label>Password<input type="password" name="password" required></label><button>Show setup key</button></form>');
      if (method === 'POST') {
        let form; try { form = await readForm(req); } catch (e) { return textReply(res, e.status ?? 400, 'Bad request'); }
        if (!sameOrigin(req)) {
          let originInfo = { originValidUrl: false, originIsNull: req.headers.origin === 'null',
            originHostMatchesConfigured: false, originSchemeHttps: false, requestHostMatchesConfigured: false };
          try {
            const configUrl = new URL(env.BROKER_PUBLIC_ORIGIN);
            originInfo.requestHostMatchesConfigured = req.headers.host === configUrl.host;
            try {
              const originUrl = new URL(String(req.headers.origin ?? ''));
              originInfo.originValidUrl = true;
              originInfo.originHostMatchesConfigured = originUrl.host === configUrl.host;
              originInfo.originSchemeHttps = originUrl.protocol === 'https:';
            } catch { /* keep only safe classifications */ }
          } catch { /* keep only safe classifications */ }
          log({ level: 'warn', msg: 'operator enrollment rejected: origin policy',
            originPresent: typeof req.headers.origin === 'string',
            sameSiteBrowserMetadata: req.headers['sec-fetch-site'] === 'same-origin',
            ...originInfo });
          return textReply(res, 403, 'Forbidden');
        }
        if (!auth.consumePre(form.get('pre'))) {
          log({ level: 'warn', msg: 'operator enrollment rejected: one-time form token invalid or expired' });
          return textReply(res, 403, 'Forbidden');
        }
        const r = await auth.verifyPasswordOnly({ password: form.get('password') ?? '', ip });
        if (!r.ok) { noteEvent('enroll_failed', ip); return html(res, r.status, 'Enroll', '<div class="bad">Invalid / غير صحيح</div>'); }
        if (enrollShown) return textReply(res, 404, 'Not Found');
        enrollShown = true;                                                              // auto-disable: the key is shown ONCE per process start
        await audit('enroll_shown', { ip: ipHash(ip) }).catch(() => {});
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
    if (path === '/console/daftra-session' || path === '/console/daftra-session/clear') {
      if (!session) return redirect(res, '/');
      if (!configured) return htmlA(res, 503, 'Unavailable', '<div class="bad">Not configured</div>');
      if (path === '/console/daftra-session' && method === 'GET') return sessionPage(res, session);
      if (path === '/console/daftra-session' && method === 'POST') return saveSession(req, res, session);
      if (path === '/console/daftra-session/clear' && method === 'POST') return clearSession(req, res, session);
      return textReply(res, 405, 'Method Not Allowed');
    }
    if (path === '/console' || path === '/console/reject_all' || path.startsWith('/proposal/')) {
      if (!session) return redirect(res, '/');
      if (!configured) return htmlA(res, 503, 'Unavailable', '<div class="bad">Not configured</div>');
      if (path === '/console/reject_all') return method === 'POST' ? rejectAll(req, res, session) : textReply(res, 405, 'Method Not Allowed');
      if (method === 'GET' && path === '/console') return consolePage(res, session, Number(url.searchParams.get('page')) || 1);
      const m = /^\/proposal\/(prop_[0-9a-f]{16})(?:\/(approve|reject|resolve))?$/.exec(path);
      if (!m) return textReply(res, 404, 'Not Found');
      if (method === 'GET' && !m[2]) return proposalPage(res, session, m[1]);
      if (method === 'POST' && m[2]) return decide(req, res, session, m[1], m[2]);
      return textReply(res, 405, 'Method Not Allowed');
    }
    return textReply(res, 404, 'Not Found');
  }

  // ---- servers ----------------------------------------------------------------------------------------------
  const guard = (fn, limiter, keyOf) => (req, res) => {
    // global + per-peer pre-auth limiter: refuses BEFORE any parsing, auth, audit or state access
    const k = keyOf(req);
    if (!limiter(k.peer, k.opts)) { noteEvent('preauth_rate_limited', k.peer); res.writeHead(429, { 'Retry-After': '1', 'Content-Length': 0, Connection: 'close' }); res.end(); return; }
    fn(req, res).catch((e) => {
      log({ level: 'error', error: scrub(e?.message ?? 'error').slice(0, 200) });
      if (!res.headersSent) { try { res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Internal error'); } catch { /* closed */ } }
    });
  };
  // PUBLIC limiter key: the trusted client IP (validated X-Real-IP only when BROKER_TRUST_PROXY=1, else the socket address), a coarse
  // bucket on the socket address (bounds header-rotation from one source), the operator's session cookie (cheap lookup), health checks.
  const publicKey = (req) => {
    const socket = req.socket.remoteAddress ?? 'unknown';
    const sid = parseCookies(req.headers.cookie)['__Host-bsess'];
    const session = sid && auth.peekSession(sid) ? sid.slice(0, 16) : undefined;
    const health = req.method === 'GET' && (req.url === '/healthz' || req.url === '/setup/healthz');
    return { peer: clientIp(req), opts: { session, socket, health } };
  };
  const privateKey = (req) => ({ peer: req.socket.remoteAddress ?? 'unknown', opts: {} });
  const timeouts = options.timeoutsMs ?? {};
  const harden = (s) => {
    s.headersTimeout = timeouts.headers ?? 10_000; s.requestTimeout = timeouts.request ?? 30_000;
    s.connectionsCheckingInterval = timeouts.check ?? 2_000;      // node enforces the two timeouts only at this cadence (default 30 s)
    s.keepAliveTimeout = 5_000;
    s.maxRequestsPerSocket = 100;                                  // one connection can never serve unbounded requests
    s.on('clientError', (err, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); } catch { socket.destroy(); } });
    return s;
  };
  // node enforces headersTimeout/requestTimeout only every `connectionsCheckingInterval` (constructor option; default 30 s)
  const serverOptions = { maxHeaderSize: 16384, headersTimeout: timeouts.headers ?? 10_000, requestTimeout: timeouts.request ?? 30_000, connectionsCheckingInterval: timeouts.check ?? 2_000 };
  const publicServer = harden(http.createServer(serverOptions, guard(handleConsole, publicLimiter, publicKey)));
  const privateServer = harden(http.createServer(serverOptions, guard(handleApi, privateLimiter, privateKey)));
  const listenOn = (server, port, host) => new Promise((ok, fail) => { server.once('error', fail); server.listen(Number(port), host, () => { server.off('error', fail); ok(server.address()); }); });

  async function listen() {
    const pubPort = options.publicPort ?? env.PORT ?? 8080; const privPort = options.privatePort ?? env.BROKER_PRIVATE_PORT ?? 8081;
    if (String(pubPort) === String(privPort) && String(pubPort) !== '0') throw new Error('PORT and BROKER_PRIVATE_PORT must differ');
    if (!configured) log({ level: 'warn', msg: 'SERVICE NOT CONFIGURED: writes impossible', issues });
    else if (!writesEnabled()) log({ level: 'info', msg: 'writes are DISABLED (DAFTRA_WRITES_ENABLED is not 1)' });
    await auth.ready();
    if (configured) { await rememberSessionSecrets(); await indexLoad(); await prune(); try { await ensureAuditHead(); } catch (e) { if (e.code === 'AUDIT_TAMPERED') log({ level: 'error', msg: 'audit chain failed verification: approvals are refused until the audit file is investigated' }); } }
    if (env.OPERATOR_STATE_RESET === '1') {
      // Break-glass: ALWAYS clears lock counters (never the replay high-water mark); a corrupt state file is replaced as well.
      if (auth.broken) { await auth.reset(); await audit('operator_state_reset', {}).catch(() => {}); log({ level: 'warn', msg: 'operator state was reset (OPERATOR_STATE_RESET=1): unset it' }); }
      else if (await auth.clearLocks()) { await audit('operator_locks_cleared', {}).catch(() => {}); log({ level: 'warn', msg: 'operator lockouts were cleared (OPERATOR_STATE_RESET=1): unset it' }); }
    }
    else if (auth.broken) log({ level: 'error', msg: 'operator state failed authentication: logins refused. Set OPERATOR_STATE_RESET=1 once to recover.', reason: auth.broken });
    const pub = await listenOn(publicServer, pubPort, options.publicHost ?? env.BROKER_PUBLIC_HOST ?? '::');
    const priv = await listenOn(privateServer, privPort, options.privateHost ?? env.BROKER_PRIVATE_HOST ?? '::');
    timer = setInterval(() => { flushAgg(); prune().catch(() => {}); }, 60_000); timer.unref?.();
    return { public: pub, private: priv };
  }
  let timer = null;
  async function close() {
    if (timer) { clearInterval(timer); timer = null; }
    await flushAgg().catch(() => {});
    await auth.flush().catch(() => {});
    await auditQueue.catch(() => {});                       // let in-flight audit appends finish before the volume is released
    await Promise.all([publicServer, privateServer].map((s) => new Promise((ok) => { s.close(() => ok()); s.closeAllConnections?.(); })));
  }
  return {
    listen, close, publicServer, privateServer, issues, configured, writesEnabled, exposure,
    publicAddress: () => publicServer.address(), privateAddress: () => privateServer.address(),
    _auth: auth, _brokerEnv: brokerEnv, _stateDir: cfg.stateDir, _flushAggregates: flushAgg, _prune: prune, _indexSize: () => index.size, _indexBytes: () => indexBytes, _pendingCount: pendingCount,
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
