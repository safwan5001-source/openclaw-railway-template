import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, symlink, chmod, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { createBroker, validateRequest } from './daftra-broker.mjs';
import { callBroker } from './daftra-broker-client.mjs';
import { run } from './daftra-cli.mjs';
import { review } from './daftra-approve.mjs';
import { approvalSecret, readSecretFile, ApprovalConfigError } from './daftra-auth.mjs';

const OP_SECRET = 'operator-secret-0123456789-0123456789-abcdef';
const WRITE_KEY = 'WRITE-KEY-aaaaaaaaaaaaaaaa';
const READ_KEY = 'READ-KEY-bbbbbbbbbbbbbbbbb';
const invoiceInput = { client_id: 4, date: '2025-03-01', items: [{ item: 'Diesel', quantity: '100', unit_price: '2', tax1: 1 }] };

async function setup(extraBrokerEnv = {}) {
  const base = await mkdtemp(join(tmpdir(), 'basht-broker-'));
  await mkdir(join(base, 'secrets'), { mode: 0o700 });
  await mkdir(join(base, 'run'), { mode: 0o700 });
  await mkdir(join(base, 'state'), { mode: 0o700 });
  await mkdir(join(base, 'agent-ws'), { mode: 0o700 });
  await writeFile(join(base, 'secrets', 'approval'), OP_SECRET + '\n', { mode: 0o600 });
  await writeFile(join(base, 'secrets', 'writekey'), WRITE_KEY + '\n', { mode: 0o600 });
  const sock = join(base, 'run', 'b.sock');
  const brokerEnv = {
    OPENCLAW_WORKSPACE_DIR: join(base, 'state'), DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_WRITES_ENABLED: '1',
    DAFTRA_APPROVAL_SECRET_FILE: join(base, 'secrets', 'approval'), DAFTRA_WRITE_API_KEY_FILE: join(base, 'secrets', 'writekey'),
    DAFTRA_BROKER_SOCKET: sock, ...extraBrokerEnv,
  };
  const clientEnv = { OPENCLAW_WORKSPACE_DIR: join(base, 'agent-ws'), DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: READ_KEY, DAFTRA_BROKER_SOCKET: sock };
  const fake = new FakeDaftra();
  fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
  const broker = createBroker({ env: brokerEnv, fetcher: fake.fetch });
  await broker.listen();
  return { base, sock, brokerEnv, clientEnv, fake, broker, done: async () => { await broker.close(); await rm(base, { recursive: true, force: true }); } };
}

function rawSend(sock, bytes, { end = false } = {}) {
  return new Promise((resolve) => {
    const s = net.createConnection(sock); const out = [];
    s.on('connect', () => { s.write(bytes); if (end) s.end(); });
    s.on('data', (d) => out.push(d));
    s.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
    s.on('error', () => resolve(Buffer.concat(out).toString('utf8')));
  });
}

test('end to end: agent env has NO secret; propose and execute go through the broker; POST uses the WRITE key, reads use the READ key', async () => {
  const c = await setup();
  try {
    assert.equal(c.clientEnv.DAFTRA_APPROVAL_SECRET, undefined);
    assert.equal(c.clientEnv.DAFTRA_APPROVAL_SECRET_FILE, undefined);
    const p = await run(['propose', 'sales_invoice', '--input', JSON.stringify(invoiceInput), '--actor', 'user-1'], { env: c.clientEnv, fetcher: async () => { throw Error('agent must not do network for propose'); } });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(JSON.stringify(p).includes('APPROVE prop_'), false);
    assert.equal(c.fake.posts.length, 0);
    // the agent cannot execute with a guess
    await assert.rejects(run(['execute', p.proposal_id, '--phrase', 'APPROVE ' + p.proposal_id + ' ' + p.request_hash.slice(0, 8) + ' DRAFT'], { env: c.clientEnv }), (e) => e.code === 'PHRASE_MISMATCH');
    assert.equal(c.fake.posts.length, 0);
    // the human/operator, holding the secret (via file), reviews and obtains the phrase
    const text = await review(p.proposal_id, c.brokerEnv);
    const phrase = text.match(/APPROVE prop_\S+ \S+ DRAFT [0-9a-f]{16}/)[0];
    assert.match(text, /\/api2\/invoices\.json/);
    const shown = await run(['show', p.proposal_id], { env: c.clientEnv });
    assert.equal(shown.request_hash, p.request_hash);
    // parallel executes with the right phrase: exactly one POST
    const results = await Promise.allSettled([1, 2, 3].map(() => run(['execute', p.proposal_id, '--phrase', phrase, '--actor', 'user-1'], { env: c.clientEnv })));
    assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.status === 'submitted').length, 1);
    assert.equal(c.fake.posts.length, 1);
    assert.equal(c.fake.posts[0].headers.APIKEY, WRITE_KEY);
    assert.ok(c.fake.calls.every((x) => x.headers.APIKEY === WRITE_KEY), 'every broker call uses the write key');
    // reads by the agent use the READ key and never the write key
    const before = c.fake.calls.length;
    await run(['get', 'clients', '4'], { env: c.clientEnv, fetcher: c.fake.fetch });
    const clientCalls = c.fake.calls.slice(before);
    assert.ok(clientCalls.length === 1 && clientCalls[0].headers.APIKEY === READ_KEY);
    // nothing sensitive crossed the wire back to the agent
    assert.equal(JSON.stringify([p, shown, results]).includes(OP_SECRET), false);
    assert.equal(JSON.stringify([p, shown, results]).includes(WRITE_KEY), false);
  } finally { await c.done(); }
});

test('CLI in broker mode never runs propose/execute locally, even when a secret is (wrongly) in the agent env', async () => {
  const c = await setup();
  try {
    const leaky = { ...c.clientEnv, DAFTRA_APPROVAL_SECRET: OP_SECRET, DAFTRA_WRITES_ENABLED: '1', DAFTRA_BROKER_SOCKET: join(c.base, 'run', 'missing.sock') };
    await assert.rejects(run(['propose', 'sales_invoice', '--input', JSON.stringify(invoiceInput)], { env: leaky, fetcher: c.fake.fetch }), /Cannot reach the broker/);
    await assert.rejects(run(['execute', 'prop_' + 'a'.repeat(16), '--phrase', 'x'], { env: leaky, fetcher: c.fake.fetch }), /Cannot reach the broker/);
    assert.equal(c.fake.calls.length, 0);
    const caps = await run(['capabilities'], { env: leaky });
    assert.equal(caps.broker_mode, true);
    assert.ok(caps.env_warnings.some((w) => /DAFTRA_APPROVAL_SECRET is present/.test(w)));
  } finally { await c.done(); }
});

test('resolve needs an operator-derived code and goes through the broker', async () => {
  const c = await setup();
  c.fake.post = () => ({ status: 503, json: {} });
  try {
    const { resolveCode } = await import('./daftra-auth.mjs');
    const p = await run(['propose', 'sales_invoice', '--input', JSON.stringify(invoiceInput)], { env: c.clientEnv });
    const phrase = (await review(p.proposal_id, c.brokerEnv)).match(/APPROVE prop_\S+ \S+ DRAFT [0-9a-f]{16}/)[0];
    assert.equal((await run(['execute', p.proposal_id, '--phrase', phrase], { env: c.clientEnv })).status, 'ambiguous');
    await assert.rejects(run(['resolve', p.proposal_id, '--created', 'false', '--code', 'guess'], { env: c.clientEnv }), (e) => e.code === 'PHRASE_MISMATCH');
    const code = resolveCode({ DAFTRA_APPROVAL_SECRET: OP_SECRET }, p.proposal_id, false);
    assert.equal((await run(['resolve', p.proposal_id, '--created', 'false', '--code', code, '--record-id', '12'], { env: c.clientEnv })).state, 'resolved_not_created');
  } finally { await c.done(); }
});

test('malformed, oversized, unknown and over-broad requests are rejected and the broker keeps serving', async () => {
  const c = await setup();
  try {
    const bad = [
      'not json\n', '[]\n', '"str"\n', 'null\n', '42\n', '{}\n',
      JSON.stringify({ cmd: 'nope' }) + '\n',
      JSON.stringify({ cmd: 'ping', extra: 1 }) + '\n',
      JSON.stringify({ cmd: 'ping', env: { DAFTRA_APPROVAL_SECRET: 'x' } }) + '\n',
      JSON.stringify({ cmd: 'propose', type: 'sales_invoice', input: {}, env: { OPENCLAW_WORKSPACE_DIR: '/tmp' } }) + '\n',
      JSON.stringify({ cmd: 'propose', type: 'sales_invoice', input: {}, secret: 'x' }) + '\n',
      JSON.stringify({ cmd: 'show', id: '/etc/passwd' }) + '\n',
      JSON.stringify({ cmd: 'show', id: '../../x' }) + '\n',
      JSON.stringify({ cmd: 'show', id: 'prop_1111111111111111', path: '/etc/passwd' }) + '\n',
      JSON.stringify({ cmd: 'execute', id: 'prop_1111111111111111', phrase: 5 }) + '\n',
      JSON.stringify({ cmd: 'resolve', id: 'prop_1111111111111111', created: 'yes', code: 'x' }) + '\n',
      JSON.stringify({ cmd: 'propose', type: '__proto__', input: [] }) + '\n',
      '{"cmd":"ping","__proto__":{"polluted":true}}\n',
      '{"__proto__":{"cmd":"ping"}}\n',
      JSON.stringify({ cmd: 'propose', type: 'sales_invoice', input: {}, actor: 'x'.repeat(500) }) + '\n',
    ];
    for (const b of bad) {
      const reply = JSON.parse(await rawSend(c.sock, b, { end: true }));
      assert.equal(reply.ok, false, b);
    }
    assert.equal({}.polluted, undefined);
    // oversize
    const big = await rawSend(c.sock, '{"cmd":"ping","pad":"' + 'a'.repeat(300 * 1024) + '"}\n');
    assert.ok(big === '' || JSON.parse(big.trim().split('\n')[0]).ok === false);
    // slow/half request then close
    await rawSend(c.sock, '{"cmd":"pi', { end: true });
    // still alive
    assert.equal((await callBroker(c.sock, { cmd: 'ping' })).broker, 'basht-daftra');
    assert.equal(c.fake.calls.length, 0);
  } finally { await c.done(); }
});

test('validateRequest is strict', () => {
  assert.doesNotThrow(() => validateRequest({ cmd: 'ping' }));
  assert.doesNotThrow(() => validateRequest({ cmd: 'resolve', id: 'prop_1', created: true, code: 'c', recordId: 12 }));
  for (const m of [null, [], 'x', { cmd: 'ping', a: 1 }, { cmd: 'execute', id: 'x' }, { cmd: 'resolve', id: 'p', created: true, code: 'c', recordId: 'abc' }, { cmd: 'toString' }, { cmd: 'constructor' }])
    assert.throws(() => validateRequest(m), undefined, JSON.stringify(m));
});

test('concurrent clients are served independently', async () => {
  const c = await setup();
  try {
    const replies = await Promise.all(Array.from({ length: 25 }, () => callBroker(c.sock, { cmd: 'ping' })));
    assert.equal(replies.length, 25);
    assert.ok(replies.every((r) => r.writes_enabled === true));
  } finally { await c.done(); }
});

test('upstream error text containing the key or secret never reaches the agent (thrown or inside a successful result)', async () => {
  const c = await setup();
  try {
    const leaky = async () => { throw Error('boom ' + WRITE_KEY + ' ' + OP_SECRET); };
    const s2 = join(c.base, 'run', 'x.sock');
    const bad = createBroker({ env: { ...c.brokerEnv, DAFTRA_BROKER_SOCKET: s2 }, fetcher: leaky });
    await bad.listen();
    try {
      const raw = await rawSend(s2, JSON.stringify({ cmd: 'propose', type: 'sales_invoice', input: invoiceInput }) + '\n', { end: true });
      assert.ok(raw.length > 20);
      assert.equal(raw.includes(WRITE_KEY), false);
      assert.equal(raw.includes(OP_SECRET), false);
      assert.match(raw, /redacted/);
    } finally { await bad.close(); }
  } finally { await c.done(); }
});

test('secret files: 0644, symlink, directory, short, relative and missing are all refused; 0600 works; env var path still works', async () => {
  const base = await mkdtemp(join(tmpdir(), 'basht-sec-'));
  try {
    const good = join(base, 'good'); await writeFile(good, OP_SECRET + '\n', { mode: 0o600 });
    assert.equal(readSecretFile(good), OP_SECRET);
    assert.equal(approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: good }), OP_SECRET);
    const open = join(base, 'open'); await writeFile(open, OP_SECRET, { mode: 0o644 }); await chmod(open, 0o644);
    assert.throws(() => approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: open }), ApprovalConfigError);
    assert.equal(approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: open, DAFTRA_ALLOW_INSECURE_SECRET_FILE: '1' }), OP_SECRET);
    const grp = join(base, 'grp'); await writeFile(grp, OP_SECRET); await chmod(grp, 0o640);
    assert.throws(() => approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: grp }), /group\/others/);
    const link = join(base, 'link'); await symlink(good, link);
    assert.throws(() => approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: link }), /regular file/);
    assert.throws(() => approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: base }), /regular file/);
    const short = join(base, 'short'); await writeFile(short, 'tooshort', { mode: 0o600 });
    assert.throws(() => approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: short }), ApprovalConfigError);
    assert.throws(() => approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: 'relative/path' }), /absolute/);
    assert.throws(() => approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: join(base, 'missing') }), ApprovalConfigError);
    assert.equal(approvalSecret({ DAFTRA_APPROVAL_SECRET: OP_SECRET }), OP_SECRET);
    // a file replaced later is re-read (cache keyed on inode/mtime/size)
    const rot = join(base, 'rot'); await writeFile(rot, 'a'.repeat(40), { mode: 0o600 });
    assert.equal(approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: rot }), 'a'.repeat(40));
    await rm(rot); await writeFile(rot, 'b'.repeat(41), { mode: 0o600 });
    assert.equal(approvalSecret({ DAFTRA_APPROVAL_SECRET_FILE: rot }), 'b'.repeat(41));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('broker refuses to start with an insecure secret file, a missing write key, or unsafe socket settings', async () => {
  const c = await setup();
  try {
    await chmod(join(c.base, 'secrets', 'approval'), 0o644);
    assert.throws(() => createBroker({ env: { ...c.brokerEnv, DAFTRA_BROKER_SOCKET: join(c.base, 'run', 'y.sock') }, fetcher: c.fake.fetch }), ApprovalConfigError);
    await chmod(join(c.base, 'secrets', 'approval'), 0o600);
    const env2 = { ...c.brokerEnv, DAFTRA_BROKER_SOCKET: join(c.base, 'run', 'y.sock') };
    delete env2.DAFTRA_WRITE_API_KEY_FILE;
    assert.throws(() => createBroker({ env: env2, fetcher: c.fake.fetch }), /WRITE_API_KEY/);
    for (const [patch, re] of [
      [{ DAFTRA_BROKER_SOCKET: 'relative.sock' }, /absolute/],
      [{ DAFTRA_BROKER_SOCKET_MODE: '666' }, /others/],
      [{ DAFTRA_BROKER_SOCKET_MODE: '777' }, /others/],
      [{ DAFTRA_BROKER_SOCKET_MODE: 'rw' }, /octal/],
      [{ DAFTRA_BROKER_SOCKET: join(c.base, 'nodir', 's.sock') }, /directory does not exist/],
    ]) assert.throws(() => createBroker({ env: { ...c.brokerEnv, ...patch }, fetcher: c.fake.fetch }), re);
    const open = join(c.base, 'open'); await mkdir(open, { mode: 0o777 }); await chmod(open, 0o777);
    assert.throws(() => createBroker({ env: { ...c.brokerEnv, DAFTRA_BROKER_SOCKET: join(open, 's.sock') }, fetcher: c.fake.fetch }), /world-writable/);
  } finally { await c.done(); }
});

test('socket is created 0600 by default and 0660 when configured; it is removed on shutdown', async () => {
  const c = await setup();
  try {
    assert.equal((await stat(c.sock)).mode & 0o777, 0o600);
    const s2 = join(c.base, 'run', 'g.sock');
    const b2 = createBroker({ env: { ...c.brokerEnv, DAFTRA_BROKER_SOCKET: s2, DAFTRA_BROKER_SOCKET_MODE: '660' }, fetcher: c.fake.fetch });
    await b2.listen();
    assert.equal((await stat(s2)).mode & 0o777, 0o660);
    await b2.close();
    await assert.rejects(stat(s2), { code: 'ENOENT' });
    assert.equal((await callBroker(c.sock, { cmd: 'ping' })).broker, 'basht-daftra');   // first broker unaffected
  } finally { await c.done(); }
});

test('socket path handling: live broker, non-socket file and symlink refuse; a stale socket is replaced', async () => {
  const c = await setup();
  try {
    const mk = (path) => createBroker({ env: { ...c.brokerEnv, DAFTRA_BROKER_SOCKET: path }, fetcher: c.fake.fetch });
    await assert.rejects(mk(c.sock).listen(), /already listening/);
    const plain = join(c.base, 'run', 'plain'); await writeFile(plain, 'x');
    await assert.rejects(mk(plain).listen(), /not a socket/);
    assert.equal(await readFile(plain, 'utf8'), 'x');
    const target = join(c.base, 'run', 'target.sock'); const link = join(c.base, 'run', 'link.sock');
    await symlink(target, link);
    await assert.rejects(mk(link).listen(), /symlink/);
    // stale socket left behind by a killed process
    const stale = join(c.base, 'run', 'stale.sock');
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stale)},()=>console.log('up'));setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((ok) => child.stdout.once('data', ok));
    child.kill('SIGKILL'); await new Promise((ok) => child.once('exit', ok));
    assert.ok((await stat(stale)).isSocket());
    const b = mk(stale); await b.listen();
    assert.equal((await callBroker(stale, { cmd: 'ping' })).broker, 'basht-daftra');
    await b.close();
  } finally { await c.done(); }
});

test('broker state lives in its own directory: the agent workspace never receives ledger or proposals', async () => {
  const c = await setup();
  try {
    await run(['propose', 'sales_invoice', '--input', JSON.stringify(invoiceInput)], { env: c.clientEnv });
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(join(c.base, 'agent-ws')), []);
    assert.ok((await readdir(join(c.base, 'state', 'daftra-ledger', 'proposals'))).length === 1);
  } finally { await c.done(); }
});
