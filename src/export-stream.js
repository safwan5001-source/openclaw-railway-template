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
import { spawn } from "node:child_process";
import fs from "node:fs";

import { buildFindArgs } from "./backup.js";

/** Sizes of what an export would contain (regular files only, same exclusions), without reading file contents. */
export function exportPlan(stateDir, workspaceDir) {
  return new Promise((resolve, reject) => {
    const { roots, args } = buildFindArgs(stateDir, workspaceDir);
    const existing = roots.filter((r) => fs.existsSync("/" + r));
    if (!existing.length) return resolve({ files: 0, bytes: 0, roots: [] });
    // Same traversal and exclusions as the export, printing "<size> <root>" for each regular file.
    const idx = args.lastIndexOf("-print0");
    const plan = [...args.slice(0, idx), "-type", "f", "-printf", "%s %H\\n"].filter((a) => (roots.includes(a) ? existing.includes(a) : true));
    const p = spawn("find", plan, { cwd: "/", stdio: ["ignore", "pipe", "ignore"] });
    let files = 0;
    let bytes = 0;
    const perRoot = {};
    let rest = "";
    p.stdout.on("data", (d) => {
      const lines = (rest + d).split("\n");
      rest = lines.pop();
      for (const l of lines) {
        const sp = l.indexOf(" ");
        const n = Number(l.slice(0, sp));
        const root = l.slice(sp + 1);
        files++;
        bytes += n;
        perRoot[root] = (perRoot[root] ?? 0) + n;
      }
    });
    p.on("error", reject);
    p.on("close", () => resolve({ files, bytes, roots: existing.map((r) => ({ path: "/" + r, bytes: perRoot[r] ?? 0 })) }));
  });
}

export function registerStreamingExport(app, requireAuth, { stateDir, workspaceDir, password, log }) {
  let running = null; // the zip child of the export in progress

  app.get("/setup/api/export/plan", requireAuth, async (_req, res) => {
    try {
      const plan = await exportPlan(stateDir, workspaceDir);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, ...plan, mb: Math.round(plan.bytes / 1e6), importLimitMb: 1024, running: running !== null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/setup/api/export", requireAuth, (req, res) => {
    if (running) return res.status(409).json({ ok: false, error: "An export is already running. Wait for it to finish." });
    const { roots, args } = buildFindArgs(stateDir, workspaceDir);
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
      "Content-Disposition": `attachment; filename="openclaw-export-${ts}.zip"`,
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
      log.warn("export", `stopped (${why}) after ${sent} bytes, ${Math.round((Date.now() - started) / 1000)} s`);
    };
    res.on("close", () => {
      if (!finished) stop("client went away");
    });
    zip.on("close", (code) => {
      if (finished) return;
      finished = true;
      running = null;
      if (code === 0) {
        log.info("export", `streamed ${sent} bytes in ${Math.round((Date.now() - started) / 1000)} s`);
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
  });
}
