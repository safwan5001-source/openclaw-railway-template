#!/usr/bin/env node
// OPERATOR / HUMAN tool. Run it in a trusted shell, NOT through the agent.
// It needs DAFTRA_APPROVAL_SECRET, shows the authenticated stored proposal exactly as it would be sent,
// and prints the approval phrase the human then sends to the agent in chat.
//   node daftra-approve.mjs show <proposal-id>
//   node daftra-approve.mjs resolve <proposal-id> true|false     (after checking Daftra for an ambiguous outcome)
import { resolve } from 'node:path';
import { loadProposal } from './daftra-ledger.mjs';
import { formatMeta } from './daftra-public.mjs';
import { approvalPhrase, resolveCode, approvalSecret } from './daftra-auth.mjs';

export async function review(id, env = process.env, now = Date.now()) {
  approvalSecret(env);
  const p = await loadProposal(id, env);
  const lines = [
    '=== Proposal ' + p.id + ' (' + p.type + ', ' + p.mode.toUpperCase() + ') ===',
    'Party   : ' + JSON.stringify(p.party),
    'Totals  : ' + JSON.stringify(p.totals),
    ...formatMeta(p.meta),
    'Effects : ' + p.effects.join(', ') + ' | reversible: ' + p.reversible,
    'Sends   : ' + p.request.method + ' ' + p.request.path + (p.request.query ? '?' + p.request.query : ''),
    'Body    : ' + JSON.stringify(p.request.body),
    'Hash    : ' + p.request_hash,
    'Expires : ' + p.expires_at,
  ];
  if (p.blocking?.length) lines.push('BLOCKED : ' + p.blocking.join(' | '));
  if (p.warnings?.length) lines.push('Warnings: ' + p.warnings.join(' | '));
  const live = p.ready === true && Date.parse(p.expires_at) >= now;
  lines.push(live ? '\nIf (and only if) this is exactly what you want, send the agent this message:\n\n' + approvalPhrase(env, p)
    : '\nNo approval phrase: the proposal is ' + (p.ready ? 'expired' : 'blocked') + '.');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const [cmd, id, flag] = process.argv.slice(2);
  try {
    if (cmd === 'show' && id) console.log(await review(id));
    else if (cmd === 'resolve' && id && ['true', 'false'].includes(flag)) {
      await loadProposal(id);
      console.log('Resolve code for ' + id + ' (created=' + flag + '): ' + resolveCode(process.env, id, flag === 'true'));
    } else throw Error('Usage: daftra-approve.mjs show <proposal-id> | resolve <proposal-id> true|false');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
