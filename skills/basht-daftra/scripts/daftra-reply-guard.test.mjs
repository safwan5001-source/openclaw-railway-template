import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReply, recordReadEvidence, isFinancialText, UNVERIFIED_FALLBACK_AR, EVIDENCE_MAX_AGE_MS } from './daftra-reply-guard.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'daftra-guard-test-'));
const MD = '*آخر 5 من 144*\n\n⚪ *draft-97900* · مسودة · 2026-11-06\n💰 54,300.00 ر.س';
const env = (dir) => ({ DAFTRA_EVIDENCE_DIR: dir });

test('general chat and accounting explanations pass without evidence', () => {
  const d = tmp();
  assert.equal(checkReply('مرحبا، كيف أقدر أساعدك اليوم؟', { env: env(d) }).ok, true);
  assert.equal(checkReply('الضريبة المضافة تُحسب على القيمة قبل الخصم بنسبة 15%.', { env: env(d) }).ok, true);
  assert.equal(checkReply('سنة 2026 بدأت في يناير.', { env: env(d) }).financial, false);
  rmSync(d, { recursive: true, force: true });
});

test('a live figure with no evidence is blocked and replaced by the fallback', () => {
  const d = tmp();
  const r = checkReply('إجمالي فاتورة draft-97900 هو 54,300.00 ر.س', { env: env(d) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_fresh_read');
  assert.equal(r.reply, UNVERIFIED_FALLBACK_AR);
  rmSync(d, { recursive: true, force: true });
});

test('a reply containing the exact recorded read is allowed', () => {
  const d = tmp();
  const now = 1_000_000;
  assert.equal(recordReadEvidence({ command: 'list', markdown: MD, complete: true, now, env: env(d) }), true);
  const r = checkReply('مرحبا\n' + MD, { env: env(d), now: now + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'verified_read');
  rmSync(d, { recursive: true, force: true });
});

test('a single altered figure fails verification', () => {
  const d = tmp();
  const now = 1_000_000;
  recordReadEvidence({ command: 'list', markdown: MD, now, env: env(d) });
  const altered = MD.replace('54,300.00', '90,500.00');
  const r = checkReply(altered, { env: env(d), now });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'figures_not_in_fresh_read');
  rmSync(d, { recursive: true, force: true });
});

test('stale evidence is rejected', () => {
  const d = tmp();
  const t0 = 1_000_000;
  recordReadEvidence({ command: 'list', markdown: MD, now: t0, env: env(d) });
  const r = checkReply(MD, { env: env(d), now: t0 + EVIDENCE_MAX_AGE_MS + 1 });
  assert.equal(r.ok, false);
  rmSync(d, { recursive: true, force: true });
});

test('incomplete or failed reads are never recorded', () => {
  const d = tmp();
  assert.equal(recordReadEvidence({ command: 'list', markdown: MD, complete: false, env: env(d) }), false);
  assert.equal(recordReadEvidence({ command: 'list', markdown: MD, ok: false, env: env(d) }), false);
  assert.equal(recordReadEvidence({ command: 'list', markdown: '', env: env(d) }), false);
  assert.equal(checkReply(MD, { env: env(d) }).ok, false);
  rmSync(d, { recursive: true, force: true });
});

test('evidence file is private and capped', () => {
  const d = tmp();
  for (let i = 0; i < 205; i++) recordReadEvidence({ command: 'list', markdown: MD + i, now: 1_000_000 + i, env: env(d) });
  const lines = readFileSync(join(d, 'reads.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 200);
  rmSync(d, { recursive: true, force: true });
});

test('isFinancialText recognises money, invoice ids and status words only', () => {
  assert.equal(isFinancialText('المبلغ 18,100.00 ر.س'), true);
  assert.equal(isFinancialText('حالة الفاتورة مدفوعة'), true);
  assert.equal(isFinancialText('draft-97900'), true);
  assert.equal(isFinancialText('تحية طيبة'), false);
});
