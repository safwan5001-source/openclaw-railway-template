import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, decideRequest, hostResolverRules, parseHostList } from './policy.mjs';
import { chromiumArgs, childEnvironment } from './browser.mjs';

const policy = createPolicy({ tenantHost: 'nepras.daftra.com' });
const d = (url, method = 'GET', p = policy) => decideRequest({ url, method }, p);

test('login hosts may POST (the e-mail + OTP step); the tenant is read only', () => {
  assert.deepEqual(d('https://www.daftra.com/api/otp-verify', 'POST'), { allow: true, reason: 'login_host' });
  assert.equal(d('https://daftra.com/x', 'POST').allow, true);
  assert.equal(d('https://nepras.daftra.com/sso?t=abc').allow, true);
  assert.equal(d('https://nepras.daftra.com/owner/invoices/view/97900.pdf').allow, true);
  assert.equal(d('https://nepras.daftra.com/', 'HEAD').allow, true);
});

test('every write to the tenant is blocked: methods, API prefixes, and paths that name a state-changing verb (also encoded)', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.deepEqual(d('https://nepras.daftra.com/owner/invoices/view/1', m), { allow: false, reason: 'tenant_write_method' }, m);
  for (const p of ['/api2/invoices.json', '/API2/invoices/1.json', '/v2/api/entity/invoices', '/v2/api']) assert.equal(d('https://nepras.daftra.com' + p).reason, 'tenant_api', p);
  for (const p of ['/owner/invoices/add', '/owner/invoices/edit/1', '/owner/invoices/delete/1', '/owner/invoices/update_draft/1/0', '/owner/invoices/send/5', '/owner/invoices/issue/5', '/owner/invoices/approve/5',
    '/owner/invoices/view/1/email', '/owner/users/logout', '/owner/invoices/%64elete/1', '/owner/payments/refund/2', '/owner/clients/create', '/owner/invoices/cancel-1']) {
    assert.deepEqual(d('https://nepras.daftra.com' + p), { allow: false, reason: 'tenant_mutating_path' }, p);
  }
  // words that merely CONTAIN a verb stay readable
  for (const p of ['/owner/invoices/view/1', '/owner/dashboard', '/owner/updates', '/owner/addresses', '/css/main.css', '/owner/invoices/view/97900.pdf']) assert.equal(d('https://nepras.daftra.com' + p).allow, true, p);
});

test('other tenants of daftra.com are read only too; other hosts, schemes and credentials are blocked', () => {
  assert.equal(d('https://other.daftra.com/x', 'POST').reason, 'tenant_write_method');
  for (const u of ['https://evil.example/x', 'https://daftra.com.evil.example/', 'https://notdaftra.com/', 'https://nepras.daftra.com.evil.example/']) assert.equal(d(u).reason, 'host', u);
  for (const u of ['http://www.daftra.com/', 'ftp://www.daftra.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'ws://www.daftra.com/']) assert.equal(d(u).allow, false, u);
  assert.equal(d('https://user:pw@www.daftra.com/').reason, 'credentials_in_url');
  assert.equal(d('not a url').reason, 'bad_url');
  for (const u of ['about:blank', 'data:image/png;base64,AAAA', 'blob:https://www.daftra.com/abc']) assert.equal(d(u).allow, true, u);
  assert.equal(d('wss://www.daftra.com/socket').allow, true);
  assert.equal(d('http://www.daftra.com/', 'GET', createPolicy({ tenantHost: 'nepras.daftra.com', allowInsecureTestScheme: true })).allow, true, 'only tests may allow http');
});

test('operator-listed login hosts: exact DNS names only; the tenant must be a *.daftra.com name', () => {
  assert.deepEqual([...parseHostList(' auth.example-login.com , *.wild.example, 10.0.0.1, http://x.example, bad host , AUTH2.example.com ')], ['auth.example-login.com', 'auth2.example.com']);
  const p = createPolicy({ tenantHost: 'nepras.daftra.com', loginHosts: ['auth.example-login.com'] });
  assert.equal(d('https://auth.example-login.com/otp', 'POST', p).allow, true);
  assert.equal(d('https://other.example-login.com/otp', 'POST', p).allow, false);
  for (const bad of ['', 'localhost', 'evil.example', '127.0.0.1', 'daftra.com']) assert.throws(() => createPolicy({ tenantHost: bad }), /tenant host/);
});

test('Chromium is started with a resolver that only knows Daftra, an ephemeral profile, no extensions, and a minimal environment (no service secrets)', () => {
  const rules = hostResolverRules(policy);
  assert.match(rules, /MAP \* ~NOTFOUND/); assert.match(rules, /EXCLUDE \*\.daftra\.com/); assert.match(rules, /EXCLUDE daftra\.com/);
  assert.doesNotMatch(hostResolverRules(policy), /127\.0\.0\.1/);
  assert.match(hostResolverRules(createPolicy({ tenantHost: 'nepras.daftra.com', loginHosts: ['auth.example-login.com'] })), /EXCLUDE auth\.example-login\.com/);
  const args = chromiumArgs({ dir: '/tmp/x', policy, noSandbox: false });
  for (const a of ['--headless=new', '--disable-extensions', '--disable-sync', '--user-data-dir=/tmp/x/profile', '--remote-debugging-port=0']) assert.ok(args.includes(a), a);
  assert.ok(!args.includes('--no-sandbox')); assert.ok(chromiumArgs({ dir: '/tmp/x', policy, noSandbox: true }).includes('--no-sandbox'));
  assert.ok(args.some((a) => a.startsWith('--host-resolver-rules=')));
  const env = childEnvironment({ PATH: '/usr/bin', LOGIN_ACCESS_CODE: 'secret-secret-secret', DAFTRA_API_KEY: 'k', RAILWAY_TOKEN: 't', HOME: '/root' }, '/tmp/x');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']); assert.equal(env.HOME, '/tmp/x');
  assert.equal(JSON.stringify(env).includes('secret'), false);
});
