// POST /setup/api/backup — encrypted, consistent backup of BASHT's state, behind the setup login and the CSRF guard.
//
// Opt-in: does nothing until BASHT_BACKUP_PUBLIC_KEY (an RSA public key, PEM) is set. The server never holds a key that
// can decrypt (see backup-format.js). Flow:
//   1. take the gateway maintenance lock and stop it (SQLite databases and the WhatsApp session must not change
//      mid-copy; nothing can restart it until step 3),
//   2. archive state + workspace (regular files and directories only; rebuildable caches excluded) through gzip and
//      encryption into the container's temporary disk — plaintext is never written anywhere, and nothing is written to
//      the volume,
//   3. restart the gateway as soon as the archive is complete (downtime = archive time, not download time),
//   4. send the encrypted file, then delete it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import { createEncryptStream, keyId, loadPublicKey } from "./backup-format.js";
import { assertNoBackupWriters, r2BackupConfig, uploadEncryptedBackup } from "./backup-r2.js";

/** Rebuildable or volatile paths, relative to the state / workspace roots. */
export const STATE_EXCLUDES = ["cache", "tmp", "logs", "server.log", "media/playback-transcode"];
export const WORKSPACE_EXCLUDES = ["skills/basht-daftra", "skills/basht-accounting", "node_modules", ".cache"];

/** Arguments for `find` (run with cwd "/"): regular files and directories only, excluded paths pruned. */
export function buildFindArgs(stateDir, workspaceDir) {
  const rel = (p) => path.resolve(p).replace(/^\/+/, "");
  const stateRel = rel(stateDir);
  const wsRel = rel(workspaceDir);
  const roots = wsRel === stateRel || wsRel.startsWith(stateRel + "/") ? [stateRel] : [stateRel, wsRel];
  const pruned = [
    ...STATE_EXCLUDES.map((e) => `${stateRel}/${e}`),
    ...WORKSPACE_EXCLUDES.map((e) => `${wsRel}/${e}`),
  ];
  const prune = pruned.flatMap((p, i) => (i ? ["-o", "-path", p] : ["-path", p]));
  return {
    roots,
    args: [...roots, "(", ...prune, "-o", "-name", "*.sock", "-o", "-name", "*.pid", ")", "-prune", "-o", "(", "-type", "f", "-o", "-type", "d", ")", "-print0"],
  };
}

function waitExit(child, name) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}`))));
  });
}

/** Writes the encrypted archive to `outFile`. Rejects if any step fails (the partial file is removed). */
export async function writeEncryptedArchive({ stateDir, workspaceDir, publicKey, outFile, meta = {} }) {
  const { roots, args } = buildFindArgs(stateDir, workspaceDir);
  const existing = roots.filter((r) => fs.existsSync("/" + r));
  if (!existing.length) throw new Error("nothing to back up");
  const find = spawn("find", args.map((a) => (roots.includes(a) && !existing.includes(a) ? null : a)).filter((a) => a !== null), {
    cwd: "/",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // --no-recursion: the list from find is exact (directories are listed for their metadata, not their contents).
  const tar = spawn("tar", ["--null", "--no-recursion", "-T", "-", "-cf", "-"], { cwd: "/", stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  find.stderr.on("data", (d) => (stderr += d));
  tar.stderr.on("data", (d) => (stderr += d));
  find.stdout.pipe(tar.stdin);
  const enc = createEncryptStream(publicKey, { content: "tar.gz", roots: existing, ...meta });
  const out = fs.createWriteStream(outFile, { flags: "wx", mode: 0o600 });
  try {
    await Promise.all([
      pipeline(tar.stdout, zlib.createGzip({ level: 6 }), enc, out),
      waitExit(find, "find"),
      waitExit(tar, "tar"),
    ]);
  } catch (err) {
    find.kill("SIGKILL");
    tar.kill("SIGKILL");
    fs.rmSync(outFile, { force: true });
    throw new Error(`${err.message}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`);
  }
  return { header: enc.header, bytes: fs.statSync(outFile).size };
}

export function registerBackupRoute(app, requireAuth, opts) {
  const { stateDir, workspaceDir, publicKeyPem, pauseGateway, resumeGateway, log } = opts;
  let publicKey = null;
  let configError = "Backup is not configured: set BASHT_BACKUP_PUBLIC_KEY (RSA public key, PEM). See docs/BACKUP.md.";
  if (publicKeyPem?.trim()) {
    try {
      publicKey = loadPublicKey(publicKeyPem);
      log.info("backup", `encrypted backups enabled (key id ${keyId(publicKey)})`);
    } catch (err) {
      configError = `Backup is disabled: BASHT_BACKUP_PUBLIC_KEY is invalid (${err.message}).`;
      log.warn("backup", configError);
    }
  }
  let busy = false;

  app.post("/setup/api/backup", requireAuth, async (req, res) => {
    if (!publicKey) return res.status(503).json({ ok: false, error: configError });
    if (busy) return res.status(409).json({ ok: false, error: "A backup is already running." });
    let r2 = null;
    if (req.query?.destination === "r2") {
      try { r2 = r2BackupConfig(); } catch { return res.status(503).json({ ok: false, error: "R2 backup is not configured." }); }
    }
    busy = true;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let tmpDir = null;
    const started = Date.now();
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "basht-backup-"));
      const outFile = path.join(tmpDir, `basht-backup-${ts}.bkp`);
      try {
        // The maintenance lock keeps every start path (requests, WebSocket reconnects, timers) away until the
        // snapshot is complete; it also cancels a start that is still in flight.
        await pauseGateway("backup");
      } catch (err) {
        return res.status(409).json({ ok: false, error: `Gateway maintenance in progress (${err.message}).` });
      }
      let result;
      try {
        await assertNoBackupWriters([stateDir, workspaceDir]);
        result = await writeEncryptedArchive({ stateDir, workspaceDir, publicKey, outFile, meta: { host: "basht-openclaw" } });
        await assertNoBackupWriters([stateDir, workspaceDir]);
      } finally {
        // Keep the request busy until delivery finishes, but release the gateway maintenance lock now.
        resumeGateway().catch((err) =>
          // "paused" = another maintenance (backup/import) took the lock first; it restarts the gateway itself.
          /paused/.test(err.message) ? log.info("backup", err.message) : log.error("backup", `gateway restart failed: ${err.message}`),
        );
      }
      log.info("backup", `encrypted backup ready: ${result.bytes} bytes, gateway paused ${Date.now() - started} ms`);
      if (r2) {
        const uploaded = await uploadEncryptedBackup(outFile, r2);
        return res.json({ ok: true, ...uploaded, keyId: result.header.kid });
      }
      res.set({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="basht-backup-${ts}.bkp"`,
        "Content-Length": String(result.bytes),
        "X-Backup-Key-Id": result.header.kid,
      });
      await pipeline(fs.createReadStream(outFile), res);
    } catch (err) {
      const full = /ENOSPC/.test(String(err.message));
      log.error("backup", `failed: ${err.message}`);
      if (!res.headersSent) {
        res.status(full ? 507 : 500).json({ ok: false, error: full ? "Not enough temporary disk space for the backup." : "Backup failed. See logs." });
      } else {
        res.destroy();
      }
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      busy = false;
    }
  });
}
