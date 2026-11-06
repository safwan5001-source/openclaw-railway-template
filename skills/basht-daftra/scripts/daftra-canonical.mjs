// Canonical JSON + request hashing shared by previews, proposals and authentication.
import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}
export function hashRequest(request) {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

