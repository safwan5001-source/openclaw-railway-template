import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";

import { createExportPdfHandler, resolveExportPdf } from "./exports-download.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function withServer(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "basht-dl-"));
  const dir = path.join(ws, "exports");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "invoice-97900.pdf"), PDF);
  fs.writeFileSync(path.join(dir, "fake.pdf"), "<html>not a pdf</html>");
  fs.writeFileSync(path.join(dir, "data.csv"), "a,b\n");
  fs.writeFileSync(path.join(ws, "secret.pdf"), PDF);                       // outside exports
  fs.symlinkSync(path.join(ws, "secret.pdf"), path.join(dir, "link.pdf"));  // symlink escape
  const handler = createExportPdfHandler(ws);
  const server = http.createServer((req, res) => {
    const m = /^\/setup\/exports\/([^/?]*)$/.exec(req.url);       // same shape as the Express route; Express decodes params
    if (!m) { res.statusCode = 404; return res.end("Not found"); }
    let name;
    try { name = decodeURIComponent(m[1]); } catch { res.statusCode = 400; return res.end("Bad request"); }
    req.params = { name };
    return handler(req, res);
  }).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ base, ws, dir }); } finally { server.close(); fs.rmSync(ws, { recursive: true, force: true }); }
}

test("serves an exported PDF with safe, iPhone-viewable headers", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/setup/exports/invoice-97900.pdf`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    assert.match(r.headers.get("content-disposition"), /^inline; filename="invoice-97900\.pdf"$/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(Buffer.from(await r.arrayBuffer()).equals(PDF), true);
  });
});

test("refuses traversal, encoded traversal, non-pdf names, fake PDFs, symlinks and missing files", async () => {
  await withServer(async ({ base, ws }) => {
    for (const name of ["..%2Fsecret.pdf", "%2e%2e%2fsecret.pdf", "..%5Csecret.pdf", "data.csv", "fake.pdf", "link.pdf", "nope.pdf", ".hidden.pdf", "a%00.pdf", "invoice-97900.pdf%00.txt", "x".repeat(200) + ".pdf"]) {
      const r = await fetch(`${base}/setup/exports/${name}`);
      assert.equal(r.status, 404, name);
      assert.equal((await r.text()).includes("%PDF"), false, name);
    }
    assert.equal((await fetch(`${base}/setup/exports/`)).status, 404);
    assert.deepEqual(resolveExportPdf(ws, "../secret.pdf"), { error: 404 });
    assert.deepEqual(resolveExportPdf(ws, undefined), { error: 404 });
  });
});

test("a missing exports directory is a 404, not a crash", () => {
  assert.deepEqual(resolveExportPdf(path.join(os.tmpdir(), "basht-no-such-workspace"), "a.pdf"), { error: 404 });
});
