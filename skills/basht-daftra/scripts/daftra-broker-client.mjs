// Agent-side client for the privileged broker (daftra-broker.mjs). One request, one response, then close.
// The client never sends secrets or paths; the broker never accepts them.
import net from 'node:net';
import { isAbsolute } from 'node:path';

export const MAX_MESSAGE_BYTES = 256 * 1024;

export class BrokerRefused extends Error {
  constructor(code, message) { super(message); this.name = 'BrokerRefused'; this.code = code; }
}

export function callBroker(socketPath, payload, { timeoutMs = 30_000 } = {}) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) return Promise.reject(Error('DAFTRA_BROKER_SOCKET must be an absolute path'));
  const line = JSON.stringify(payload) + '\n';
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return Promise.reject(Error('Request too large for the broker'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = []; let size = 0; let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; socket.destroy(); fn(value); };
    socket.setTimeout(timeoutMs, () => finish(reject, Error('Broker timed out')));
    socket.on('error', (e) => finish(reject, Error('Cannot reach the broker (' + (e.code || 'error') + ')')));
    socket.on('connect', () => socket.write(line));
    socket.on('data', (d) => {
      size += d.length;
      if (size > MAX_MESSAGE_BYTES * 8) return finish(reject, Error('Broker response too large'));
      chunks.push(d);
    });
    socket.on('end', () => {
      let reply;
      try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(reject, Error('Broker returned invalid JSON')); }
      if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') return finish(reject, Error('Broker returned an invalid reply'));
      if (!reply.ok) return finish(reject, reply.refused ? new BrokerRefused(String(reply.refused), String(reply.error)) : Error(String(reply.error)));
      finish(resolve, reply.result);
    });
  });
}
