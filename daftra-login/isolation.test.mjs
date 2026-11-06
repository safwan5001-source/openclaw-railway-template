// The login browser must not be able to reach the financial machinery even by accident: walk its WHOLE static import graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function graph(entry) {
  const seen = new Set();
  const walk = (f) => { if (seen.has(f)) return; seen.add(f); for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import\()\s*'(\.[^']+)'/g)) walk(resolve(dirname(f), m[1])); };
  walk(entry); return [...seen].map((f) => relative(root, f));
}

test('transitive imports of the login service contain no write, ledger, approval, operator, broker or catalog module', () => {
  const files = graph(resolve(root, 'daftra-login/server.mjs'));
  assert.ok(files.length >= 10, 'graph was walked: ' + files.length);
  for (const f of files) assert.ok(!/daftra-(write|ledger|proposal|approve|auth|operator-auth|broker|duplicate|catalog|public)/.test(f), 'financial module reachable: ' + f);
  assert.ok(files.includes('skills/basht-daftra/scripts/daftra-session-pdf.mjs'), 'the read-only PDF fetcher is the only Daftra code it uses');
});

test('no module of the login service reads a credential variable other than its own, and none writes a file', () => {
  const files = graph(resolve(root, 'daftra-login/server.mjs'));
  for (const f of files) {
    const src = readFileSync(resolve(root, f), 'utf8');
    if (f.startsWith('daftra-login/')) assert.ok(!/writeFile|appendFile|createWriteStream/.test(src), f + ' must not write files (only Chromium\'s temp profile exists)');
    assert.ok(!/process\.env\.(DAFTRA_API_KEY|DAFTRA_WRITE_API_KEY|DAFTRA_APPROVAL_SECRET|OPERATOR_|BROKER_)/.test(src), f + ' reads a broker/Daftra credential');
  }
});
