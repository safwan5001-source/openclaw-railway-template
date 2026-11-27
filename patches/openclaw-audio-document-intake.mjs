#!/usr/bin/env node
// BASHT build-time patch for OpenClaw 2026.11.10: audio sent as a WhatsApp *document* must reach speech-to-text
// (WhatsApp channel only; the browser live chat is not touched).
//
// Upstream behaviour: @openclaw/whatsapp sets `kind: "document"` on every file sent via the attachment (paperclip)
// path, and corrects only document -> image (`savedContentType.startsWith("image/")`). In the media-understanding
// chunk, resolveAttachmentKind() honours that explicit kind and maps `document` to `unknown`, so an `audio/mpeg`
// (mp3), `audio/mp4` (m4a), wav, etc. attachment is never selected for the audio capability. No STT runs and no
// media-understanding line is logged; the agent instead receives
//   "[Unsupported document format: audio/mpeg ... Read the file yourself with your tools]".
// Only Ogg/Opus *voice notes* (`audioMessage`, kind `audio`) were transcribed.
//
// Patch (fail-closed, additive, WhatsApp-only): in normalizeAttachments(), when the inbound context belongs to the
// WhatsApp channel (Provider / Surface / OriginatingChannel === "whatsapp"), a `document` whose MIME is `audio/*` - or
// whose MIME is absent/generic (`application/octet-stream`) and whose file name has a known audio extension - is
// classified `audio`. Everything else is unchanged: other channels (including the browser Control UI / live chat) keep
// upstream behaviour; PDFs and other documents stay documents; `video/*` documents are untouched; an explicit
// non-document kind is never overridden. The classification feeds selection (audio capability), the extractor skip
// list and the disposition markers, so a transcribed attachment is not also rendered as an "Unsupported document".
//
// The patch is exact-match and version-pinned: any drift (different OpenClaw version, different file hash, an anchor
// that matches zero or several times) fails the image build instead of shipping a half-patched runtime.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCLAW_VERSION = "2026.11.10";
export const TARGET_FILE = "dist/attachments.normalize-H6KPb1Ga.mjs";
export const ORIGINAL_SHA256 = "9b9cb1b023acb58863fce568eddceb89041d2e93afe55e41c92be9ea9112c4be";
export const PATCH_MARKER = "basht-patch:audio-document-intake";
const CONTENT_INVENTORY = "dist/postinstall-content-inventory.json";

const FN_ANCHOR = "function normalizeAttachments(e){return normalizeMediaFacts(e.media).map((e,t)=>{";
const FN_REPLACEMENT = "function normalizeAttachments(e){const bashtWa=bashtIsWhatsAppContext(e);return normalizeMediaFacts(e.media).map((e,t)=>{";
const KIND_ANCHOR = "if(r)n.kind=r;";
const KIND_REPLACEMENT = "if(r)n.kind=bashtWa&&r===`document`&&bashtIsAudioDocument({mime:n.mime,fileName:e.fileName,path:n.path,url:n.url})?`audio`:r;";
// Minified-safe (no line comments): the real module keeps statement groups on one line.
const HELPER = "/*" + PATCH_MARKER + "*/const BASHT_AUDIO_DOC_EXT=/\\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|amr|weba)$/i;" +
  "function bashtIsWhatsAppContext(c){return[c?.Provider,c?.Surface,c?.OriginatingChannel].some(v=>String(v??``).trim().toLowerCase()===`whatsapp`)}" +
  "function bashtIsAudioDocument(a){const m=String(a.mime??``).split(`;`)[0].trim().toLowerCase();" +
  "if(m.startsWith(`audio/`))return true;" +
  "if(m&&m!==`application/octet-stream`&&m!==`binary/octet-stream`)return false;" +
  "return BASHT_AUDIO_DOC_EXT.test(String(a.fileName??a.path??a.url??``).split(/[?#]/)[0].trim())}";

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first === -1) throw new Error(`audio-document patch: anchor not found (${label})`);
  if (source.indexOf(anchor, first + anchor.length) !== -1) throw new Error(`audio-document patch: anchor not unique (${label})`);
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Pure transform of the original module text. Throws on any drift. */
export function patchSource(original) {
  if (original.includes(PATCH_MARKER)) throw new Error("audio-document patch: already applied");
  let out = original;
  out = replaceOnce(out, KIND_ANCHOR, KIND_REPLACEMENT, "attachment kind assignment");
  out = replaceOnce(out, FN_ANCHOR, HELPER + FN_REPLACEMENT, "normalizeAttachments declaration");
  return out;
}

/** Reverse the additive edits (used only to verify an already-patched file byte-for-byte). */
export function readOriginalFromPatched(patched) {
  let out = patched;
  out = replaceOnce(out, KIND_REPLACEMENT, KIND_ANCHOR, "unpatch kind");
  out = replaceOnce(out, HELPER + FN_REPLACEMENT, FN_ANCHOR, "unpatch declaration");
  return out;
}

function readPackageVersion(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

/** Keep OpenClaw's own dist content inventory consistent with the patched file (used by update/doctor checks). */
function updateContentInventory(packageRoot, relativePath, text, mode) {
  const inventoryPath = path.join(packageRoot, CONTENT_INVENTORY);
  if (!fs.existsSync(inventoryPath)) return false;
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const entry = Array.isArray(inventory) ? inventory.find((item) => item?.path === relativePath) : undefined;
  if (!entry) throw new Error(`audio-document patch: ${relativePath} missing from ${CONTENT_INVENTORY}`);
  entry.sha256 = sha256(text);
  entry.size = Buffer.byteLength(text);
  entry.mode = mode & 0o777;
  fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return true;
}

/** Patch an installed OpenClaw package in place. Idempotent when the patched file is already present. */
export function applyToPackage(packageRoot, { log = console } = {}) {
  const version = readPackageVersion(packageRoot);
  if (version !== OPENCLAW_VERSION) {
    throw new Error(`audio-document patch: expected openclaw ${OPENCLAW_VERSION}, found ${version}. Re-validate the patch before upgrading.`);
  }
  const target = path.join(packageRoot, TARGET_FILE);
  const stat = fs.statSync(target);
  const current = fs.readFileSync(target, "utf8");
  if (current.includes(PATCH_MARKER)) {
    const original = readOriginalFromPatched(current);
    if (sha256(original) !== ORIGINAL_SHA256 || patchSource(original) !== current) {
      throw new Error("audio-document patch: target carries the marker but does not match the expected patched content");
    }
    log.info?.(`[audio-document-patch] already applied to ${TARGET_FILE}`);
    return { applied: false, alreadyPatched: true };
  }
  if (sha256(current) !== ORIGINAL_SHA256) {
    throw new Error(`audio-document patch: ${TARGET_FILE} hash ${sha256(current)} != expected ${ORIGINAL_SHA256}`);
  }
  const patched = patchSource(current);
  fs.writeFileSync(target, patched, { mode: stat.mode });
  const inventoryUpdated = updateContentInventory(packageRoot, TARGET_FILE, patched, stat.mode);
  log.info?.(`[audio-document-patch] patched ${TARGET_FILE} (sha256 ${sha256(patched)}; inventory ${inventoryUpdated ? "updated" : "absent"})`);
  return { applied: true, alreadyPatched: false, sha256: sha256(patched) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] || "/usr/local/lib/node_modules/openclaw";
  try {
    applyToPackage(root);
  } catch (err) {
    console.error(`[audio-document-patch] ${err.message}`);
    process.exit(1);
  }
}
