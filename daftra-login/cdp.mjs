// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket (no dependencies).
export async function connectCdp(wsUrl, { connectTimeoutMs = 15000, commandTimeoutMs = 30000 } = {}) {
  if (!/^ws:\/\/127\.0\.0\.1:\d{2,5}\/devtools\/browser\/[A-Za-z0-9-]+$/.test(String(wsUrl))) throw new Error('CDP endpoint must be loopback');
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('CDP connect timeout')), connectTimeoutMs);
    ws.addEventListener('open', () => { clearTimeout(t); ok(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); fail(new Error('CDP connect failed')); }, { once: true });
  });
  let nextId = 0; let closed = false;
  const pending = new Map(); const listeners = new Set(); const closeListeners = new Set();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (m.id !== undefined) {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.fail(Object.assign(new Error('CDP ' + p.method + ': ' + String(m.error.message ?? 'error').slice(0, 120)), { code: m.error.code }));
      else p.ok(m.result ?? {});
      return;
    }
    for (const fn of listeners) { try { fn(m); } catch { /* a listener never breaks the reader */ } }
  });
  ws.addEventListener('close', () => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.fail(new Error('CDP connection closed')); }
    pending.clear();
    for (const fn of closeListeners) { try { fn(); } catch { /* ignore */ } }
  });
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('CDP connection closed'));
      const id = ++nextId;
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => { pending.delete(id); fail(new Error('CDP ' + method + ': timeout')); }, commandTimeoutMs);
        pending.set(id, { ok, fail, timer, method });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onClose(fn) { closeListeners.add(fn); },
    get closed() { return closed; },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}
