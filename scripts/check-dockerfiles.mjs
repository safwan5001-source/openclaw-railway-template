// Static invariants for both container images, their entrypoints and the Railway config. Offline, no Docker needed.
// Run: node --test scripts/check-dockerfiles.mjs
// Proves: the files say what the security design requires. Does NOT prove: that the images build or run
// (the CI `broker-image` job builds and smoke-runs the broker image) or anything about Railway's dashboard state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const code = (f) => read(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // comments stripped
const SECRETISH = /DAFTRA_|BROKER_|APPROVAL|OPERATOR_|(?:API|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE)[_]?KEY|SECRET|PASSWORD/i;

function dockerfileLines(f) {                                    // joins line continuations
  return code(f).replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean);
}
function parseToml(text) {                                       // tiny TOML subset: [tables], key = "str"|number
  const out = {}; let cur = out;
  for (const raw of text.split('\n')) {
    const l = raw.replace(/#.*$/, '').trim(); if (!l) continue;
    const tbl = l.match(/^\[([^\]]+)\]$/); if (tbl) { cur = out[tbl[1]] = {}; continue; }
    const kv = l.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/); if (!kv) continue;
    cur[kv[1]] = /^".*"$/.test(kv[2].trim()) ? kv[2].trim().slice(1, -1) : Number.isNaN(Number(kv[2])) ? kv[2].trim() : Number(kv[2]);
  }
  return out;
}

// ---------------------------------------------------------------- OpenClaw service image
test('OpenClaw Dockerfile: Arabic fonts, skill copy, unchanged OpenClaw/Node pins', () => {
  const t = dockerfileLines('Dockerfile').join('\n');
  assert.match(t, /^FROM node:26-bookworm$/m, 'Node 26 base unchanged');
  assert.match(t, /\bfonts-noto-core\b/, 'Noto fonts (Arabic Naskh/Sans) installed');
  assert.match(t, /\bfontconfig\b/);
  assert.match(t, /fc-cache -f/);
  assert.match(t, /fc-match 'Noto Naskh Arabic' \| grep -qi 'NotoNaskhArabic'/, 'build fails if the Arabic font is not resolvable');
  assert.match(t, /^COPY skills \.\/skills$/m, 'self-contained skill is copied');
  assert.match(t, /^COPY --chmod=755 skill-sync\.sh \.\/skill-sync\.sh$/m);
  assert.match(t, /openclaw@2026\.10\.9/, 'OpenClaw pin unchanged');
  assert.match(t, /grep -Eq '\^v26\\\./, 'Node 26 runtime assertion unchanged');
  assert.match(t, /^ENTRYPOINT \["tini", "--", "\.\/entrypoint\.sh"\]$/m, 'launch chain unchanged');
  assert.match(t, /^HEALTHCHECK .*\/setup\/healthz/m, 'OpenClaw healthcheck unchanged');
  assert.match(t, /^EXPOSE 8080$/m);
  assert.ok(!/\bVOLUME\b/.test(t), 'no volume declared (Railway mounts /data)');
});

test('OpenClaw image and entrypoints hold no broker/Daftra secrets (no DAFTRA_*/BROKER_* anywhere outside comments)', () => {
  for (const f of ['Dockerfile', 'entrypoint.sh', 'skill-sync.sh']) {
    const c = code(f);
    assert.ok(!SECRETISH.test(c), f + ' mentions a secret-like name: ' + (c.match(SECRETISH) ?? [])[0]);
  }
  for (const l of dockerfileLines('Dockerfile').filter((x) => /^(ENV|ARG)\b/.test(x)))
    assert.ok(!/KEY|SECRET|TOKEN|PASSWORD/i.test(l), 'secret-like ENV/ARG: ' + l);
});

test('entrypoint.sh: existing behaviour intact, skill sync is fail-soft and runs before the unchanged exec line', () => {
  const lines = read('entrypoint.sh').split('\n');
  const t = read('entrypoint.sh');
  assert.match(t, /^set -e$/m);
  assert.match(t, /^chown -R openclaw:openclaw \/data$/m);
  assert.match(t, /^chmod 700 \/data$/m);
  assert.match(t, /cp -a \/home\/linuxbrew\/\.linuxbrew \/data\/\.linuxbrew/);
  assert.match(t, /ln -sfn \/data\/\.linuxbrew \/home\/linuxbrew\/\.linuxbrew/);
  assert.equal(lines.filter((l) => l.trim()).at(-1), 'exec gosu openclaw node src/server.js', 'launch line is the last command, unchanged');
  const sync = t.indexOf('/app/skill-sync.sh /app/skills'); const exec = t.indexOf('exec gosu openclaw');
  assert.ok(sync > 0 && sync < exec);
  assert.match(t, /skill-sync\.sh \/app\/skills "\$\{OPENCLAW_WORKSPACE_DIR:-\/data\/workspace\}" openclaw:openclaw \\\n\s+\|\| echo/, 'a sync failure must not stop the Gateway');
});

// ---------------------------------------------------------------- broker image
test('Dockerfile.broker: minimal, pinned, non-root drop, healthcheck, only the skill scripts', () => {
  const lines = dockerfileLines('Dockerfile.broker'); const t = lines.join('\n');
  const from = lines.filter((l) => /^FROM\b/.test(l));
  assert.equal(from.length, 1, 'single stage, single base');
  assert.match(from[0], /^FROM node:26-bookworm-slim$/, 'pinned major + distro, slim, never :latest');
  for (const banned of [/openclaw/i, /chromium/i, /chrome/i, /linuxbrew|homebrew/i, /python/i, /build-essential|gcc|g\+\+|\bmake\b/i, /\bcurl\b|\bwget\b/i, /\bgit\b/i, /\|\s*(ba)?sh\b/, /npm install|pnpm|yarn/i])
    assert.ok(!banned.test(t), 'Dockerfile.broker must not contain ' + banned);
  assert.match(t, /\bgosu\b/); assert.match(t, /\btini\b/);
  assert.match(t, /useradd --system --uid 10001 --gid broker .*--shell \/usr\/sbin\/nologin broker/);
  assert.match(t, /^COPY skills\/basht-daftra\/scripts \.\/scripts$/m, 'only the skill scripts are copied');
  assert.ok(!/^COPY \. /m.test(t) && !/^ADD /m.test(t), 'no blanket COPY/ADD');
  assert.match(t, /^COPY --chmod=755 broker-entrypoint\.sh \/usr\/local\/bin\/broker-entrypoint\.sh$/m);
  assert.match(t, /^ENTRYPOINT \["tini", "--", "\/usr\/local\/bin\/broker-entrypoint\.sh"\]$/m);
  assert.match(t, /^HEALTHCHECK .*\/healthz/m);
  assert.match(t, /^ENV BROKER_STATE_DIR=\/broker-data$/m);
  assert.match(t, /^EXPOSE 8080$/m, 'only the public console port is exposed');
  assert.ok(!/8081/.test(t.replace(/BROKER_PRIVATE_PORT=8081/, '')), 'private agent port is never EXPOSEd');
  for (const l of lines.filter((x) => /^(ENV|ARG)\b/.test(x)))
    assert.ok(!/KEY|SECRET|TOKEN|PASSWORD|APPROVAL|OPERATOR/i.test(l), 'secret-like ENV/ARG baked into the image: ' + l);
  assert.ok(!/BROKER_AGENT_TOKEN|OPERATOR_|DAFTRA_(API|WRITE|APPROVAL)/.test(t), 'no secret names with values in the image');
});

test('broker-entrypoint.sh: validates the volume path, drops privileges, never prints secrets', () => {
  const t = read('broker-entrypoint.sh'); const c = code('broker-entrypoint.sh');
  assert.match(t, /^set -euo pipefail$/m);
  assert.match(c, /exec gosu "\$RUN_USER:\$RUN_USER" node "\$APP"/);
  assert.match(c, /chmod 700 -- "\$STATE"/);
  assert.match(c, /chown -R -h "\$RUN_USER:\$RUN_USER"/);
  assert.match(c, /\[ ! -L "\$STATE" \]/);
  assert.match(c, /realpath/);
  assert.match(c, /command -v gosu/);
  assert.ok(!/\bset -x\b|\bprintenv\b|\benv\b\s*(\||$)|\bdeclare -x\b|\bexport -p\b/.test(c), 'no env dumps / xtrace');
  assert.ok(!/echo[^\n]*\$\{?(DAFTRA|BROKER_AGENT|OPERATOR)/.test(c), 'never echoes secret variables');
  assert.ok(/\/app\/scripts\/daftra-broker-service\.mjs/.test(c));
});

test('railway.broker.toml is an optional reference; root railway.toml leaves the Dockerfile choice to RAILWAY_DOCKERFILE_PATH', () => {
  const b = parseToml(read('railway.broker.toml'));
  assert.equal(b.build.builder, 'dockerfile');
  assert.equal(b.build.dockerfilePath, 'Dockerfile.broker');
  assert.equal(b.deploy.healthcheckPath, '/healthz');
  assert.equal(b.deploy.restartPolicyType, 'on_failure');
  assert.ok(Number(b.deploy.healthcheckTimeout) > 0);
  assert.equal(b.variables, undefined, 'no [variables] (and so no secrets) in railway.broker.toml');
  assert.match(read('railway.broker.toml'), /RAILWAY_DOCKERFILE_PATH=Dockerfile\.broker/, 'primary wiring documented in the file');
  assert.match(read('railway.broker.toml'), /deprecated/i, 'deprecation noted');
  // the broker must work WITH the root railway.toml present (it applies to every service built from the repo root)
  const r = parseToml(read('railway.toml'));
  assert.equal(r.build.dockerfilePath, undefined, 'root railway.toml must not pin a dockerfilePath, or the service variable could not select Dockerfile.broker');
  assert.equal(r.build.builder, 'dockerfile');
  assert.equal(r.deploy.healthcheckPath, '/setup/healthz');
  assert.equal(String(r.variables?.PORT), '8080', 'root PORT=8080 matches the broker public console port default');
  const svc = join(root, 'skills/basht-daftra/scripts/daftra-broker-service.mjs');
  if (existsSync(svc)) {
    const s = readFileSync(svc, 'utf8');
    assert.ok(s.includes('/setup/healthz') && s.includes('/healthz'), 'broker service answers both /healthz and the root railway.toml healthcheck /setup/healthz');
  }
});

test('.dockerignore keeps tests, git data and env files out of both images; the broker entry has no test-only imports', () => {
  const ig = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const need of ['.git', 'node_modules', '.env', 'skills/**/*.test.mjs', 'skills/**/*.test-helper.mjs']) assert.ok(ig.includes(need), '.dockerignore lacks ' + need);
  assert.ok(ig.includes('!.env.example'));
  const dir = join(root, 'skills/basht-daftra/scripts'); const entry = join(dir, 'daftra-broker-service.mjs');
  if (!existsSync(entry)) return;                                      // service not present in this checkout
  const isIgnored = (f) => /\.test\.mjs$|\.test-helper\.mjs$/.test(f);
  const seen = new Set(); const stack = ['daftra-broker-service.mjs'];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    assert.ok(existsSync(join(dir, f)), 'broker import graph references a missing file: ' + f);
    assert.ok(!isIgnored(f), 'broker import graph needs an image-excluded test file: ' + f);
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([\w.-]+\.mjs)['"]/g)) stack.push(m[1]);
  }
  for (const f of seen) assert.ok(!/^\.\.\//.test(f));
});

test('every shell entrypoint parses with bash -n (and shellcheck when installed)', (t) => {
  for (const f of ['entrypoint.sh', 'broker-entrypoint.sh', 'skill-sync.sh', 'scripts/test-entrypoint.sh']) {
    const r = spawnSync('bash', ['-n', join(root, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, f + ': ' + r.stderr);
    const first = read(f).split('\n')[0]; assert.equal(first, '#!/bin/bash', f + ' shebang');
  }
  const sc = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (sc.status !== 0) return t.diagnostic('shellcheck not installed: skipped');
  for (const f of ['broker-entrypoint.sh', 'skill-sync.sh']) {
    const r = spawnSync('shellcheck', ['-S', 'warning', join(root, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, f + ': ' + r.stdout);
  }
});

test('the legacy Python exporter is gone and nothing references it', () => {
  const dir = join(root, 'skills/basht-daftra/scripts');
  assert.ok(!readdirSync(dir).some((f) => /\.py$/.test(f)), 'no Python files in the skill bundle');
  const hits = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(mjs|js|json|md|ya?ml|toml|sh)$/.test(e.name) && !p.endsWith('check-dockerfiles.mjs') && !p.endsWith('DAFTRA_PACKAGING_NOTES.md')) {
      if (/daftra_office_export|test_daftra_office_export|unittest discover/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1));
    } } };
  walk(root);
  assert.deepEqual(hits, [], 'stale references to the removed Python exporter');
});

// ---------------------------------------------------------------- experimental login-browser image (phase 1; never deployed by this repo)
test('Dockerfile.login: separate, pinned, non-root, Chromium here and NOT in the broker, no secrets baked, no volume, tests excluded', () => {
  const lines = dockerfileLines('Dockerfile.login'); const t = lines.join('\n');
  const from = lines.filter((l) => /^FROM\b/.test(l));
  assert.equal(from.length, 1); assert.match(from[0], /^FROM node:26-bookworm-slim$/);
  assert.match(t, /\bchromium\b/); assert.match(t, /\bfonts-noto-core\b/); assert.match(t, /\btini\b/);
  assert.match(t, /useradd --system --uid 10002 --gid login .*--shell \/usr\/sbin\/nologin login/);
  assert.match(t, /^USER login$/m, 'the service runs unprivileged');
  assert.match(t, /^COPY skills\/basht-daftra\/scripts \.\/skills\/basht-daftra\/scripts$/m);
  assert.match(t, /^COPY daftra-login \.\/daftra-login$/m);
  assert.ok(!/^COPY \. /m.test(t) && !/^ADD /m.test(t) && !/\bVOLUME\b/.test(t), 'no blanket copy, no volume: nothing persists');
  assert.match(t, /^ENTRYPOINT \["tini", "--", "node", "\/app\/daftra-login\/server\.mjs"\]$/m);
  assert.match(t, /^HEALTHCHECK .*\/healthz/m); assert.match(t, /^EXPOSE 8080$/m);
  for (const l of lines.filter((x) => /^(ENV|ARG)\b/.test(x))) assert.ok(!/KEY|SECRET|TOKEN|PASSWORD|CODE|DAFTRA|BROKER|OPERATOR|APPROVAL/i.test(l.replace('LOGIN_CHROMIUM_NO_SANDBOX', '')), 'secret-like ENV/ARG baked in: ' + l);
  assert.ok(!/DAFTRA_(API|WRITE|APPROVAL)|BROKER_|OPERATOR_|LOGIN_ACCESS_CODE/.test(t), 'no secret names in the image');
  // the privilege split this design depends on: the money-holding broker still has NO browser
  assert.ok(!/chromium|chrome/i.test(dockerfileLines('Dockerfile.broker').join('\n')), 'Dockerfile.broker must stay browser-free');
  assert.ok(!/daftra-login/.test(dockerfileLines('Dockerfile.broker').join('\n') + dockerfileLines('Dockerfile').join('\n')), 'the login service is not shipped in the broker or OpenClaw images');
  const ig = read('.dockerignore'); assert.match(ig, /^daftra-login\/\*\*\/\*\.test\.mjs$/m); assert.match(ig, /^daftra-login\/\*\*\/\*\.test-helper\.mjs$/m);
});

test('railway.login.toml is a reference only (no variables); the login service answers the root railway.toml health path too', () => {
  const l = parseToml(read('railway.login.toml'));
  assert.equal(l.build.dockerfilePath, 'Dockerfile.login'); assert.equal(l.deploy.healthcheckPath, '/healthz'); assert.equal(l.variables, undefined);
  assert.match(read('railway.login.toml'), /RAILWAY_DOCKERFILE_PATH=Dockerfile\.login/);
  assert.match(read('daftra-login/server.mjs'), /path === '\/setup\/healthz'/);
});

test('login service import graph: every relative import resolves, and it never touches broker/ledger/approval code or the Daftra API key', () => {
  const dir = join(root, 'daftra-login');
  for (const f of readdirSync(dir).filter((n) => /\.mjs$/.test(n) && !/\.test(-helper)?\.mjs$/.test(n))) {
    const src = read('daftra-login/' + f);
    for (const m of src.matchAll(/from '(\.[^']+)'/g)) assert.ok(existsSync(resolve(dir, m[1])), f + ' imports a missing file: ' + m[1]);
    assert.ok(!/daftra-(broker|write|ledger|proposal|approve|auth|operator-auth)/.test(src), f + ' must not import the financial broker code');
    assert.ok(!/DAFTRA_API_KEY|DAFTRA_WRITE|APPROVAL_SECRET|BROKER_/.test(src), f + ' must not read any Daftra/broker credential');
  }
});
