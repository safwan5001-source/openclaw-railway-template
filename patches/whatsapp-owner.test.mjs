// Parity tests for patches/whatsapp-owner.mjs (the owner normaliser shared by owner-check.mjs and the doctor).
//   node --test patches/whatsapp-owner.test.mjs
// The parity test runs against the REAL OpenClaw rule — isConfiguredCommandOwner() from openclaw@2026.10.9 with the
// real @openclaw/whatsapp@2026.10.9 channel plugin registered in-process — when OPENCLAW_PACKAGE_ROOT points at an
// install that has @openclaw/whatsapp next to it. Synthetic numbers only; nothing is written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyOwnerEntry, normalizeWhatsAppSender, whatsAppOwnersFrom } from "./whatsapp-owner.mjs";

const OWNER = "+15550001234";      // synthetic
const D = OWNER.slice(1);
// [entry, is the synthetic OWNER per OpenClaw 2026.10.9]
const CORPUS = [
  [`whatsapp:${OWNER}`, true], [`whatsapp:${D}`, true], [OWNER, true], [D, true], ["WhatsApp:+15550001234", true],
  ["whatsapp:+1 555-000-1234", true], ["+1 (555) 000-1234", true], [`${D}@s.whatsapp.net`, true], [`${D}:7@s.whatsapp.net`, true],
  [`whatsapp:${D}@s.whatsapp.net`, true], [`${D}@c.us`, true], [`whatsapp:whatsapp:${OWNER}`, true], [`  whatsapp:${OWNER}  `, true],
  ["*", false], ["whatsapp:*", false], [`telegram:${D}`, false], [`e164:${OWNER}`, false], [`whatsapp:user:${D}`, false],
  [`${D}@g.us`, false], [`whatsapp:${D}@g.us`, false], [`${D}@newsletter`, false], [`${D}@example.com`, false],
  ["whatsapp:+19990001111", false], ["", false], ["whatsapp:", false], ["not-a-number", false], [`whatsapp:telegram:${D}`, false],
];

test("normaliser: corpus of owner entry forms", () => {
  for (const [entry, isOwner] of CORPUS) {
    const c = classifyOwnerEntry(entry);
    assert.equal(c.kind === "owner" && c.e164 === OWNER, isOwner, `${JSON.stringify(entry)} -> ${JSON.stringify(c)}`);
  }
  assert.equal(classifyOwnerEntry("*").kind, "wildcard");
  assert.equal(classifyOwnerEntry(`telegram:${D}`).kind, "other-channel");
  assert.equal(classifyOwnerEntry(`whatsapp:user:${D}`).kind, "unrecognised");
  assert.equal(classifyOwnerEntry(`${D}@lid`).form, "LID");
  assert.deepEqual(whatsAppOwnersFrom([`whatsapp:${D}`, OWNER, "*", `telegram:${D}`]), [OWNER], "de-duplicated, wildcard/other channels dropped");
  assert.equal(normalizeWhatsAppSender(`whatsapp:${D}`), OWNER);
});

const PKG = process.env.OPENCLAW_PACKAGE_ROOT;
const WA = PKG && path.join(PKG, "..", "@openclaw", "whatsapp", "dist", ".setup", "channel-D-6ZIq4y.mjs");
const real = { skip: !PKG ? "set OPENCLAW_PACKAGE_ROOT to an installed openclaw@2026.10.9" : !fs.existsSync(WA) ? "install @openclaw/whatsapp@2026.10.9 next to openclaw" : false };

test("parity: the shared normaliser decides exactly like OpenClaw's isConfiguredCommandOwner with the real WhatsApp plugin", real, async () => {
  const wa = await import(pathToFileURL(WA).href);
  assert.equal(wa.t?.id, "whatsapp", "real @openclaw/whatsapp channel plugin");
  const key = Symbol.for("openclaw.pluginRegistryState");
  const previous = globalThis[key];
  globalThis[key] = { activeRegistry: { channels: [{ plugin: wa.t }] }, activeVersion: Date.now() };
  try {
    const auth = await import(pathToFileURL(path.join(PKG, "dist/command-auth-BHrKDij6.mjs")).href);
    for (const [entry] of CORPUS) {
      const upstream = auth.t({ commands: { ownerAllowFrom: [entry] } }, { channel: "whatsapp", senderId: OWNER, accountId: "default" });
      const ours = whatsAppOwnersFrom([entry]).includes(OWNER);
      assert.equal(ours, upstream, `${JSON.stringify(entry)}: OpenClaw=${upstream} shared-normaliser=${ours}`);
    }
    // The sender side uses the same normalisation: a "+"-less configured owner matches the "+E164" sender and vice versa.
    for (const sender of [OWNER, D, `${D}@s.whatsapp.net`]) {
      assert.equal(auth.t({ commands: { ownerAllowFrom: [`whatsapp:${D}`] } }, { channel: "whatsapp", senderId: sender, accountId: "default" }), true, sender);
      assert.equal(normalizeWhatsAppSender(sender), OWNER, sender);
    }
  } finally {
    globalThis[key] = previous;
  }
});
