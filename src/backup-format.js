// BASHT encrypted backup format (shared by the server route and the operator's local tool, zero dependencies).
//
//   "BASHT-BACKUP-1\n" + <header JSON> + "\n" + AES-256-GCM(ciphertext) + <16-byte GCM tag>
//
// A fresh 256-bit data key per backup is wrapped with the operator's RSA public key (OAEP, SHA-256). The server only
// ever holds the PUBLIC key, so a backup cannot be decrypted on Railway, by the agent, or by anyone who steals the
// file. The whole header is authenticated as GCM additional data, so it cannot be altered either. Decryption writes to
// a temporary file and only renames it into place after the tag verifies: a truncated or tampered backup never
// produces output.
import crypto from "node:crypto";
import fs from "node:fs";
import { Transform } from "node:stream";

export const MAGIC = "BASHT-BACKUP-1\n";
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
export const MIN_RSA_BITS = 3072;

export function loadPublicKey(pem) {
  const key = crypto.createPublicKey(String(pem).replace(/\\n/g, "\n"));
  if (key.asymmetricKeyType !== "rsa") throw new Error("backup public key must be an RSA key");
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) {
    throw new Error(`backup public key must be at least ${MIN_RSA_BITS} bits`);
  }
  return key;
}

/** Short, stable fingerprint of a public key (sha256 of its SPKI DER), recorded in every backup header. */
export function keyId(publicKey) {
  const key = publicKey instanceof crypto.KeyObject && publicKey.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Transform stream: plaintext in, complete backup file (header + ciphertext + tag) out. */
export function createEncryptStream(publicKey, meta = {}) {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const wrappedKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    dataKey,
  );
  const header = {
    v: 1,
    alg: "RSA-OAEP-256+A256GCM",
    kid: keyId(publicKey),
    iv: iv.toString("base64"),
    wrappedKey: wrappedKey.toString("base64"),
    createdAt: new Date().toISOString(),
    ...meta,
  };
  const headerBytes = Buffer.from(MAGIC + JSON.stringify(header) + "\n", "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(headerBytes);
  dataKey.fill(0);
  let headerSent = false;
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      if (!headerSent) {
        this.push(headerBytes);
        headerSent = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!headerSent) this.push(headerBytes);
      this.push(cipher.final());
      cb(null, cipher.getAuthTag());
    },
  });
  stream.header = header;
  return stream;
}

/** Reads and parses the (unauthenticated until decryption) header of a backup file. */
export function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(MAX_HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    if (head.subarray(0, MAGIC.length).toString("utf8") !== MAGIC) throw new Error("not a BASHT backup file");
    const end = head.indexOf(0x0a, MAGIC.length);
    if (end < 0) throw new Error("backup header is incomplete");
    const headerBytes = head.subarray(0, end + 1);
    const header = JSON.parse(headerBytes.subarray(MAGIC.length, end).toString("utf8"));
    if (header.v !== 1 || header.alg !== "RSA-OAEP-256+A256GCM") throw new Error("unsupported backup format");
    return { header, headerBytes: Buffer.from(headerBytes) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Decrypts `file` into `outFile` with the operator's private key. Output appears only after the GCM tag verifies.
 * Resolves to the header. Rejects (and leaves no output) on a wrong key, truncation or any modification.
 */
export async function decryptFile(file, privateKey, outFile) {
  const { header, headerBytes } = readHeader(file);
  const size = fs.statSync(file).size;
  if (size < headerBytes.length + TAG_BYTES) throw new Error("backup is truncated");
  let dataKey;
  try {
    dataKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(header.wrappedKey, "base64"),
    );
  } catch {
    throw new Error("this private key cannot open the backup (wrong key)");
  }
  const tag = Buffer.alloc(TAG_BYTES);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  fs.closeSync(fd);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, Buffer.from(header.iv, "base64"));
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(tag);
  dataKey.fill(0);

  const partial = `${outFile}.partial-${process.pid}`;
  const out = fs.openSync(partial, "wx", 0o600);
  try {
    const input = fs.createReadStream(file, { start: headerBytes.length, end: size - TAG_BYTES - 1 });
    for await (const chunk of input) fs.writeSync(out, decipher.update(chunk));
    fs.writeSync(out, decipher.final()); // throws if the tag does not verify
    fs.closeSync(out);
  } catch (err) {
    try { fs.closeSync(out); } catch {}
    fs.rmSync(partial, { force: true });
    if (/auth|tag/i.test(String(err?.message))) throw new Error("backup failed authentication (corrupted, truncated or modified)");
    throw err;
  }
  fs.renameSync(partial, outFile);
  return header;
}
