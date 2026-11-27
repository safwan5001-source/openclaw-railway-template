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
const MIME_EXT = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([ext, [mime]]) => [mime, ext]).reverse());
const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

const ATTACHED = /\[media attached(?: \d+\/\d+)?: ([^\]\n]{1,2048})\]/g;
/** `[media attached: media://inbound/<id>]` markers the engine adds to a user message for a stored upload. */
export function splitAttachedMarkers(text) {
  const sources = [];
  const rest = String(text ?? "").replace(ATTACHED, (_m, src) => { sources.push(src.trim().replace(/\s+\(.*\)$/, "")); return ""; });
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), sources };
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
    if (fence === null) return t.slice(0, nl + 1);
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

const typeOf = (name) => MEDIA_TYPES[path.extname(String(name)).toLowerCase()] ?? null;
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

/**
 * Media items of one transcript message, in display order. Each entry keeps its private `source` (artifact id or file reference);
 * the public view (`publicMedia`) drops it. `text` comes back without the MEDIA: lines / attachment markers.
 */
export function extractMedia(m, key, text = textOf(m)) {
  const id = typeof m?.__openclaw?.id === "string" ? m.__openclaw.id : "";
  const items = [];
  const content = Array.isArray(m?.content) ? m.content : [];
  for (const p of content) {
    if (p?.type !== "image" || typeof p.artifactId !== "string" || p.artifactId.length > 2048) continue;
    const mime = typeof p.mimeType === "string" ? p.mimeType.toLowerCase() : "image/png";
    items.push({ kind: INLINE_MIMES.has(mime) ? "image" : "file", artifact: p.artifactId, mime, name: `image${MIME_EXT[mime] ?? ".png"}`,
      size: Number.isFinite(p.bytes) ? p.bytes : null });
  }
  let rest = text;
  const files = [];
  if (m?.role === "assistant") { const s = splitMediaLines(rest); rest = s.text; files.push(...s.sources); }
  const a = splitAttachedMarkers(rest); rest = a.text; files.push(...a.sources);
  for (const src of files) {
    if (/^https:\/\//i.test(src)) { items.push({ kind: "link", url: src.slice(0, 2048), name: baseName(src.split("?")[0]) }); continue; }
    const t = typeOf(src);
    items.push({ kind: t?.[1] ? "image" : "file", file: src, mime: t?.[0] ?? null, name: baseName(src), size: null });
  }
  const media = items.slice(0, MAX_MEDIA_PER_MESSAGE).map((it, i) => ({ ...it, ref: it.kind === "link" ? null : mediaRef(key, id, i, it.artifact ?? it.file) }));
  return { text: rest, media, messageId: id };
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
 * The file behind a reference, only if: its real path is a regular file inside one of `roots`, its extension is allowlisted, it is
 * not larger than MAX_MEDIA_BYTES and its first bytes match the type. Else {error: "unavailable" | "too_large" | "unsupported"}.
 */
export async function openMediaFile(src, { workspaceDir, stateDir, roots }) {
  const abs = resolveSource(src, { workspaceDir, stateDir });
  if (!abs) return { error: "unavailable" };
  let real;
  try { real = await fs.promises.realpath(abs); } catch { return { error: "unavailable" }; }
  if (!rootList(roots).some((r) => real.startsWith(r + path.sep))) return { error: "unavailable" };
  const t = typeOf(real);
  if (!t) return { error: "unsupported" };
  let fh;
  try {
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
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

/** What the app sees of one media item: never a path, an artifact id or a URL other than a public https link. */
export function publicMedia(it, available) {
  if (it.kind === "link") return { kind: "link", name: it.name, url: it.url };
  return { ref: it.ref, kind: it.kind, name: it.name, mime: it.mime, size: it.size ?? null, available: available !== false };
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
      if (!hit || hit.key !== key || hit.messageId !== msg) {
        // not handed out by this process (restart) or asked for another message: re-derive the refs from that message itself
        const m = await ctx.findMessage(key, msg);
        if (!m) return gone();
        const { media } = extractMedia(m, key);
        const item = media.find((it) => it.ref === ref);
        if (!item) return gone();
        hit = { key, messageId: msg, item };
        ctx.cache.put(key, msg, item);
      }
      const it = hit.item;
      if (it.artifact) {
        if (!ctx.gatewayCall) return res.status(503).json({ ok: false, error: "not_available" });
        const d = await ctx.gatewayCall("artifacts.download", { sessionKey: key, artifactId: it.artifact });
        const mime = String(d?.artifact?.mimeType ?? "").toLowerCase();
        const data = d?.encoding === "base64" && typeof d.data === "string" ? Buffer.from(d.data, "base64") : null;
        if (!data || !MIME_EXT[mime] || !mime.startsWith("image/")) return res.status(415).json({ ok: false, error: "unsupported" });
        if (data.length > MAX_MEDIA_BYTES) return res.status(413).json({ ok: false, error: "too_large" });
        if (!bytesMatch(mime, data.subarray(0, 64))) return res.status(415).json({ ok: false, error: "unsupported" });
        return send(res, mime, `image${MIME_EXT[mime]}`, data.length, (out) => out.end(data));
      }
      const f = await openMediaFile(it.file, ctx);
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
