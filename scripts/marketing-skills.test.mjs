import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('skills');
const names = [
  'basht-market-intelligence', 'basht-marketing-strategy', 'basht-creative-direction',
  'basht-social-media', 'basht-ads-campaigns', 'basht-performance-analytics',
  'basht-video-creative', 'basht-local-seo', 'basht-conversion-optimization',
  'basht-marketing-automation',
];
const required = [
  '## BASHT execution contract',
  'الموافقة', 'المصدر', 'لا تختلق', 'الخطوة التالية',
];

test('ten unique portable skill names', () => {
  assert.equal(names.length, 10);
  assert.equal(new Set(names).size, 10);
});
for (const name of names) {
  test(name + ': safe SKILL.md contract', () => {
    const base = path.join(root, name);
    const file = path.join(base, 'SKILL.md');
    assert.ok(fs.statSync(file).isFile());
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith('---\n'));
    const front = content.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, 'frontmatter required');
    assert.match(front[1], new RegExp('^name: ' + name + '$', 'm'));
    assert.match(front[1], /^description: ".+"$/m);
    for (const phrase of required) assert.ok(content.includes(phrase), phrase);
    assert.match(content, /لا تخزّن أسرارًا/);
    assert.match(content, /نشر خارجي/);
    assert.match(content, /تصرّح|صرّح|صرّح|القيود/);
    assert.ok(Buffer.byteLength(content, 'utf8') < 16000, 'avoid bloated prompt');
  });
}
test('production installer is intentionally NOT enabled for these skills', () => {
  const sync = fs.readFileSync('skill-sync.sh', 'utf8');
  assert.ok(sync.includes('basht-daftra|basht-accounting'));
  for (const name of names) assert.equal(sync.includes(name), false);
});
