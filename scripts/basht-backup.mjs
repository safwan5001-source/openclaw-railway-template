#!/usr/bin/env node
// BASHT backup tool for the OPERATOR'S OWN COMPUTER (Node >= 20, no dependencies). Never run it on Railway.
//
//   keygen  <dir>                           new RSA-4096 key pair; private key encrypted with $BASHT_BACKUP_PASSPHRASE
//   inspect <file.bkp>                      show the (non-secret) header: date, key id, contents
//   decrypt <file.bkp> <private.pem> <out>  verify + decrypt to <out> (a .tar.gz, or the original file for `seal`)
//   seal    <file> <public.pem> <out.bkp>   encrypt any local file (e.g. a legacy /setup export .zip) with the public key
//   to-import-zip <backup.tar.gz> <out.zip> turn a decrypted backup into the ZIP that /setup → Import accepts;
//                                           its archive password is $BASHT_IMPORT_PASSWORD
//
// The passphrase / import password are read from the environment so they stay out of shell history. (`zip` receives
// the import password as an argument on YOUR computer only; that ZIP is just the upload format for /setup → Import.)
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { createEncryptStream, decryptFile, keyId, loadPublicKey, readHeader } from "../src/backup-format.js";

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const need = (name, min = 1) => {
  const v = process.env[name];
  if (!v || v.length < min) die(`set ${name}${min > 1 ? ` (at least ${min} characters)` : ""}`);
  return v;
};

export async function main(argv) {
  const [cmd, a, b, c] = argv;
  switch (cmd) {
    case "keygen": {
      if (!a) die("usage: keygen <dir>");
      const passphrase = need("BASHT_BACKUP_PASSPHRASE", 12);
      fs.mkdirSync(a, { recursive: true });
      const priv = path.join(a, "basht-backup-private.pem");
      const pub = path.join(a, "basht-backup-public.pem");
      if (fs.existsSync(priv) || fs.existsSync(pub)) die(`refusing to overwrite keys in ${a}`);
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
      });
      fs.writeFileSync(priv, privateKey, { mode: 0o600, flag: "wx" });
      fs.writeFileSync(pub, publicKey, { mode: 0o644, flag: "wx" });
      console.log(`key id: ${keyId(publicKey)}\nprivate (keep offline): ${priv}\npublic (Railway variable BASHT_BACKUP_PUBLIC_KEY): ${pub}`);
      return;
    }
    case "inspect": {
      if (!a) die("usage: inspect <file.bkp>");
      const { header } = readHeader(a);
      const { wrappedKey: _w, iv: _i, ...shown } = header;
      console.log(JSON.stringify({ ...shown, bytes: fs.statSync(a).size }, null, 2));
      return;
    }
    case "decrypt": {
      if (!a || !b || !c) die("usage: decrypt <file.bkp> <private.pem> <out>");
      if (fs.existsSync(c)) die(`refusing to overwrite ${c}`);
      const privateKey = crypto.createPrivateKey({ key: fs.readFileSync(b), passphrase: need("BASHT_BACKUP_PASSPHRASE") });
      const header = await decryptFile(a, privateKey, c);
      console.log(`verified and decrypted (${header.createdAt}, key ${header.kid}) -> ${c}`);
      return;
    }
    case "seal": {
      if (!a || !b || !c) die("usage: seal <file> <public.pem> <out.bkp>");
      if (fs.existsSync(c)) die(`refusing to overwrite ${c}`);
      const publicKey = loadPublicKey(fs.readFileSync(b, "utf8"));
      const enc = createEncryptStream(publicKey, { content: "file", name: path.basename(a) });
      await pipeline(fs.createReadStream(a), enc, fs.createWriteStream(c, { flags: "wx", mode: 0o600 }));
      console.log(`sealed ${a} -> ${c} (key ${enc.header.kid}); delete the unencrypted original when done`);
      return;
    }
    case "to-import-zip": {
      if (!a || !b) die("usage: to-import-zip <backup.tar.gz> <out.zip>");
      if (fs.existsSync(b)) die(`refusing to overwrite ${b}`);
      const password = need("BASHT_IMPORT_PASSWORD", 8);
      const list = spawnSync("tar", ["-tzf", a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (list.status !== 0) die(`cannot read ${a}: ${list.stderr}`);
      const bad = list.stdout.split("\n").filter((e) => e && (e.startsWith("/") || e.split("/").includes("..")));
      if (bad.length) die(`archive contains unsafe paths: ${bad.slice(0, 3).join(", ")}`);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "basht-restore-"));
      try {
        const x = spawnSync("tar", ["-xzf", path.resolve(a), "-C", work], { encoding: "utf8" });
        if (x.status !== 0) die(`extract failed: ${x.stderr}`);
        const top = fs.readdirSync(work);
        // -r recursive, -X no extra attributes, -D no directory entries (the import accepts only entries under the state
        // and workspace paths, so a bare "data/" entry would make it refuse the archive), no -y: symlinks are never stored.
        const z = spawnSync("zip", ["-q", "-r", "-X", "-D", "-P", password, path.resolve(b), ...top], { cwd: work, encoding: "utf8" });
        if (z.status !== 0) die(`zip failed: ${z.stderr || z.stdout}`);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
      console.log(`import archive ready: ${b}\nupload it in /setup → Import and enter the same archive password`);
      return;
    }
    default:
      die("commands: keygen | inspect | decrypt | seal | to-import-zip (see the header of this file)");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => die(err.message));
}
