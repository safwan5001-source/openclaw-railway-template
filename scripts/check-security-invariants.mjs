// Static + simulated invariants from the BASHT security review (docs/SECURITY_REVIEW.md). Offline, no Docker.
// Run: node --test scripts/check-security-invariants.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const code = (f) => read(f).split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');

test('builds are reproducible: no floating @latest / @next npm installs in any Dockerfile', () => {
  for (const f of readdirSync(root).filter((n) => /^Dockerfile/.test(n))) {
    const t = code(f);
    assert.ok(!/@(latest|next)\b/.test(t), `${f} installs a floating npm tag`);
    for (const m of t.matchAll(/npm install -g\s+([^&\n]+)/g)) {
      for (const pkg of m[1].split(/\s+/).filter((p) => p && !p.startsWith('-') && p !== '\\'))
        assert.match(pkg, /@\d+\.\d+\.\d+$/, `${f}: global npm package must pin an exact version: ${pkg}`);
    }
  }
});

test('wrapper: gateway token is attached conditionally, never unconditionally', () => {
  const s = code('src/server.js');
  const sets = [...s.matchAll(/setHeader\("Authorization",\s*`Bearer \$\{OPENCLAW_GATEWAY_TOKEN\}`\)/g)];
  assert.equal(sets.length, 1, 'exactly one place attaches the gateway token');
  assert.match(s, /if \(req\[INJECT_GATEWAY_TOKEN\] === true\) \{\s*proxyReq\.setHeader\("Authorization"/);
  assert.match(s, /delete process\.env\.SETUP_PASSWORD;/, 'the admin password is removed from the inherited environment');
  assert.ok(!/^app\.use\(express\.json\(/m.test(s), 'no global JSON parser in front of the proxy');
  assert.match(s, /rejectCrossSiteRequests\(/, 'CSRF guard mounted');
});

test('entrypoint simulation (Homebrew copy is atomic and fail-soft)', (t) => {
  if (spawnSync('bash', ['--version']).status !== 0) return t.skip('bash unavailable');
  const r = spawnSync('bash', [join(root, 'scripts/test-openclaw-entrypoint.sh')], { encoding: 'utf8', timeout: 60_000 });
  assert.deepEqual(r.stdout.split('\n').filter((l) => l.startsWith('not ok')), [], r.stdout + r.stderr);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('auto-close-spam never closes PRs from the repository owner or collaborators', () => {
  const t = read('.github/workflows/auto-close-spam.yml');
  assert.ok(!/arjunkomath/.test(t), 'no hard-coded upstream owner');
  assert.match(t, /context\.repo\.owner/);
  assert.match(t, /author_association/);
  assert.ok(!/actions\/checkout/.test(t), 'pull_request_target workflow must never check out PR code');
});
