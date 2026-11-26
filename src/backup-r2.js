import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

// A conservative check for residual local writers. This is a point-in-time
// check, not a filesystem snapshot or protection against other containers.
export async function assertNoBackupWriters(roots) {
  if (process.platform !== "linux") throw new Error("Backup writer check requires Linux");
  const resolved = await Promise.all(roots.map(async root => {
    try { return await fs.realpath(root); } catch (e) { if (e.code === "ENOENT") return path.resolve(root); throw e; }
  }));
  const matches = target => resolved.some(root => target === root || target.startsWith(root + "/"));
  const pids = (await fs.readdir("/proc")).filter(p => /^\d+$/.test(p));
  for (const pid of pids) {
    const base = "/proc/" + pid;
    try {
      const st = await fs.stat(base);
      if (st.uid !== process.getuid()) continue;
      for (const fd of await fs.readdir(base + "/fd")) {
        try {
          const target = (await fs.readlink(base + "/fd/" + fd)).replace(/ \(deleted\)$/, "");
          if (!matches(target)) continue;
          const info = await fs.readFile(base + "/fdinfo/" + fd, "utf8");
          const flags = /^flags:\s*([0-7]+)$/m.exec(info);
          if (!flags || (parseInt(flags[1], 8) & 3) !== 0) throw new Error("Backup blocked: writable descriptor, PID " + pid);
        } catch (e) { if (!["ENOENT","ESRCH"].includes(e.code)) throw e; }
      }
      const maps = await fs.readFile(base + "/maps", "utf8");
      for (const line of maps.split("\n")) {
        const fields = /^\S+\s+([r-][w-][x-][sp])\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
        if (fields && fields[1][1] === "w" && fields[1][3] === "s" && matches(fields[2].replace(/ \(deleted\)$/, ""))) throw new Error("Backup blocked: writable shared mapping, PID " + pid);
      }
    } catch (e) { if (!["ENOENT","ESRCH"].includes(e.code)) throw e; }
  }
}

export function r2BackupConfig(env = process.env) {
  const endpoint = env.R2_ENDPOINT?.trim();
  if (!/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/.test(endpoint || "") ||
      env.R2_BUCKET !== "basht-backups" || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 backup configuration invalid");
  }
  return { endpoint, bucket: env.R2_BUCKET, env: {
    PATH: env.PATH, HOME: env.HOME, AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "",
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required", AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required"
  }};
}
async function digest(stream) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}
function runAws(cfg, args) {
  const child = spawn("aws", ["--endpoint-url", cfg.endpoint, ...args], {
    env: cfg.env, stdio: ["ignore","pipe","ignore"], signal: AbortSignal.timeout(20 * 60 * 1000)
  });
  const done = new Promise((resolve,reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("R2 AWS command failed")));
  });
  return { child, done };
}
export async function uploadEncryptedBackup(file, cfg) {
  const local = await digest(createReadStream(file));
  const key = "pre-upgrade/" + new Date().toISOString().replace(/[:.]/g,"-") + "-" + crypto.randomBytes(8).toString("hex") + ".bkp";
  const uri = "s3://" + cfg.bucket + "/" + key;
  const upload = runAws(cfg, ["s3","cp",file,uri,"--only-show-errors"]);
  upload.child.stdout.resume();
  await upload.done;
  const download = runAws(cfg, ["s3","cp",uri,"-","--only-show-errors"]);
  const [remote] = await Promise.all([digest(download.child.stdout),download.done]);
  if (remote.sha256 !== local.sha256 || remote.bytes !== local.bytes) throw new Error("R2 backup readback mismatch");
  return { key, ...local, verified: true };
}
