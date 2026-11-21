// Streaming /setup Export (replaces the build-then-send export).
//
// The old export zipped the whole state into the container's temp disk before sending a single byte: on real data
// the browser gave up first (HTTP 499), the zip kept running, every retry started another full copy, and the finished
// copies were never deleted (their cleanup only ran when a download completed). In production that ended with the
// container at its 8 GB memory limit and the gateway (WhatsApp) OOM-killed.
//
// Now: `find | zip -@ -` is piped straight into the response — bytes start at once, nothing is written to disk, the
// zip is killed when the client goes away, and only one export runs at a time. The archive format is unchanged
// (ZIP protected with the setup password, entries data/.openclaw/..., data/workspace/...), so /setup Import accepts it.
// It is a live copy (the gateway keeps running), like before.
//
// Scopes: "full" (everything except rebuildable caches) and "essential" (also without the official PDF copies and
// media, which can be fetched again) — small enough to finish quickly on a phone.
//
// One-time links: iOS download managers do not always send the page's Basic credentials with a download, so the
// logged-in /setup page asks for a single-use link (POST, same-origin, 2 minutes) and the browser downloads that.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { buildFindArgs, ESSENTIAL_EXTRA } from "./backup.js";

const SCOPES = { full: undefined, essential: ESSENTIAL_EXTRA };
const LINK_TTL_MS = 2 * 60_000;
const MAX_LINKS = 5;

const scopeOf = (v) => (v === "essential" ? "essential" : "full");

/** Sizes of what an export would contain (regular files only, same exclusions), without reading file contents. */
export function exportPlan(stateDir, workspaceDir, scope = "full") {
  return new Promise((resolve, reject) => {
    const { roots, args } = buildFindArgs(stateDir, workspaceDir, SCOPES[scope]);
    const existing = roots.filter((r) => fs.existsSync("/" + r));
    if (!existing.length) return resolve({ files: 0, bytes: 0, roots: [], largest: [] });
    // Same traversal and exclusions as the export, printing "<size>\t<root>\t<path below root>" per regular file.
    const idx = args.lastIndexOf("-print0");
    const plan = [...args.slice(0, idx), "-type", "f", "-printf", "%s\\t%H\\t%P\\n"].filter((a) => (roots.includes(a) ? existing.includes(a) : true));
    const p = spawn("find", plan, { cwd: "/", stdio: ["ignore", "pipe", "ignore"] });
    let files = 0;
    let bytes = 0;
    const perRoot = {};
    const perDir = new Map();
    let rest = "";
    p.stdout.on("data", (d) => {
      const lines = (rest + d).split("\n");
      rest = lines.pop();
      for (const l of lines) {
        const [size, root, rel] = l.split("\t");
        const n = Number(size);
        files++;
        bytes += n;
        perRoot[root] = (perRoot[root] ?? 0) + n;
        const parts = (rel ?? "").split("/");
        const dir = `/${root}/${parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0] : "(files)"}`;
        perDir.set(dir, (perDir.get(dir) ?? 0) + n);
      }
    });
    p.on("error", reject);
    p.on("close", () =>
      resolve({
        files,
        bytes,
        roots: existing.map((r) => ({ path: "/" + r, bytes: perRoot[r] ?? 0 })),
        // Folder names only (never file names): what takes the space.
        largest: [...perDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([dir, b]) => ({ dir, mb: Math.round(b / 1e6) })),
      }),
    );
  });
}

export function registerStreamingExport(app, requireAuth, { stateDir, workspaceDir, password, log }) {
  let running = null; // the zip child of the export in progress
  const links = new Map(); // token -> { scope, exp }

  function streamExport(res, scope) {
    if (running) return res.status(409).json({ ok: false, error: "An export is already running. Wait for it to finish." });
    const { roots, args } = buildFindArgs(stateDir, workspaceDir, SCOPES[scope]);
    const existing = roots.filter((r) => fs.existsSync("/" + r));
    if (!existing.length) return res.status(404).json({ ok: false, error: "No data directories found to export." });

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const find = spawn("find", args.filter((a) => (roots.includes(a) ? existing.includes(a) : true)), {
      cwd: "/",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Null-separated names are converted for zip's -@ (one name per line). Names with a newline are skipped.
    // -q quiet (no per-file output kept in memory), -1 fast compression, -P setup password (same as the old export),
    // "-" = write the archive to stdout, -@ = read the file list from stdin. No -y: symlinks are never in the list.
    const zip = spawn("zip", ["-q", "-1", "-P", password, "-", "-@"], { cwd: "/", stdio: ["pipe", "pipe", "pipe"] });
    running = zip;
    let rest = "";
    find.stdout.on("data", (d) => {
      const parts = (rest + d.toString("utf8")).split("\0");
      rest = parts.pop();
      const ok = parts.filter((n) => n && !n.includes("\n"));
      if (ok.length && !zip.stdin.write(ok.join("\n") + "\n")) find.stdout.pause();
    });
    zip.stdin.on("drain", () => find.stdout.resume());
    find.on("close", () => {
      if (rest && !rest.includes("\n")) zip.stdin.write(rest + "\n");
      zip.stdin.end();
    });
    zip.stdin.on("error", () => {});
    find.stdout.on("error", () => {});
    let stderr = "";
    zip.stderr.on("data", (d) => (stderr = (stderr + d).slice(-500)));

    const started = Date.now();
    let sent = 0;
    let finished = false;
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="openclaw-export-${scope}-${ts}.zip"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders();
    zip.stdout.on("data", (chunk) => {
      sent += chunk.length;
      if (!res.write(chunk)) zip.stdout.pause();
    });
    res.on("drain", () => zip.stdout.resume());

    const stop = (why) => {
      if (finished) return;
      finished = true;
      find.kill("SIGKILL");
      zip.kill("SIGKILL");
      running = null;
      log.warn("export", `${scope}: stopped (${why}) after ${sent} bytes, ${Math.round((Date.now() - started) / 1000)} s`);
    };
    res.on("close", () => {
      if (!finished) stop("client went away");
    });
    zip.on("close", (code) => {
      if (finished) return;
      finished = true;
      running = null;
      if (code === 0) {
        log.info("export", `${scope}: streamed ${sent} bytes in ${Math.round((Date.now() - started) / 1000)} s`);
        res.end();
      } else {
        // Headers are gone already: cut the connection so the browser reports a failed (not a truncated-but-OK) file.
        log.error("export", `zip exited ${code}: ${stderr}`);
        res.destroy();
      }
    });
    zip.on("error", (err) => {
      log.error("export", `zip failed: ${err.message}`);
      stop("zip error");
      res.destroy();
    });
  }

  app.get("/setup/api/export/plan", requireAuth, async (req, res) => {
    try {
      const scope = scopeOf(req.query.scope);
      const plan = await exportPlan(stateDir, workspaceDir, scope);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, scope, ...plan, mb: Math.round(plan.bytes / 1e6), importLimitMb: 1024, running: running !== null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/setup/api/export", requireAuth, (req, res) => streamExport(res, scopeOf(req.query.scope)));

  // Single-use, short-lived download link, issued only to a logged-in same-origin page (POST passes the CSRF guard).
  app.post("/setup/api/export/link", requireAuth, (req, res) => {
    const now = Date.now();
    for (const [t, l] of links) if (l.exp <= now) links.delete(t);
    if (links.size >= MAX_LINKS) return res.status(429).json({ ok: false, error: "Too many pending download links." });
    const token = crypto.randomBytes(32).toString("base64url");
    const scope = scopeOf(req.body?.scope ?? req.query.scope);
    links.set(token, { scope, exp: now + LINK_TTL_MS });
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, url: `/setup/api/export/download/${token}`, scope, expiresInSeconds: LINK_TTL_MS / 1000 });
  });

  app.get("/setup/api/export/download/:token", (req, res) => {
    const token = String(req.params.token || "");
    const link = links.get(token);
    if (!link || link.exp <= Date.now()) {
      links.delete(token);
      return res.status(404).type("text/plain").send("Link expired or already used. Start the export again from /setup.");
    }
    links.delete(token); // single use, even if the download then fails
    return streamExport(res, link.scope);
  });
}
