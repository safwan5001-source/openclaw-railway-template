import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ensureExportsDir, exportsDir, safeFileName, safeOutputPath } from './daftra-paths.mjs';

test('exports dir defaults to /data/workspace/exports and honours OPENCLAW_WORKSPACE_DIR', () => {
  assert.equal(exportsDir({}), '/data/workspace/exports');
  assert.equal(exportsDir({ OPENCLAW_WORKSPACE_DIR: '/w' }), '/w/exports');
});

test('safeOutputPath confines output to the private exports directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basht-paths-'));
  try {
    const env = { OPENCLAW_WORKSPACE_DIR: dir };
    const base = ensureExportsDir(env);
    assert.equal(statSync(base).mode & 0o777, 0o700);
    assert.equal(safeOutputPath(join(base, 'a-1.csv'), 'csv', env), join(base, 'a-1.csv'));
    for (const bad of [join(dir, 'a.csv'), join(base, '..', 'a.csv'), '/etc/passwd.csv', base + sep, 'rel.csv', join(base, 'x\0.csv')])
      assert.throws(() => safeOutputPath(bad, 'csv', env), /private exports directory|Invalid output/, bad);
    assert.throws(() => safeOutputPath(join(base, 'a.json'), 'csv', env), /must end with \.csv/);
    for (const name of ['sp ace.csv', 'ünï.csv', 'a;b.csv', '.csv', '-x.csv'])
      assert.throws(() => safeOutputPath(join(base, name), 'csv', env), /Invalid output|must end/, name);
    assert.throws(() => safeOutputPath(join(base, 'sub', 'a.csv'), 'csv', env), /directory does not exist/);
    const outside = await mkdtemp(join(tmpdir(), 'basht-out-'));
    try {
      await symlink(outside, join(base, 'l'));
      assert.throws(() => safeOutputPath(join(base, 'l', 'a.csv'), 'csv', env), /symlink escape/);
      await mkdir(join(base, 'real'));
      assert.ok(safeOutputPath(join(base, 'real', 'a.csv'), 'csv', env).endsWith('a.csv'));
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('safeFileName builds a safe timestamped name', () => {
  const name = safeFileName('كشف حساب ../x', 'xlsx', new Date('2026-11-05T10:20:30.123Z'));
  assert.equal(name, 'x-20261105T102030Z.xlsx');
  assert.equal(safeFileName('###', 'csv', new Date('2026-11-05T10:20:30Z')), 'daftra-export-20261105T102030Z.csv');
  assert.throws(() => safeFileName('a', 'C:'), /Invalid extension/);
  assert.equal(existsSync(join(tmpdir(), name)), false);
});
