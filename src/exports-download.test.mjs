import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerExportDownload } from "./exports-download.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const GOOD = "invoice-97900-0123456789abcdef0123456789abcdef.pdf";
const OTHER_PDF = "report-statement.pdf";                                  // a different export in the same folder
const GUESS = "invoice-97900-ffffffffffffffffffffffffffffffff.pdf";        // right shape, never created

async function withServer(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "basht-dl-"));
  const dir = path.join(ws, "exports");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, GOOD), PDF);
  fs.writeFileSync(path.join(dir, OTHER_PDF), PDF);
  fs.writeFileSync(path.join(ws, "secret.pdf"), PDF);
  fs.symlinkSync(path.join(ws, "secret.pdf"), path.join(dir, "invoice-1-00000000000000000000000000000000.pdf"));
  // Fake app that applies the route's handlers in order, like Express; the auth guard is the one passed to registerExportDownload.
  const routes = [];
  registerExportDownload({ get: (p, ...h) => routes.push({ p, h }) }, (req, res, next) => {
    if (req.headers.authorization !== "Basic ok") { res.statusCode = 401; res.setHeader("WWW-Authenticate", "Basic"); return res.end("Auth required"); }
    return next();
  }, ws);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].p, "/setup/exports/:name");
  const server = http.createServer((req, res) => {
    const m = /^\/setup\/exports\/([^/?]*)$/.exec(req.url);
    if (!m) { res.statusCode = 404; return res.end(); }
    try { req.params = { name: decodeURIComponent(m[1]) }; } catch { res.statusCode = 400; return res.end(); }
    const [guard, handler] = routes[0].h;
    return guard(req, res, () => handler(req, res));
  }).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const get = (name, auth = true) => fetch(`http://127.0.0.1:${server.address().port}/setup/exports/${name}`, { headers: auth ? { authorization: "Basic ok" } : {} });
  try { await fn(get); } finally { server.close(); fs.rmSync(ws, { recursive: true, force: true }); }
}

test("without login nothing is served, not even the right file", async () => {
  await withServer(async (get) => {
    for (const name of [GOOD, OTHER_PDF, GUESS]) {
      const r = await get(name, false);
      assert.equal(r.status, 401, name);
      assert.equal((await r.text()).includes("%PDF"), false);
    }
  });
});

test("logged in: only the requested invoice PDF is served; other exports, guesses, traversal and symlinks are 404", async () => {
  await withServer(async (get) => {
    const ok = await get(GOOD);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/pdf");
    assert.match(ok.headers.get("content-disposition"), /^inline;/);
    assert.equal(ok.headers.get("cache-control"), "private, no-store");
    assert.equal(Buffer.from(await ok.arrayBuffer()).equals(PDF), true);
    for (const name of [OTHER_PDF, GUESS, "..%2Fsecret.pdf", "%2e%2e%2fsecret.pdf", "secret.pdf", "invoice-1-00000000000000000000000000000000.pdf", `${GOOD}%00.txt`, ""]) {
      const r = await get(name);
      assert.equal(r.status, 404, name);
      assert.equal((await r.text()).includes("%PDF"), false, name);
    }
  });
});
