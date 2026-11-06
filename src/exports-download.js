// Authenticated download of a generated/official PDF from the private exports directory (iPhone-friendly: opens in Safari's PDF viewer,
// Share -> Save to Files). The route is mounted behind the same Basic-auth guard as /setup; nothing here is public.
//   - the name is a bare file name ending in .pdf (no separators, no dot-leading names, no encoded traversal)
//   - the file must be a regular, non-symlink file that really lives inside <workspace>/exports and starts with %PDF-
//   - served with a fixed content type, nosniff, no caching, and a locked-down CSP
import fs from "node:fs";
import path from "node:path";

export const EXPORT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.pdf$/;
export const MAX_EXPORT_DOWNLOAD_BYTES = 30 * 1024 * 1024;

export function exportsDirFor(workspaceDir) {
  return path.resolve(workspaceDir, "exports");
}

// Returns { path, size } for a servable file, or { error: status }.
export function resolveExportPdf(workspaceDir, name) {
  if (typeof name !== "string" || !EXPORT_NAME_RE.test(name) || name.includes("..")) return { error: 404 };
  let realDir;
  try { realDir = fs.realpathSync(exportsDirFor(workspaceDir)); } catch { return { error: 404 }; }
  const candidate = path.join(realDir, name);
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return { error: 404 }; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { error: 404 };
  let real;
  try { real = fs.realpathSync(candidate); } catch { return { error: 404 }; }
  if (path.dirname(real) !== realDir) return { error: 404 };
  if (stat.size < 8 || stat.size > MAX_EXPORT_DOWNLOAD_BYTES) return { error: 404 };
  let fd;
  try {
    fd = fs.openSync(real, "r");
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    if (head.toString("latin1") !== "%PDF-") return { error: 404 };
  } catch { return { error: 404 }; } finally { if (fd !== undefined) fs.closeSync(fd); }
  return { path: real, size: stat.size };
}

// Works with Express (req.params.name) and with a bare node:http server (the test passes the name explicitly).
export function createExportPdfHandler(workspaceDir) {
  return (req, res) => {
    const name = req.params?.name;
    const found = resolveExportPdf(workspaceDir, name);
    if (found.error) {
      res.statusCode = found.error;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end("Not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(found.size));
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Referrer-Policy", "no-referrer");
    const stream = fs.createReadStream(found.path);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
}
