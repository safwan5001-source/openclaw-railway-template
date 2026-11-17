import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PERSONA_FILES, applyAgentDefaults, buildAgentDefaults, seedPersonaFiles } from './agent-persona.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));

test('seeds all persona files into an empty workspace', () => {
  const ws = tmp();
  const r = seedPersonaFiles(ws, { disabled: false });
  assert.deepEqual(r.created.sort(), [...PERSONA_FILES].sort());
  assert.match(fs.readFileSync(path.join(ws, 'SOUL.md'), 'utf8'), /Lead with the answer/);
});

test('never overwrites operator-edited files, even empty ones', () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, 'SOUL.md'), 'mine');
  fs.writeFileSync(path.join(ws, 'USER.md'), '');
  const r = seedPersonaFiles(ws, { disabled: false });
  assert.deepEqual(r.skipped.sort(), ['SOUL.md', 'USER.md']);
  assert.equal(fs.readFileSync(path.join(ws, 'SOUL.md'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(ws, 'USER.md'), 'utf8'), '');
});

test('does not write through a symlinked target', () => {
  const ws = tmp(); const victim = path.join(tmp(), 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(ws, 'AGENTS.md'));
  seedPersonaFiles(ws, { disabled: false });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('can be disabled', () => {
  const ws = tmp();
  const r = seedPersonaFiles(ws, { disabled: true });
  assert.equal(r.created.length, 0);
  assert.deepEqual(fs.readdirSync(ws), []);
});

test('persona files carry no secrets and keep the approval rule', () => {
  for (const f of PERSONA_FILES) {
    const t = fs.readFileSync(new URL(`./persona/${f}`, import.meta.url), 'utf8');
    assert.ok(!/sk-ant-|DAFTRA_API_KEY=|Bearer [A-Za-z0-9]/.test(t), f);
  }
  const agents = fs.readFileSync(new URL('./persona/AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /explicit, per-operation approval/);
});

test('defaults come only from valid env vars', () => {
  assert.deepEqual(buildAgentDefaults({}).sets, []);
  const ok = buildAgentDefaults({ OPENCLAW_DEFAULT_MODEL: 'anthropic/claude-sonnet-5-5', OPENCLAW_THINKING_DEFAULT: 'Medium' });
  assert.deepEqual(ok.sets, [
    { key: 'agents.defaults.model.primary', value: 'anthropic/claude-sonnet-5-5' },
    { key: 'agents.defaults.thinkingDefault', value: 'medium' },
  ]);
  const bad = buildAgentDefaults({ OPENCLAW_DEFAULT_MODEL: 'x; rm -rf /', OPENCLAW_THINKING_DEFAULT: '../x' });
  assert.deepEqual(bad.sets, []);
  assert.equal(bad.warnings.length, 2);
});

test('applyAgentDefaults runs config set per key and tolerates failures', async () => {
  const calls = [];
  const keys = await applyAgentDefaults(async (a) => { calls.push(a); return { code: calls.length === 1 ? 0 : 1 }; },
    { OPENCLAW_DEFAULT_MODEL: 'anthropic/claude-sonnet-5-5', OPENCLAW_THINKING_DEFAULT: 'low' }, { info() {}, warn() {} });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['config', 'set', '--json', 'agents.defaults.model.primary', '"anthropic/claude-sonnet-5-5"']);
  assert.equal(keys.length, 2);
});

test('browser defaults are opt-in and validated', () => {
  assert.deepEqual(buildAgentDefaults({}).sets, []);
  const on = buildAgentDefaults({ OPENCLAW_BROWSER: '1' }).sets;
  const m = Object.fromEntries(on.map((x) => [x.key, x.value]));
  assert.deepEqual(m, {
    'browser.enabled': true, 'browser.headless': true, 'browser.noSandbox': true,
    'browser.defaultProfile': 'openclaw', 'browser.executablePath': '/usr/bin/chromium',
  });
  const bad = buildAgentDefaults({ OPENCLAW_BROWSER: '1', OPENCLAW_BROWSER_EXECUTABLE: '/usr/../bin/x; id' });
  assert.deepEqual(bad.sets, []);
  assert.equal(bad.warnings.length, 1);
});
