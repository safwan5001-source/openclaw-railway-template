// BASHT app bridge — media in and out (B2). Pure helpers plus the GET /app/v1/media route; wired in by src/app-bridge.js.
//
// In:  the owner's photos ride on the SAME app turn (/v1/chat/completions `image_url` data parts): validated here (count, size,
//      MIME, magic bytes). The app has already downscaled them and re-encoded them, which also drops EXIF/location.
// Out: what BASHT shows in a reply or keeps in a message becomes `media: [{ref, kind, name, mime, size, available}]` on /history:
//      - image blocks of the transcript (`artifactId`) — fetched with the engine's own `artifacts.download` (operator.read);
//      - standalone `MEDIA:` lines of an assistant reply (the engine's own rule: trimmed line, outside code), and
//        `[media attached: …]` markers / `media://inbound/<id>` references.
//      A local file is served ONLY when its real path (symlinks resolved) is a regular file inside an engine-owned root
//      (the agent workspace or <stateDir>/media), its type is on a fixed allowlist and its bytes match that type, and it is
//      under the size cap. Nothing is ever listed. The app never sees a server path: a ref is a hash of (session, message,
//      position, source), re-derived from that message when the app asks for it (so a ref only works for the message it came from).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_IMAGES = 8; // engine: DEFAULT_OPENAI_MAX_IMAGE_PARTS
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // engine: DEFAULT_INPUT_IMAGE_MAX_BYTES (decoded)
export const MAX_IMAGES_TOTAL_BYTES = 14 * 1024 * 1024; // keeps the whole JSON body under the engine's 20 MiB chat-completions cap
export const SEND_BODY_LIMIT = "19mb";
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // one file out
const MAX_MEDIA_PER_MESSAGE = 12;
const REF_CACHE = 2000;

/** Image types the engine accepts as input (DEFAULT_INPUT_IMAGE_MIMES), with their magic bytes. */
export const IMAGE_IN_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);

/** Files the app may receive: extension -> [content type, inline-viewable image]. SVG is never inline (it is a document). */
export const MEDIA_TYPES = {
  ".png": ["image/png", true], ".jpg": ["image/jpeg", true], ".jpeg": ["image/jpeg", true], ".gif": ["image/gif", true],
  ".webp": ["image/webp", true], ".heic": ["image/heic", false], ".heif": ["image/heif", false],
  ".pdf": ["application/pdf", false], ".txt": ["text/plain", false], ".md": ["text/markdown", false], ".csv": ["text/csv", false],
  ".json": ["application/json", false],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", false],
  ".mp3": ["audio/mpeg", false], ".m4a": ["audio/mp4", false], ".ogg": ["audio/ogg", false], ".wav": ["audio/wav", false],
  ".mp4": ["video/mp4", false],
};
const MIME_EXT = Object.assign(Object.create(null), Object.fromEntries(Object.entries(MEDIA_TYPES).map(([ext, [mime]]) => [mime, ext]).reverse()));
const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** An inline image (decoded from the transcript row on every request) is capped below the CLI's output buffer of the anchored read (~8 MB of JSON). */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;
/** The mime of a declared type if it is one of the allowlisted ones (own keys only: "constructor" is not a type), else null. */
const knownMime = (m) => (typeof m === "string" && Object.hasOwn(MIME_EXT, m) ? m : null);

/** Does `buf` start like a file of `mime`? Unknown types (and text) are checked for what they must NOT be. */
export function bytesMatch(mime, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const at = (off, s) => b.length >= off + s.length && b.subarray(off, off + s.length).equals(Buffer.from(s, "latin1"));
  switch (mime) {
    case "image/jpeg": return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": return at(0, "\x89PNG\r\n\x1a\n");
    case "image/gif": return at(0, "GIF87a") || at(0, "GIF89a");
    case "image/webp": return at(0, "RIFF") && at(8, "WEBP");
    case "image/heic": case "image/heif": return at(4, "ftyp") && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(b.subarray(8, 12).toString("latin1"));
    case "application/pdf": return at(0, "%PDF-");
    case "audio/mpeg": return at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case "audio/ogg": return at(0, "OggS");
    case "audio/wav": return at(0, "RIFF") && at(8, "WAVE");
    case "audio/mp4": case "video/mp4": return at(4, "ftyp");
    default:
      if (mime.startsWith("application/vnd.openxmlformats")) return at(0, "PK\x03\x04");
      // text: no NUL bytes in the first 4 KiB (a binary file renamed .txt is refused)
      if (mime.startsWith("text/") || mime === "application/json") return !b.subarray(0, 4096).includes(0);
      return false;
  }
}

/**
 * The `images` field of POST /send: [{mime, data (base64, no data: prefix)}]. Returns {images} (decoded sizes checked, magic bytes
 * checked) or {error}. Every rule here is also enforced by the engine; the bridge refuses early with a clear code.
 */
export function parseImages(raw) {
  if (raw === undefined || raw === null) return { images: [] };
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return { error: raw?.length > MAX_IMAGES ? "too_many_images" : "bad_request" };
  const images = [];
  let total = 0;
  for (const it of raw) {
    const mime = typeof it?.mime === "string" ? it.mime.trim().toLowerCase() : "";
    const data = typeof it?.data === "string" ? it.data : "";
    if (!IMAGE_IN_TYPES.has(mime)) return { error: "unsupported_image" };
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: "bad_request" };
    const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) return { error: "image_too_large" };
    total += bytes;
    if (total > MAX_IMAGES_TOTAL_BYTES) return { error: "images_too_large" };
    if (!bytesMatch(mime, Buffer.from(data.slice(0, 64), "base64"))) return { error: "unsupported_image" };
    images.push({ mime, data, bytes });
  }
  return { images };
}

/** The chat-completions `content` of one owner turn: the text, then each image as a data URI (what the engine expects). */
export function turnContent(message, images) {
  if (!images.length) return message;
  return [...(message ? [{ type: "text", text: message }] : []),
    ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))];
}

// ---------------------------------------------------------------- media out ----------------------------------------------------

const FENCE = /^ {0,3}(```|~~~)/;
/** Standalone `MEDIA:` lines (the engine's legacy rule: trimmed line starts with MEDIA:, <=3 leading spaces, outside fenced code). */
export function splitMediaLines(text) {
  const out = []; const keep = [];
  let fence = null;
  for (const line of String(text ?? "").split("\n")) {
    const f = FENCE.exec(line);
    if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; keep.push(line); continue; }
    const m = fence === null && /^ {0,3}MEDIA:\s*(.+?)\s*$/.exec(line);
    if (m) {
      let src = m[1];
      if (src.length > 1 && src.startsWith('"') && src.endsWith('"')) src = src.slice(1, -1);
      if (src && src.length <= 2048) { out.push(src); continue; }
    }
    keep.push(line);
  }
  return { text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), sources: out };
}

const MARKER_HEADER = /\[media attached(?: \d+\/\d+)?: /y;
const MARKER_WINDOW = 8192; // a marker (path, type, URL and file name) is never searched for beyond this
const MARKER_BODY_MAX = 2048;

/**
 * Where the marker whose body starts at `b` ends: {body, next} (the text of its source part, the index after its `]`) or null.
 * The engine writes `<path> (<type>) | <url> "<file name>"`, the name as a JSON string, so a name may hold `]`, `"` (escaped, or not
 * when something else wrote it) and be long. The name starts at the first ` "` before the first `]`, and ends at the first
 * unescaped `"` that is directly followed by `]`; without such a pair the marker ends at the first `]`. One bounded pass.
 */
function markerEnd(t, b) {
  const win = t.slice(b, b + MARKER_WINDOW);
  const nl = win.indexOf("\n");
  const seg = nl < 0 ? win : win.slice(0, nl);
  const first = seg.indexOf("]");
  const q = seg.indexOf(' "');
  if (q >= 0 && (first < 0 || q < first)) {
    for (let i = q + 2; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c === 92) { i++; continue; } // backslash escape
      if (c === 34 && seg.charCodeAt(i + 1) === 93) return q >= 1 && q <= MARKER_BODY_MAX ? { body: seg.slice(0, q), next: b + i + 2 } : null;
    }
  }
  return first >= 1 && first <= MARKER_BODY_MAX ? { body: seg.slice(0, first), next: b + first + 1 } : null;
}

/**
 * What one `[media attached: …]` marker names (its body without the file name). The stored-upload URL (`media://inbound/<id>`,
 * prefix only: what follows is not part of it) wins when there is one; else the path. The content type is never part of the source.
 * Linear in the body: no pattern here can backtrack.
 */
function attachedSource(body) {
  const stripType = (v) => {
    const x = v.trim();
    if (!x.endsWith(")")) return x;
    const i = x.lastIndexOf(" (");
    return i > 0 && !x.slice(i + 2, -1).includes("(") && !x.slice(i + 2, -1).includes(")") ? x.slice(0, i).trimEnd() : x;
  };
  const b = body.trim();
  const sep = b.indexOf(" | ");
  if (sep >= 0) {
    const m = /^media:\/\/inbound\/[A-Za-z0-9._-]+/i.exec(b.slice(sep + 3).trimStart());
    if (m) return m[0];
  }
  return stripType(sep >= 0 ? b.slice(0, sep) : b);
}
/** `[media attached: media://inbound/<id>]` markers the engine adds to a user message for a stored upload. */
export function splitAttachedMarkers(text) {
  const t = String(text ?? "");
  const sources = [];
  let out = "";
  let pos = 0;
  for (;;) {
    const i = t.indexOf("[media attached", pos);
    if (i < 0) break;
    MARKER_HEADER.lastIndex = i;
    const h = MARKER_HEADER.exec(t);
    const end = h ? markerEnd(t, i + h[0].length) : null;
    if (!end) { out += t.slice(pos, i + 1); pos = i + 1; continue; } // not a marker: keep it
    out += t.slice(pos, i);
    sources.push(attachedSource(end.body));
    pos = end.next;
  }
  out += t.slice(pos);
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), sources };
}

const MEDIA_LINE_PREFIX = "MEDIA:";
const ATTACHED_PREFIX = "[media attached";

/**
 * While a reply streams, its last line may be half of a marker that the next chunk completes: "ME", "MEDIA:", "[media att",
 * "[media attached: /files/ch" (no closing bracket yet). Returns `text` without such a trailing fragment, else `text` itself.
 * Only the very end is looked at (a finished marker is the job of splitMediaLines / splitAttachedMarkers) and a fenced code
 * block is left alone, as in splitMediaLines.
 */
export function dropPartialMarker(text) {
  const t = String(text ?? "");
  const nl = t.lastIndexOf("\n");
  const last = t.slice(nl + 1);
  // `[media attached…` can start mid-line; it is partial while its `]` has not arrived
  const br = last.lastIndexOf("[");
  if (br >= 0 && !last.includes("]", br)) {
    const tail = last.slice(br);
    if (ATTACHED_PREFIX.startsWith(tail) || tail.startsWith(ATTACHED_PREFIX)) return t.slice(0, nl + 1 + br);
  }
  // `MEDIA:` only counts as a standalone line (<= 3 leading spaces, outside fenced code)
  const bare = last.replace(/^ {0,3}/, "");
  if (bare && MEDIA_LINE_PREFIX.startsWith(bare) && last.length - bare.length <= 3) {
    let fence = null;
    for (const line of t.slice(0, nl + 1).split("\n")) {
      const f = FENCE.exec(line);
      if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    }
    if (fence === null) return t.slice(0, Math.max(nl, 0)); // the newline before the fragment goes with it
  }
  return t;
}

/**
 * The text of a LIVE reply (GET /runs/:id) as the app should show it: standalone `MEDIA:` lines and `[media attached: …]` markers
 * removed with the very same rules as history rows (splitMediaLines / splitAttachedMarkers), and, while the reply is still
 * streaming (`streaming: true`), a trailing half-written marker too. A text without any marker comes back exactly as it was.
 */
export function cleanLiveText(text, { streaming = false } = {}) {
  const raw = String(text ?? "");
  const base = streaming ? dropPartialMarker(raw) : raw;
  const lines = splitMediaLines(base);
  const attached = splitAttachedMarkers(lines.text);
  if (!lines.sources.length && !attached.sources.length) return base;
  return attached.text;
}

const typeOf = (name) => { const e = path.extname(String(name)).toLowerCase(); return Object.hasOwn(MEDIA_TYPES, e) ? MEDIA_TYPES[e] : null; };
/** The type a file is served as: its extension's, else (an id without one) the image type the engine recorded for it, if inline-viewable. */
const fileType = (real, hint) => typeOf(real) ?? (INLINE_MIMES.has(hint) ? [hint, true] : null);
const baseName = (src) => {
  const s = String(src).replace(/^media:\/\/inbound\//i, "");
  try { return path.basename(decodeURIComponent(s)).slice(0, 120) || "file"; } catch { return path.basename(s).slice(0, 120) || "file"; }
};

/** Text parts of a transcript message (the same rule as the bridge's messageText). */
export function textOf(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

/** sha256(session \0 message \0 position \0 source), 32 hex chars: opaque, stable, and only valid for that message. */
export function mediaRef(key, messageId, index, source) {
  return crypto.createHash("sha256").update(`${key}\0${messageId}\0${index}\0${source}`).digest("hex").slice(0, 32);
}

/** The text the engine's chat endpoint writes for a turn made of images only. It is not the owner's words: never shown. */
export const IMAGE_ONLY_PLACEHOLDER = "User sent image(s) with no text.";

/** The key two references to the same stored upload share: `media://inbound/<id>` and the absolute path of that file are one. */
const sameFileKey = (src) => {
  const s = String(src);
  const m = /^media:\/\/inbound\/([^/\\]+)$/i.exec(s) ?? /[/\\]media[/\\]inbound[/\\]([^/\\]+)$/.exec(s);
  return m ? `inbound/${m[1]}` : s;
};

/** Decoded size of a base64 string without decoding it. */
const base64Bytes = (data) => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/** The inline base64 payload of an image block of a transcript message (`data`, or `source.data` in the provider shape), else "". */
function inlineData(p) {
  const d = typeof p?.data === "string" ? p.data : typeof p?.source?.data === "string" ? p.source.data : "";
  return d;
}

/** Standard base64 with correct padding (length a multiple of 4, `=` only at the very end, at most two). */
const validBase64 = (data) => data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
/** The decoded first bytes of a (valid) base64 payload: the first 48 characters (a multiple of 4, so cut on a byte boundary), or all of it. */
const headBytes = (data) => Buffer.from(data.slice(0, 48), "base64");

/**
 * Is the inline payload of block `p` something /media may serve? Looks at the declared type, the size, the base64 form (padding
 * included) and the first bytes: exactly what inlineImageBytes enforces when the bytes are asked for.
 */
function inlineUsable(data, mime) {
  if (!INLINE_MIMES.has(mime) || data.length < 4 || base64Bytes(data) > MAX_INLINE_BYTES || !validBase64(data)) return false;
  return bytesMatch(mime, headBytes(data));
}

/**
 * Media items of one transcript message, in display order. Each entry keeps its private `source` (artifact id, block index or file
 * reference); the public view (`publicMedia`) drops it. `text` comes back without the MEDIA: lines / attachment markers.
 *
 * An image block of a message can be, depending on what the engine kept:
 *   - `{type:"image", artifactId, mimeType, bytes, omitted:true}`: what the engine's own history view shows for every stored image
 *     (the inline payload is replaced by an artifact id; read back with `artifacts.download`);
 *   - `{type:"image", data, mimeType}`: the payload inline (raw transcript shape; served by decoding that block on demand);
 *   - `{type:"image", mimeType, bytes, omitted:true}`: nothing left to read from the block. The message's own file facts
 *     (`__openclaw.media`, the `[media attached: …]` marker) may still name the stored file; else the image is listed as unavailable.
 * An image block never makes the message disappear: it always yields one item, `avail: false` when its bytes cannot be served.
 * A file reference that names the same upload as an image block is that block's file, not a second image.
 */
export function extractMedia(m, key, text = textOf(m)) {
  const id = typeof m?.__openclaw?.id === "string" ? m.__openclaw.id : "";
  const content = Array.isArray(m?.content) ? m.content : [];
  const blocks = [];
  content.forEach((p, ci) => {
    if (p?.type !== "image") return;
    // declared type: `mimeType`, else the provider shape's `source.media_type`, else png. Only allowlisted types are ever published.
    const declared = [p.mimeType, p.source?.media_type].find((v) => typeof v === "string" && v.length > 0 && v.length < 100);
    const mime = declared === undefined ? "image/png" : knownMime(declared.toLowerCase());
    const label = (m) => `image${m ? MIME_EXT[m] : ""}`;
    const size = Number.isFinite(p.bytes) ? p.bytes : null;
    if (typeof p.artifactId === "string" && p.artifactId && p.artifactId.length <= 2048) {
      // served by artifacts.download for any allowlisted image type (a heic is a download, not an inline picture)
      blocks.push({ kind: INLINE_MIMES.has(mime) ? "image" : "file", artifact: p.artifactId, mime, name: label(mime), size, avail: mime !== null && mime.startsWith("image/") });
      return;
    }
    const data = inlineData(p);
    if (data) {
      blocks.push({ kind: INLINE_MIMES.has(mime) ? "image" : "file", inline: ci, mime, name: label(mime), size: base64Bytes(data), avail: inlineUsable(data, mime) });
      return;
    }
    blocks.push({ kind: "image", missing: ci, mime, name: label(mime), size, avail: false });
  });

  let rest = text;
  const files = [];
  if (m?.role === "assistant") { const s = splitMediaLines(rest); rest = s.text; files.push(...s.sources); }
  const a = splitAttachedMarkers(rest); rest = a.text; files.push(...a.sources);
  // what the engine recorded for the stored uploads of this message (a marker may be missing; these are projected to media://inbound/<id>)
  const facts = m?.role === "user" && Array.isArray(m?.__openclaw?.media) ? m.__openclaw.media : [];
  const hints = new Map(); // same-file key -> the content type the engine recorded for it
  for (const f of facts) {
    const src = [f?.path, f?.url].find((v) => typeof v === "string" && /^media:\/\/inbound\/[^/\\]+$/i.test(v));
    if (!src) continue;
    files.push(src);
    if (typeof f.contentType === "string") hints.set(sameFileKey(src), f.contentType.toLowerCase());
  }
  const seenFiles = new Set();
  const refs = files.filter((src) => { const k = sameFileKey(src); if (seenFiles.has(k)) return false; seenFiles.add(k); return true; }).map((src) => {
    if (/^https:\/\//i.test(src)) return { kind: "link", url: src.slice(0, 2048), name: baseName(src.split("?")[0]) };
    const t = typeOf(src);
    // an id without an extension: the content type the engine recorded for it decides (inline-viewable image types only; the bytes
    // are still checked against it when served)
    const hint = t ? null : (INLINE_MIMES.has(hints.get(sameFileKey(src))) ? hints.get(sameFileKey(src)) : null);
    const name = baseName(src);
    const recorded = hints.get(sameFileKey(src));
    return { kind: t ? (t[1] ? "image" : "file") : hint ? "image" : "file", pictured: !!(t?.[0].startsWith("image/") || recorded?.startsWith("image/")), file: src, mime: t?.[0] ?? hint, ...(hint ? { hint } : {}),
      name: hint && !path.extname(name) ? `${name}${MIME_EXT[hint]}` : name, size: null };
  });

  // each image block takes the next image file reference of the same message: it is that block's file (used only when the block
  // itself has nothing to read), never a second picture
  // (only in a user row: an assistant reply that carries a block and a MEDIA: line shows both)
  const items = [];
  // (every picture file of the message counts, a heic too: a block that is not inline-viewable must not shift the pairing of the next one)
  const spare = m?.role === "user" ? refs.filter((r) => r.pictured) : [];
  const used = new Set();
  for (const b of blocks) {
    // the next picture file of the message; one whose type is known and differs from the block's is another picture's (a heic block
    // without a file of its own must not take the jpeg's)
    const at = spare.findIndex((r) => !b.mime || !r.mime || b.mime === r.mime);
    const own = at >= 0 ? spare.splice(at, 1)[0] : undefined;
    if (own) used.add(own);
    items.push(b.missing !== undefined && own ? own : b);
  }
  items.push(...refs.filter((r) => !used.has(r)));

  // a turn of images only: the engine writes its own sentence for it. It goes; and an image the engine kept nothing of is still listed
  if (m?.role === "user" && rest.trim() === IMAGE_ONLY_PLACEHOLDER) {
    rest = "";
    if (!items.some((it) => it.kind === "image" || (it.kind === "file" && it.mime?.startsWith("image/")))) items.push({ kind: "image", missing: -1, mime: null, name: "image", size: null, avail: false });
  }
  const source = (it) => it.artifact ?? it.file ?? (it.inline !== undefined ? `inline:${it.inline}` : `missing:${it.missing}`);
  const media = items.slice(0, MAX_MEDIA_PER_MESSAGE).map((it, i) => ({ ...it, ref: it.kind === "link" ? null : mediaRef(key, id, i, source(it)) }));
  return { text: rest, media, messageId: id };
}

/** The bytes of an inline image block of message `m` (the item came from extractMedia of that same message), or {error}. */
export function inlineImageBytes(m, item) {
  const p = Array.isArray(m?.content) ? m.content[item.inline] : null;
  const data = p?.type === "image" ? inlineData(p) : "";
  if (!data || !INLINE_MIMES.has(item.mime)) return { error: "not_found" };
  if (base64Bytes(data) > MAX_INLINE_BYTES) return { error: "too_large" };
  if (!validBase64(data)) return { error: "unsupported" };
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_INLINE_BYTES) return { error: "too_large" };
  if (!bytesMatch(item.mime, bytes.subarray(0, 64))) return { error: "unsupported" };
  return { bytes };
}

/**
 * Engine-owned roots a MEDIA: file may live in, as a getter of real paths. Resolved lazily on every call: a root that does not
 * exist yet (a fresh volume: no <stateDir>/media until the first upload) is picked up as soon as it appears; a root is cached
 * only once it resolved.
 */
export function mediaRoots(workspaceDir, stateDir) {
  const wanted = [workspaceDir, stateDir && path.join(stateDir, "media")].filter(Boolean);
  const known = new Map();
  return () => wanted.map((r) => {
    if (known.has(r)) return known.get(r);
    try { const real = fs.realpathSync(r); known.set(r, real); return real; } catch { return null; }
  }).filter(Boolean);
}
const rootList = (roots) => (typeof roots === "function" ? roots() : roots ?? []);

/** A file reference -> the absolute path it names (relative to the workspace, ~/ to home, media://inbound/<id> to the store). */
export function resolveSource(src, { workspaceDir, stateDir }) {
  const s = String(src ?? "");
  if (!s || s.includes("\0")) return null;
  const inbound = /^media:\/\/inbound\/([^/\\]+)$/i.exec(s);
  if (inbound) {
    let id; try { id = decodeURIComponent(inbound[1]); } catch { return null; }
    if (!stateDir || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(id) || id.includes("..")) return null;
    return path.join(stateDir, "media", "inbound", id);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // other schemes (file://, http://, …) are never followed
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  if (path.isAbsolute(s)) return path.normalize(s);
  return workspaceDir ? path.resolve(workspaceDir, s) : null;
}

/**
 * The file behind a reference, only if: its real path is a regular file inside one of `roots`, its type is allowlisted (by extension,
 * else the recorded inline-viewable image type `hint`), it is not larger than MAX_MEDIA_BYTES and its first bytes match the type.
 * Else {error: "unavailable" | "too_large" | "unsupported"}. `checkMediaFile` applies exactly the same rules without keeping it open.
 */
// Read-only, never follow a final symlink, and NEVER wait for a writer: a named pipe (FIFO) with an allowlisted name would otherwise
// block the open() (the whole event loop for the synchronous listing check) until some process opens its other end. With O_NONBLOCK the
// open returns at once and the regular-file check that follows refuses it.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

export async function openMediaFile(src, { workspaceDir, stateDir, roots, hint }) {
  const abs = resolveSource(src, { workspaceDir, stateDir });
  if (!abs) return { error: "unavailable" };
  let real;
  try { real = await fs.promises.realpath(abs); } catch { return { error: "unavailable" }; }
  if (!rootList(roots).some((r) => real.startsWith(r + path.sep))) return { error: "unavailable" };
  const t = fileType(real, hint);
  if (!t) return { error: "unsupported" };
  let fh;
  try {
    fh = await fs.promises.open(real, OPEN_FLAGS);
    const st = await fh.stat();
    if (!st.isFile()) { await fh.close(); return { error: "unavailable" }; }
    if (st.size > MAX_MEDIA_BYTES) { await fh.close(); return { error: "too_large" }; }
    const head = Buffer.alloc(Math.min(4096, st.size));
    await fh.read(head, 0, head.length, 0);
    if (!bytesMatch(t[0], head)) { await fh.close(); return { error: "unsupported" }; }
    return { fh, size: st.size, mime: t[0], name: path.basename(real).slice(0, 120) };
  } catch {
    await fh?.close().catch(() => {});
    return { error: "unavailable" };
  }
}

/** Would `openMediaFile` serve this reference? The same steps, synchronously, for listing: {ok: true, size} or {ok: false}. */
export function checkMediaFile(src, { workspaceDir, stateDir, roots, hint }) {
  const abs = resolveSource(src, { workspaceDir, stateDir });
  if (!abs) return { ok: false };
  let fd;
  try {
    const real = fs.realpathSync(abs);
    if (!rootList(roots).some((r) => real.startsWith(r + path.sep))) return { ok: false };
    const t = fileType(real, hint);
    if (!t) return { ok: false };
    fd = fs.openSync(real, OPEN_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_MEDIA_BYTES) return { ok: false };
    const head = Buffer.alloc(Math.min(4096, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    return bytesMatch(t[0], head) ? { ok: true, size: st.size } : { ok: false };
  } catch { return { ok: false }; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** What the app sees of one media item: never a path, an artifact id or a URL other than a public https link. */
export function publicMedia(it, available) {
  if (it.kind === "link") return { kind: "link", name: it.name, url: it.url };
  return { ref: it.ref, kind: it.kind, name: it.name, mime: knownMime(it.mime), size: it.size ?? null, available: available !== false };
}

/** Bounded memory of refs the bridge has handed out: ref -> {key, messageId, item}. Lets /media skip a transcript re-read. */
export function createRefCache(max = REF_CACHE) {
  const map = new Map();
  return {
    put(key, messageId, item) { map.delete(item.ref); map.set(item.ref, { key, messageId, item }); while (map.size > max) map.delete(map.keys().next().value); },
    get(ref) { return map.get(ref) ?? null; },
    size: () => map.size,
  };
}

const REF_RE = /^[0-9a-f]{32}$/;
const MSG_RE = /^[A-Za-z0-9_-]{6,100}$/;

/**
 * GET /app/v1/media?key=&msg=&ref= : the bytes of one media item of one message of an allowed conversation.
 * ctx: { readable(key) -> bool, findMessage(key, messageId) -> transcript message | null, gatewayCall, cache, roots, workspaceDir,
 *        stateDir, log }
 */
export function registerMediaRoute(router, ctx) {
  router.get("/media", async (req, res) => {
    const key = String(req.query.key ?? ""); const ref = String(req.query.ref ?? ""); const msg = String(req.query.msg ?? "");
    if (!REF_RE.test(ref) || !MSG_RE.test(msg) || key.length > 300) return res.status(400).json({ ok: false, error: "bad_request" });
    const gone = () => res.status(404).json({ ok: false, error: "not_found" });
    try {
      if (!ctx.readable(key)) return gone();
      let hit = ctx.cache.get(ref);
      let found = null; // the message itself, when it had to be read (an inline image is decoded from it, never cached)
      if (!hit || hit.key !== key || hit.messageId !== msg || hit.item.inline !== undefined) {
        // not handed out by this process (restart), asked for another message, or an inline image (its bytes live in the
        // transcript row, not here): re-derive the refs from that message itself
        found = await ctx.findMessage(key, msg);
        if (!found) return gone();
        const { media } = extractMedia(found, key);
        const item = media.find((it) => it.ref === ref);
        if (!item) return gone();
        hit = { key, messageId: msg, item };
        ctx.cache.put(key, msg, item);
      }
      const it = hit.item;
      if (it.inline !== undefined) {
        const r = inlineImageBytes(found, it);
        if (r.error) return res.status(r.error === "too_large" ? 413 : r.error === "unsupported" ? 415 : 404).json({ ok: false, error: r.error });
        return send(res, it.mime, it.name, r.bytes.length, (out) => out.end(r.bytes));
      }
      if (it.missing !== undefined) return gone(); // the engine kept no bytes for this image
      if (it.artifact) {
        if (!ctx.gatewayCall) return res.status(503).json({ ok: false, error: "not_available" });
        const d = await ctx.gatewayCall("artifacts.download", { sessionKey: key, artifactId: it.artifact });
        const mime = String(d?.artifact?.mimeType ?? "").toLowerCase();
        const data = d?.encoding === "base64" && typeof d.data === "string" ? Buffer.from(d.data, "base64") : null;
        if (!data || !knownMime(mime) || !mime.startsWith("image/")) return res.status(415).json({ ok: false, error: "unsupported" });
        if (data.length > MAX_MEDIA_BYTES) return res.status(413).json({ ok: false, error: "too_large" });
        if (!bytesMatch(mime, data.subarray(0, 64))) return res.status(415).json({ ok: false, error: "unsupported" });
        return send(res, mime, `image${MIME_EXT[mime]}`, data.length, (out) => out.end(data));
      }
      const f = await openMediaFile(it.file, { ...ctx, hint: it.hint });
      if (f.error) return res.status(f.error === "too_large" ? 413 : f.error === "unsupported" ? 415 : 404).json({ ok: false, error: f.error === "unavailable" ? "not_found" : f.error });
      return send(res, f.mime, f.name, f.size, (out) => {
        const stream = f.fh.createReadStream({ start: 0, end: Math.max(f.size - 1, 0), autoClose: true });
        stream.on("error", () => out.destroy());
        out.on("close", () => stream.destroy());
        if (f.size === 0) { stream.destroy(); f.fh.close().catch(() => {}); return out.end(); }
        stream.pipe(out);
      });
    } catch (err) {
      ctx.log?.warn?.("app-bridge", `media: ${err?.message ?? err}`);
      if (err?.refused) return gone(); // the engine said no (artifact gone, no access)
      return res.status(502).json({ ok: false, error: "engine_unavailable" });
    }
  });
}

function send(res, mime, name, size, write) {
  res.status(200);
  res.set({
    "Content-Type": mime,
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  write(res);
}
