// Download of ONE official invoice PDF at a time, behind the existing /setup login (requireSetupAuth).
// Only files the `pdf` command itself created are reachable: invoice-<id>-<32 hex random>.pdf inside <workspace>/exports.
// Other exports (reports, CSV, ...) never match, and the random part means a link is only known to the person who was given it.
import fs from "node:fs";
import path from "node:path";

export const PDF_NAME_RE = /^invoice-[0-9]{1,15}-[0-9a-f]{32}\.pdf$/;

function resolvePdf(workspaceDir, name) {
  if (typeof name !== "string" || !PDF_NAME_RE.test(name)) return null;
  try {
    const dir = fs.realpathSync(path.resolve(workspaceDir, "exports"));
    const file = fs.realpathSync(path.join(dir, name));           // follows symlinks, then must still be inside exports
    if (path.dirname(file) !== dir || !fs.statSync(file).isFile()) return null;
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, 0);
      return head.toString("latin1") === "%PDF-" ? file : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// Registers GET /setup/exports/:name. `requireAuth` is the existing login guard and always runs first.
export function registerExportDownload(app, requireAuth, workspaceDir) {
  app.get("/setup/exports/:name", requireAuth, (req, res) => {
    const file = resolvePdf(workspaceDir, req.params?.name);
    if (!file) { res.statusCode = 404; res.setHeader("Content-Type", "text/plain; charset=utf-8"); return res.end("Not found"); }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${req.params.name}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
}
