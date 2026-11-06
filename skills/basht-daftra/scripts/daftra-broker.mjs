#!/usr/bin/env node
// PRIVILEGED BROKER: the only process that holds DAFTRA_APPROVAL_SECRET and the write-capable Daftra key.
// Run it as the OPERATOR (a different OS user than the agent) with secrets in root-only files:
//   DAFTRA_BROKER_SOCKET=/run/basht/broker.sock            (required, absolute)
//   DAFTRA_APPROVAL_SECRET_FILE=/etc/basht/approval.secret (0400/0600, regular file, >=32 chars)
//   DAFTRA_WRITE_API_KEY_FILE=/etc/basht/daftra-write.key  (or DAFTRA_WRITE_API_KEY)
//   DAFTRA_BASE_URL, DAFTRA_WRITES_ENABLED=1, OPENCLAW_WORKSPACE_DIR=<broker-private state dir>
// Wire protocol: newline-delimited JSON, ONE request -> ONE reply -> close. 256 KiB max, 30 s timeout.
//   {cmd:'ping'} | {cmd:'propose',type,input,actor?} | {cmd:'propose_duplicate',source,docId,overrides,actor?} | {cmd:'show',id} | {cmd:'execute',id,phrase,actor?}
//   | {cmd:'resolve',id,created,recordId?,code,actor?}
// Reply: {ok:true,result} or {ok:false,error,refused?}. Anything else (unknown command, unknown field, wrong type,
// env/secret/path fields) is rejected. Approval phrases and codes are NEVER returned.
import net from 'node:net';
import { chmodSync, chownSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { approvalSecret, readSecret } from './daftra-auth.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { executeProposal, resolveProposal, WriteRefused } from './daftra-write.mjs';
import { loadProposal } from './daftra-ledger.mjs';
import { proposeDuplicate } from './daftra-duplicate.mjs';
import { publicProposal } from './daftra-public.mjs';
import { MAX_MESSAGE_BYTES } from './daftra-broker-client.mjs';

const SCHEMAS = Object.freeze({
  ping: { required: [], optional: [] },
  propose: { required: ['type', 'input'], optional: ['actor'] },
  propose_duplicate: { required: ['source', 'docId', 'overrides'], optional: ['actor'] },
  show: { required: ['id'], optional: [] },
  execute: { required: ['id', 'phrase'], optional: ['actor'] },
  resolve: { required: ['id', 'created', 'code'], optional: ['recordId', 'actor'] },
});
const ACTOR = /^[\p{L}\p{N} ._@:-]{1,64}$/u;
const ID_LIKE = /^[A-Za-z0-9_-]{1,64}$/;

class BadRequest extends Error {}

export function validateRequest(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new BadRequest('Request must be a JSON object');
  const keys = Object.keys(msg);
  const cmd = msg.cmd;
  if (typeof cmd !== 'string' || !Object.hasOwn(SCHEMAS, cmd)) throw new BadRequest('Unknown command');
  const schema = SCHEMAS[cmd];
  const allowed = new Set(['cmd', ...schema.required, ...schema.optional]);
  for (const k of keys) if (!allowed.has(k)) throw new BadRequest('Unexpected field: ' + k.slice(0, 40));
  for (const k of schema.required) if (!Object.hasOwn(msg, k)) throw new BadRequest('Missing field: ' + k);
  if (Object.hasOwn(msg, 'actor') && (typeof msg.actor !== 'string' || !ACTOR.test(msg.actor))) throw new BadRequest('Invalid actor');
  if (cmd === 'propose') {
    if (typeof msg.type !== 'string' || !/^[a-z_]{1,40}$/.test(msg.type)) throw new BadRequest('Invalid type');
    if (!msg.input || typeof msg.input !== 'object' || Array.isArray(msg.input)) throw new BadRequest('input must be an object');
  } else if (cmd === 'propose_duplicate') {
    if (typeof msg.source !== 'string' || !/^[a-z_]{1,40}$/.test(msg.source)) throw new BadRequest('Invalid source');
    if (typeof msg.docId !== 'string' || !/^[1-9]\d{0,14}$/.test(msg.docId)) throw new BadRequest('Invalid docId');
    if (!msg.overrides || typeof msg.overrides !== 'object' || Array.isArray(msg.overrides)) throw new BadRequest('overrides must be an object');
  } else if (cmd === 'show' || cmd === 'execute' || cmd === 'resolve') {
    if (typeof msg.id !== 'string' || !ID_LIKE.test(msg.id)) throw new BadRequest('Invalid id');
  }
  if (cmd === 'execute' && (typeof msg.phrase !== 'string' || msg.phrase.length > 300)) throw new BadRequest('Invalid phrase');
  if (cmd === 'resolve') {
    if (typeof msg.created !== 'boolean') throw new BadRequest('created must be a boolean');
    if (typeof msg.code !== 'string' || msg.code.length > 100) throw new BadRequest('Invalid code');
    if (Object.hasOwn(msg, 'recordId') && !(typeof msg.recordId === 'string' || Number.isSafeInteger(msg.recordId))) throw new BadRequest('Invalid recordId');
    if (Object.hasOwn(msg, 'recordId') && !/^[0-9]{1,15}$/.test(String(msg.recordId))) throw new BadRequest('Invalid recordId');
  }
  return msg;
}

// The environment the broker works with: its OWN env, with secrets resolved from files, and the write key used
// for every Daftra call it makes. Nothing from a client ever reaches it.
export function buildBrokerEnv(env = process.env) {
  const out = { ...env };
  const writeKey = readSecret(env, 'DAFTRA_WRITE_API_KEY') ?? env.DAFTRA_API_KEY;
  if (!writeKey) throw new Error('DAFTRA_WRITE_API_KEY (or _FILE) is required for the broker');
  out.DAFTRA_API_KEY = writeKey;
  out.DAFTRA_APPROVAL_SECRET = approvalSecret(env);          // validates strength + file permissions now (fail fast)
  delete out.DAFTRA_APPROVAL_SECRET_FILE;
  delete out.DAFTRA_WRITE_API_KEY_FILE; delete out.DAFTRA_WRITE_API_KEY;
  return out;
}

function scrubber(secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  return (text) => { let out = String(text); for (const s of list) out = out.split(s).join('[redacted]'); return out; };
}

export async function handle(msg, { env, fetcher }) {
  switch (msg.cmd) {
    case 'ping': return { broker: 'basht-daftra', writes_enabled: env.DAFTRA_WRITES_ENABLED === '1' };
    case 'propose': return publicProposal(await createProposal(msg.type, msg.input, { env, fetcher, actor: msg.actor ?? 'unknown' }));
    case 'propose_duplicate': return publicProposal(await proposeDuplicate({ source: msg.source, id: msg.docId, overrides: msg.overrides }, { env, fetcher, actor: msg.actor ?? 'unknown' }));
    case 'show': return publicProposal(await loadProposal(msg.id, env));
    case 'execute': return executeProposal({ id: msg.id, phrase: msg.phrase, actor: msg.actor ?? 'unknown' }, { env, fetcher });
    case 'resolve': return resolveProposal({ id: msg.id, created: msg.created, recordId: msg.recordId, code: msg.code, actor: msg.actor ?? 'unknown' }, { env });
    default: throw new BadRequest('Unknown command');
  }
}

function refuseUnsafeSocketPath(path, mode) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('DAFTRA_BROKER_SOCKET must be an absolute path');
  if (path.length > 100) throw new Error('Socket path too long');
  if (!/^[0-7]{3,4}$/.test(String(mode)) || (parseInt(String(mode), 8) & 0o007) !== 0) throw new Error('Socket mode must be octal and give no access to "others" (e.g. 600 or 660)');
  let dirStat;
  try { dirStat = lstatSync(dirname(path)); } catch { throw new Error('Socket directory does not exist'); }
  if (!dirStat.isDirectory()) throw new Error('Socket directory is not a directory');
  if ((dirStat.mode & 0o002) !== 0) throw new Error('Socket directory must not be world-writable');
}

function probeAlive(path) {
  return new Promise((done) => {
    const s = net.createConnection(path);
    const end = (alive) => { s.destroy(); done(alive); };
    s.setTimeout(1000, () => end(true));          // something is there but unresponsive: treat as alive
    s.on('connect', () => end(true));
    s.on('error', (e) => end(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'));
  });
}

// options: { env, fetcher, socketPath, mode ('600' default), gid, maxConnections }
export function createBroker(options = {}) {
  const base = options.env ?? process.env;
  const socketPath = options.socketPath ?? base.DAFTRA_BROKER_SOCKET;
  const mode = String(options.mode ?? base.DAFTRA_BROKER_SOCKET_MODE ?? '600');
  const gidRaw = options.gid ?? base.DAFTRA_BROKER_SOCKET_GID;
  const fetcher = options.fetcher ?? fetch;
  refuseUnsafeSocketPath(socketPath, mode);
  const env = buildBrokerEnv(base);
  const scrub = scrubber([env.DAFTRA_API_KEY, env.DAFTRA_APPROVAL_SECRET]);
  const connections = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (connections.size >= (options.maxConnections ?? 64)) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    const chunks = []; let size = 0; let done = false; let dispatched = false;
    // scrub the WHOLE serialised reply: upstream error text can end up inside successful results (e.g. proposal checks)
    const reply = (obj) => { if (done) return; done = true; socket.end(scrub(JSON.stringify(obj)) + '\n'); };
    const serve = async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return reply({ ok: false, error: 'Invalid JSON' }); }
      try {
        validateRequest(msg);
        reply({ ok: true, result: await handle(msg, { env, fetcher }) });
      } catch (e) {
        if (e instanceof BadRequest) return reply({ ok: false, error: e.message, refused: 'BAD_REQUEST' });
        const body = { ok: false, error: scrub(e?.message ?? 'Internal error').slice(0, 600) };
        if (e instanceof WriteRefused || typeof e?.code === 'string') body.refused = String(e.code);
        reply(body);
      }
    };
    socket.on('data', (d) => {
      if (done || dispatched) return;
      size += d.length;
      if (size > MAX_MESSAGE_BYTES) { reply({ ok: false, error: 'Request too large', refused: 'BAD_REQUEST' }); socket.destroy(); return; }
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) { dispatched = true; chunks.length = 0; serve(buf.subarray(0, nl).toString('utf8')); }
    });
    socket.on('end', () => { if (dispatched) return; dispatched = true; if (!done && chunks.length) serve(Buffer.concat(chunks).toString('utf8')); else if (!done) reply({ ok: false, error: 'Empty request', refused: 'BAD_REQUEST' }); });
  });

  async function listen() {
    // Never follow a symlink; only ever remove a stale SOCKET that nobody answers.
    let st = null;
    try { st = lstatSync(socketPath); } catch { /* absent */ }
    if (st) {
      if (st.isSymbolicLink()) throw new Error('Socket path is a symlink: refusing to start');
      if (!st.isSocket()) throw new Error('Socket path exists and is not a socket: refusing to start');
      if (await probeAlive(socketPath)) throw new Error('Another broker is already listening on this socket');
      unlinkSync(socketPath);
    }
    // Create the socket with the final permissions from the first instant (no umask race window).
    const old = process.umask(0o777 ^ parseInt(mode, 8));
    try {
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(socketPath, () => { server.off('error', fail); ok(); }); });
    } finally { process.umask(old); }
    chmodSync(socketPath, parseInt(mode, 8));
    if (gidRaw !== undefined && gidRaw !== '') {
      if (!/^[0-9]{1,10}$/.test(String(gidRaw))) throw new Error('DAFTRA_BROKER_SOCKET_GID must be numeric');
      chownSync(socketPath, -1, Number(gidRaw));
    }
    return socketPath;
  }
  async function close() {
    await new Promise((ok) => {
      server.close(() => ok());
      for (const s of connections) s.end();
      setTimeout(() => { for (const s of connections) s.destroy(); }, 2000).unref();
    });
    try { if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath); } catch { /* gone */ }
  }
  return { listen, close, server, socketPath };
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  try {
    const broker = createBroker();
    await broker.listen();
    console.log(JSON.stringify({ ok: true, broker: 'basht-daftra', socket: broker.socketPath, pid: process.pid }));
    const stop = () => broker.close().then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
