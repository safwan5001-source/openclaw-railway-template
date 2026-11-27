// Tests for the BASHT audio-document intake patch (audio sent as a WhatsApp document must reach STT).
//   node --test patches/openclaw-audio-document-intake.test.mjs
// Integration blocks (real OpenClaw 2026.11.10 dist) run only when OPENCLAW_PACKAGE_ROOT points at an installed
// openclaw package. The end-to-end block additionally needs the patch applied to that package
// (node patches/openclaw-audio-document-intake.mjs "$OPENCLAW_PACKAGE_ROOT"); it uses a local CLI STT stub that
// never reads or sends audio. Nothing here touches /data, Railway, WhatsApp or any network.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ORIGINAL_SHA256,
  OPENCLAW_VERSION,
  PATCH_MARKER,
  TARGET_FILE,
  applyToPackage,
  patchSource,
  readOriginalFromPatched,
  sha256,
} from "./openclaw-audio-document-intake.mjs";

// Stand-in with both anchors exactly once, in the real (minified) shape of the 2026.11.10 module.
const FN_ANCHOR = "function normalizeAttachments(e){return normalizeMediaFacts(e.media).map((e,t)=>{";
const KIND_ANCHOR = "if(r)n.kind=r;";
const FIXTURE = [
  "//!src/media-understanding/attachments.normalize.ts",
  `${FN_ANCHOR}const n={path:e.path,url:e.url,mime:e.contentType,index:t,alreadyTranscribed:e.transcribed===true};const r=e.fileName?resolveMediaFactKind(e)??e.kind:e.kind;${KIND_ANCHOR}if(e.fileName)n.fileName=e.fileName;return n}).filter(e=>Boolean(e.path??e.url))}`,
  "export{normalizeAttachments as i};",
  "",
].join("\n");

/** Evaluate normalizeAttachments from patched text with the two upstream helpers stubbed (explicit kind wins, as upstream). */
function loadNormalizer(source = patchSource(FIXTURE)) {
  const body = source.replace(/^\/\/.*$/gm, "").replace(/export\{[^}]*\};?/, "");
  const normalizeMediaFacts = (m) => (Array.isArray(m) ? m : []);
  const resolveMediaFactKind = (f) => (f.kind && f.kind !== "unknown" ? f.kind : f.contentType?.startsWith("audio/") ? "audio" : undefined);
  // eslint-disable-next-line no-new-func
  return new Function("normalizeMediaFacts", "resolveMediaFactKind", `${body}\nreturn normalizeAttachments;`)(normalizeMediaFacts, resolveMediaFactKind);
}
const kindOf = (ctx, fact) => loadNormalizer()({ ...ctx, media: [{ path: "/data/x", ...fact }] })[0]?.kind;
const WA = { Provider: "whatsapp", Surface: "whatsapp", OriginatingChannel: "whatsapp" };

test("patchSource: two exact edits, marker present, reversible byte-for-byte", () => {
  const patched = patchSource(FIXTURE);
  assert.ok(patched.includes(PATCH_MARKER));
  assert.ok(patched.includes("function normalizeAttachments(e){const bashtWa=bashtIsWhatsAppContext(e);return normalizeMediaFacts"));
  assert.ok(patched.includes("if(r)n.kind=bashtWa&&r===`document`&&bashtIsAudioDocument("));
  assert.ok(patched.indexOf("function bashtIsAudioDocument") < patched.indexOf("function normalizeAttachments"), "helpers precede normalizeAttachments");
  assert.equal(readOriginalFromPatched(patched), FIXTURE);
});

test("patchSource: refuses drift (missing / duplicated anchor, double application)", () => {
  assert.throws(() => patchSource(FIXTURE.replace(KIND_ANCHOR, "if(r)n.kind=r||void 0;")), /anchor not found \(attachment kind assignment\)/);
  assert.throws(() => patchSource(FIXTURE.replace("function normalizeAttachments(e){", "function normalizeAttachments2(e){")), /anchor not found \(normalizeAttachments declaration\)/);
  assert.throws(() => patchSource(FIXTURE + KIND_ANCHOR), /anchor not unique \(attachment kind assignment\)/);
  assert.throws(() => patchSource(patchSource(FIXTURE)), /already applied/);
});

test("classification (WhatsApp): audio documents become audio; every other document stays a document", () => {
  const wa = (fact) => kindOf(WA, fact);
  // the production failure
  assert.equal(wa({ kind: "document", contentType: "audio/mpeg", fileName: "a.mp3" }), "audio");
  assert.equal(wa({ kind: "document", contentType: "audio/mp4" }), "audio");
  assert.equal(wa({ kind: "document", contentType: "audio/wav" }), "audio");
  assert.equal(wa({ kind: "document", contentType: "AUDIO/MPEG; codecs=mp3" }), "audio", "case and parameters are normalised");
  assert.equal(wa({ kind: "document", contentType: "application/octet-stream", fileName: "note.M4A" }), "audio", "generic MIME + audio extension");
  assert.equal(wa({ kind: "document", path: "/data/ws/voice.opus" }), "audio", "no MIME, extension from the saved path");
  // must NOT change
  assert.equal(wa({ kind: "document", contentType: "application/pdf", fileName: "a.mp3" }), "document", "a real non-audio MIME wins over the file name");
  assert.equal(wa({ kind: "document", contentType: "application/octet-stream", fileName: "r.pdf" }), "document");
  assert.equal(wa({ kind: "document", contentType: "video/mp4", fileName: "v.mp4" }), "document", "video documents are untouched");
  assert.equal(wa({ kind: "document", contentType: "text/plain" }), "document");
  assert.equal(wa({ kind: "document", contentType: "application/octet-stream", fileName: "mp3", path: "/data/mp3" }), "document", "extension must be a real suffix");
  assert.equal(wa({ kind: "audio", contentType: "audio/ogg; codecs=opus" }), "audio", "voice notes unchanged");
  assert.equal(wa({ kind: "image", contentType: "image/png" }), "image", "an explicit non-document kind is never overridden");
});

test("SCOPE: other channels (browser live chat, Telegram, no channel) keep upstream behaviour byte-for-byte", () => {
  const doc = { kind: "document", contentType: "audio/mpeg", fileName: "a.mp3" };
  for (const ctx of [{}, { Provider: "webchat" }, { Provider: "control-ui", Surface: "webchat" }, { Provider: "telegram", OriginatingChannel: "telegram" }, { Provider: "whatsapp-business" }]) {
    assert.equal(kindOf(ctx, doc), "document", JSON.stringify(ctx));
  }
  for (const ctx of [{ Provider: "WhatsApp" }, { Surface: " whatsapp " }, { OriginatingChannel: "whatsapp" }]) {
    assert.equal(kindOf(ctx, doc), "audio", JSON.stringify(ctx) + " (any of the three channel fields, case-insensitive)");
  }
});

test("applyToPackage: refuses another OpenClaw version and an unexpected file hash; writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basht-audoc-"));
  try {
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "2026.11.1" }));
    fs.writeFileSync(path.join(dir, TARGET_FILE), FIXTURE);
    assert.throws(() => applyToPackage(dir, { log: {} }), /expected openclaw 2026\.11\.10, found 2026\.11\.1/);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: OPENCLAW_VERSION }));
    assert.throws(() => applyToPackage(dir, { log: {} }), /hash .* != expected/);
    assert.equal(fs.readFileSync(path.join(dir, TARGET_FILE), "utf8"), FIXTURE, "nothing written on refusal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- integration with the real OpenClaw dist
const PKG = process.env.OPENCLAW_PACKAGE_ROOT;
const integration = { skip: !PKG ? "set OPENCLAW_PACKAGE_ROOT to an installed openclaw@2026.11.10 to run" : false };

test("integration: installed target matches the pinned upstream hash (or the verified patched content)", integration, () => {
  const text = fs.readFileSync(path.join(PKG, TARGET_FILE), "utf8");
  if (text.includes(PATCH_MARKER)) assert.equal(sha256(readOriginalFromPatched(text)), ORIGINAL_SHA256);
  else assert.equal(sha256(text), ORIGINAL_SHA256);
});

test("integration: patched module links against real chunks and classifies correctly", integration, async () => {
  const original = fs.readFileSync(path.join(PKG, TARGET_FILE), "utf8");
  const source = original.includes(PATCH_MARKER) ? original : patchSource(original);
  const tmp = path.join(PKG, "dist", `.basht-audoc-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(tmp, source);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const norm = (provider, fact) => mod.i({ Provider: provider, media: [{ path: "/data/x", ...fact }] })[0];
    assert.equal(norm("whatsapp", { kind: "document", contentType: "audio/mpeg", fileName: "a.mp3" }).kind, "audio");
    assert.equal(mod.a(norm("whatsapp", { kind: "document", contentType: "audio/mpeg", fileName: "a.mp3" })), "audio", "resolveAttachmentKind agrees");
    assert.equal(mod.t(norm("whatsapp", { kind: "document", contentType: "audio/mp4", fileName: "a.m4a" })), true, "isAudioAttachment follows");
    assert.equal(norm("whatsapp", { kind: "document", contentType: "application/octet-stream", fileName: "v.mp3" }).kind, "audio");
    assert.equal(norm("whatsapp", { kind: "document", contentType: "application/pdf", fileName: "a.pdf" }).kind, "document");
    assert.equal(norm("whatsapp", { kind: "document", contentType: "video/mp4", fileName: "a.mp4" }).kind, "document");
    assert.equal(norm("webchat", { kind: "document", contentType: "audio/mpeg", fileName: "a.mp3" }).kind, "document", "browser live chat untouched");
    assert.equal(mod.t(norm("webchat", { kind: "document", contentType: "audio/mpeg", fileName: "a.mp3" })), false);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

const patchedPkg = PKG && fs.readFileSync(path.join(PKG, TARGET_FILE), "utf8").includes(PATCH_MARKER);
const e2e = { skip: !PKG ? integration.skip : !patchedPkg ? "apply the patch to OPENCLAW_PACKAGE_ROOT first (node patches/openclaw-audio-document-intake.mjs <root>)" : false };

test("e2e: real applyMediaUnderstanding sends a document-kind audio/mpeg to STT (CLI stub) and does not also render 'Unsupported document'", e2e, async () => {
  const dist = path.join(PKG, "dist");
  const applyFile = fs.readdirSync(dist).filter((f) => /^apply-.*\.mjs$/.test(f))
    .find((f) => fs.readFileSync(path.join(dist, f), "utf8").includes("async function applyMediaUnderstanding"));
  assert.ok(applyFile, "applyMediaUnderstanding module found");
  const { t: applyMediaUnderstanding } = await import(pathToFileURL(path.join(dist, applyFile)).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basht-audoc-e2e-"));
  const log = path.join(tmp, "stt.log");
  const stub = path.join(tmp, "stt.sh");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$1" >> "${log}"\nprintf 'transcript-from-stub\\n'\n`, { mode: 0o755 });
  const audio = path.join(tmp, "clip.mp3");
  fs.writeFileSync(audio, Buffer.alloc(4096, 1)); // not decoded by the stub; above the 1024-byte floor
  const cfg = { tools: { media: { audio: { enabled: true }, models: [{ type: "cli", command: stub, args: ["{{AttachmentPath}}"], timeoutSeconds: 20, capabilities: ["audio"] }] } } };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const run = async (kind, mime, fileName = "clip.mp3", provider = "whatsapp") => {
    const before = calls();
    const ctx = { Provider: provider, Surface: provider, Body: "<media:audio>", RawBody: "<media:audio>", CommandBody: "<media:audio>", MediaPath: audio, MediaType: mime,
      media: [{ path: audio, contentType: mime, kind, fileName }] };
    await applyMediaUnderstanding({ ctx, cfg, agentDir: tmp, workspaceDir: tmp });
    return { ctx, sttCalls: calls() - before };
  };
  try {
    const note = await run("audio", "audio/ogg; codecs=opus");
    assert.equal(note.sttCalls, 1, "control: voice note still transcribed");
    const doc = await run("document", "audio/mpeg");
    assert.equal(doc.sttCalls, 1, "audio/mpeg document reaches STT");
    assert.match(String(doc.ctx.Transcript), /transcript-from-stub/);
    assert.ok(!/Unsupported document format/.test(String(doc.ctx.Body)), "no duplicate 'Unsupported document format' block");
    const octet = await run("document", "application/octet-stream", "voice.mp3");
    assert.equal(octet.sttCalls, 1, "generic MIME + .mp3 reaches STT");
    const pdf = await run("document", "application/pdf", "a.pdf");
    assert.equal(pdf.sttCalls, 0, "a PDF never reaches STT");
    const video = await run("document", "video/mp4", "a.mp4");
    assert.equal(video.sttCalls, 0, "a video document never reaches STT");
    const web = await run("document", "audio/mpeg", "clip.mp3", "webchat");
    assert.equal(web.sttCalls, 0, "browser live chat is untouched: an audio document there still is not auto-transcribed");
    assert.match(String(web.ctx.Body), /Unsupported document format: audio\/mpeg/, "and keeps the upstream rendering");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
