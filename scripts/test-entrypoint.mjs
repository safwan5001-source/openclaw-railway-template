// node:test wrapper so `node --test` (and CI) runs the bash simulation of both entrypoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
test('entrypoint simulations (skill-sync.sh + broker-entrypoint.sh) pass', (t) => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status !== 0) return t.skip('bash unavailable');
  const r = spawnSync('bash', [join(here, 'test-entrypoint.sh')], { encoding: 'utf8', timeout: 120_000 });
  const failed = r.stdout.split('\n').filter((l) => l.startsWith('not ok'));
  assert.deepEqual(failed, [], r.stdout + r.stderr);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^1\.\.\d+$/m);
});
