// Financial reply guard: a live Daftra figure may be sent to chat only when it matches a fresh, complete read result
// that this skill recorded from the same rendered output. General chat and explanations pass untouched.
// This is a verification gate for the reply step, not a sender: it returns a decision and never sends anything.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const EVIDENCE_MAX_AGE_MS = 10 * 60 * 1000;
export const UNVERIFIED_FALLBACK_AR = 'القراءة لم تكتمل: لم أتمكن من التحقق من البيانات الحالية من دفترة، ولن أعرض أرقامًا أو حالات غير موثقة. أعد المحاولة بعد لحظات.';
const EVIDENCE_FILE = 'reads.jsonl';
const KEEP_LINES = 200;

// Signals of a live financial statement: amounts with a currency, invoice-like ids, and money/status words.
const FINANCIAL_SIGNALS = [
  /\d[\d,.]*\s*(?:ر\.س|ريال|SAR\b|SR\b)/i,
  /\b(?:draft-)?\d{5,}\b(?=[^\n]{0,40}(?:فاتورة|invoice|مسودة|draft))/i,
  /(?:فاتورة|invoice)\s*(?:رقم|no\.?|#)?\s*:?\s*(?:draft-)?\d{3,}/i,
  /\b(?:draft-\d+)\b/i,
  /(?:مدفوعة|غير مدفوعة|مسودة|ملغاة|المتبقي|الإجمالي|المدفوع|الرصيد)/,
];

export function isFinancialText(text) {
  const s = String(text ?? '');
  return FINANCIAL_SIGNALS.some((re) => re.test(s));
}

export function evidenceDir(env = process.env) {
  return env.DAFTRA_EVIDENCE_DIR || join(tmpdir(), 'basht-daftra-evidence');
}

// Record a successful, complete read. Only the rendered markdown and minimal metadata are stored.
export function recordReadEvidence({ command, markdown, complete = true, ok = true, now = Date.now(), env = process.env }) {
  if (!ok || complete === false || typeof markdown !== 'string' || markdown.trim() === '') return false;
  const dir = evidenceDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, EVIDENCE_FILE);
  appendFileSync(file, JSON.stringify({ at: now, command: String(command), markdown }) + '\n', { mode: 0o600 });
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > KEEP_LINES) writeFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
  return true;
}

function freshEntries({ env = process.env, now = Date.now(), maxAgeMs = EVIDENCE_MAX_AGE_MS } = {}) {
  const file = join(evidenceDir(env), EVIDENCE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter((e) => typeof e.markdown === 'string' && typeof e.at === 'number' && now - e.at >= 0 && now - e.at <= maxAgeMs);
}

// Decide whether a reply may be sent. Returns { ok, financial, reason, reply }.
export function checkReply(text, options = {}) {
  const reply = String(text ?? '');
  if (!isFinancialText(reply)) return { ok: true, financial: false, reason: 'not_financial', reply };
  const entries = freshEntries(options);
  const verified = entries.some((e) => reply.includes(e.markdown));
  if (verified) return { ok: true, financial: true, reason: 'verified_read', reply };
  return { ok: false, financial: true, reason: entries.length ? 'figures_not_in_fresh_read' : 'no_fresh_read', reply: UNVERIFIED_FALLBACK_AR };
}

// CLI: `node daftra-reply-guard.mjs check < reply.txt` prints the decision as JSON; exit 0 when sendable, 3 when blocked.
if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href && process.argv[2] === 'check') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    const decision = checkReply(input);
    console.log(JSON.stringify(decision));
    process.exitCode = decision.ok ? 0 : 3;
  });
}
