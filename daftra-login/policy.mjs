// Network policy of the isolated login browser. Pure functions, no I/O: every request Chromium makes passes through decideRequest()
// (CDP Fetch interception), and the browser is ALSO started with a resolver rule that makes every non-Daftra hostname unresolvable.
//
// Goal: the browser can sign the operator in and read; it cannot write to the tenant.
//   * tenant host(s) (anything under daftra.com except the login/marketing hosts): GET/HEAD only, never /api2 or /v2/api, and never a path
//     that names a state-changing verb (add/edit/delete/send/issue/approve/... or logout, which would also kill the session);
//   * login hosts (www.daftra.com, daftra.com, plus exact hosts the operator lists): any method, because the email + OTP step POSTs;
//   * everything else: blocked.
// Limit (stated, not hidden): a GET that changes state under a path without such a verb cannot be recognised by a client-side rule.
// The server-side guarantee is a read-only Daftra staff user; this policy is defence in depth.
const MUTATING = /(^|[\/_.-])(add|edit|delete|remove|destroy|update|create|issue|send|email|post|approve|reject|cancel|void|convert|import|pay|refund|duplicate|clone|save|submit|mark|logout|sign_?out)([\/_.-]|$)/i;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseHostList(raw) {
  const out = new Set();
  for (const part of String(raw ?? '').split(',')) { const h = part.trim().toLowerCase(); if (HOST_RE.test(h)) out.add(h); }   // exact DNS names only: no wildcards, IPs, ports
  return out;
}

export function createPolicy({ tenantHost, loginHosts = [], allowInsecureTestScheme = false } = {}) {
  const tenant = String(tenantHost ?? '').toLowerCase();
  if (!HOST_RE.test(tenant) || !tenant.endsWith('.daftra.com')) throw new Error('tenant host must be a *.daftra.com name');
  const write = new Set(['www.daftra.com', 'daftra.com', ...loginHosts]);
  return Object.freeze({ tenant, write, allowInsecureTestScheme });
}

const isDaftra = (h, policy) => h === 'daftra.com' || h.endsWith('.daftra.com') || policy.write.has(h);

// -> { allow: boolean, reason: string }   (reason is a fixed vocabulary, never a URL)
export function decideRequest({ url, method = 'GET' }, policy) {
  let u;
  try { u = new URL(String(url)); } catch { return { allow: false, reason: 'bad_url' }; }
  if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return { allow: true, reason: 'internal' };
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (!secure && !(policy.allowInsecureTestScheme && (u.protocol === 'http:' || u.protocol === 'ws:'))) return { allow: false, reason: 'scheme' };
  if (u.username || u.password) return { allow: false, reason: 'credentials_in_url' };
  const host = u.hostname.toLowerCase();
  if (!isDaftra(host, policy)) return { allow: false, reason: 'host' };
  const m = String(method).toUpperCase();
  if (policy.write.has(host)) return { allow: true, reason: 'login_host' };
  // tenant-like host: read only
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') return { allow: false, reason: 'tenant_write_method' };
  if (/^\/(api2|v2\/api)(\/|$)/i.test(u.pathname)) return { allow: false, reason: 'tenant_api' };
  if (MUTATING.test(decodeSafe(u.pathname))) return { allow: false, reason: 'tenant_mutating_path' };
  return { allow: true, reason: 'tenant_read' };
}

function decodeSafe(p) { try { return decodeURIComponent(p); } catch { return p; } }

// Resolver rules: every hostname except Daftra's (and the operator-listed login hosts) resolves to nothing. (Chromium evaluates EXCLUDE rules first.)
// `testMap` (tests only) maps fake hosts to a local server; in that mode there is NO exclusion, so no Daftra name can resolve to the real internet.
export function hostResolverRules(policy, { testMap = [] } = {}) {
  if (testMap.length) return [...testMap, 'MAP * ~NOTFOUND'].join(', ');
  const extras = [...policy.write].filter((h) => h !== 'www.daftra.com' && h !== 'daftra.com');
  return ['MAP * ~NOTFOUND', 'EXCLUDE *.daftra.com', 'EXCLUDE daftra.com', ...extras.map((h) => 'EXCLUDE ' + h)].join(', ');
}
