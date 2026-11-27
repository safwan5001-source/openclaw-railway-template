# Audio sent as a WhatsApp document → speech-to-text (OpenClaw 2026.11.10)

## Symptom (production, 2026-11-27)
An `.mp3` sent through WhatsApp's attachment (paperclip) path reached the agent as

```
[Unsupported document format: audio/mpeg. ... Read the file yourself with your tools before answering]
```

and the gateway log had **no** `media-understanding` line for it. Ogg/Opus *voice notes* were transcribed normally
(`[Audio transcript (machine-generated, untrusted)]: "…"`).

## Cause (verified in the pinned packages)
* `@openclaw/whatsapp@2026.11.10` (`inbound/monitor`) marks anything sent as a document with `kind: "document"` and only
  corrects `document → image` (`savedContentType.startsWith("image/")`). There is no `document → audio` correction.
* In OpenClaw `dist/attachments.normalize-H6KPb1Ga.mjs`, `resolveMediaFactKind()` returns an explicit non-`unknown` kind
  before looking at the MIME type, and `resolveAttachmentKind()` maps `document` to `unknown`. The audio capability then
  selects nothing, so no STT request is made, and the document extractor renders the "Unsupported document format" block.

## Fix
`patches/openclaw-audio-document-intake.mjs` (build-time, exact-match, hash-pinned, same pattern as
`openclaw-memory-flush-owner.mjs`). In `normalizeAttachments()`, **only when the inbound context is WhatsApp**
(`Provider`, `Surface` or `OriginatingChannel` equals `whatsapp`, case-insensitive), a `document` is classified `audio` when

* its MIME starts with `audio/` (parameters ignored), or
* its MIME is absent / `application/octet-stream` / `binary/octet-stream` **and** its file name (or saved path / URL
  path) ends in `.mp3 .m4a .aac .wav .ogg .oga .opus .flac .amr .weba`.

Unchanged by design: PDFs and every other document, `video/*` documents, any explicit non-document kind, and **all other
channels including the browser Control UI / live chat** (a WhatsApp-only change; the live-chat path keeps upstream behaviour).
A transcribed attachment is passed to the extractor skip list, so it is not additionally rendered as "Unsupported document".

## Verification
* `node --test patches/openclaw-audio-document-intake.test.mjs`
  * pure tests: exact anchors, reversibility, drift refusal, WhatsApp-only scope, classification matrix;
  * integration against the real pinned dist (`OPENCLAW_PACKAGE_ROOT`);
  * e2e (patched package): the real `applyMediaUnderstanding` with a local CLI STT stub. Voice note and `audio/mpeg`
    document → 1 STT call; octet-stream + `.mp3` → 1; PDF / video document → 0; `Provider=webchat` audio document → 0
    and upstream rendering. The stub never reads or sends audio; nothing touches `/data`, Railway, WhatsApp or the network.
* CI: `basht-memory-security-ci.yml` applies the patch twice (idempotency) to the parity install before the tests;
  `openclaw-upgrade-inspect.yml` checks it against the published package.
* The existing `patches/*.test.mjs` suite passes unchanged on a patched package.

## Operational notes
* Not active until this branch is merged and Railway rebuilds the image. It does not change `openclaw.json`.
* Any OpenClaw bump must re-validate the anchors (the build fails closed on drift).
* Separate, config-level finding (not changed here): `tools.media.models` pins `gpt-4o-transcribe`, which OpenAI shuts
  down on 2027-02-26; its replacement is `gpt-transcribe`.
