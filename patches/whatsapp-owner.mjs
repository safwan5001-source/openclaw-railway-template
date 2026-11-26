// Shared, side-effect-free mirror of how OpenClaw 2026.11.10 turns a commands.ownerAllowFrom entry into a WhatsApp owner.
// Used by owner-check.mjs and memory-flush-doctor.mjs so the two diagnostics can never disagree about who the owner is.
//
// Upstream path (verified against the real dist + @openclaw/whatsapp@2026.11.10, see whatsapp-owner.test.mjs):
//   isConfiguredCommandOwner()                    command-auth-Ch_q0NQN.mjs
//     resolveOwnerAllowFromList()                       drops other-channel prefixes, strips ONE "whatsapp:" prefix,
//                                                       drops "<channel>:user:<id>" for WhatsApp
//     plugin.config.formatAllowFrom()             @openclaw/whatsapp normalizeWhatsAppAllowFromEntries
//       normalizeWhatsAppTarget()                 strips repeated "whatsapp:", accepts user JIDs (@s.whatsapp.net,
//                                                 @c.us, @lid), rejects groups/newsletters/other "@" and other prefixes,
//       normalizeE164()                           then keeps DIGITS ONLY ("+" optional, spaces/dashes ignored)
//     stripWildcardAllowFrom()                    "*" never counts
//   The sender (senderE164 first: preferSenderE164ForCommands) goes through the same normalizer, so
//   "whatsapp:9665…", "9665…", "+966 5…" and "9665…@s.whatsapp.net" all match the sender "+9665…".

const CHANNEL_PREFIX_RE = /^([a-z][a-z0-9-]*):/i;
const USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const LEGACY_USER_JID_RE = /^(\d+)@c\.us$/i;
const LID_RE = /^(\d+)@lid$/i;

/**
 * Classify one raw ownerAllowFrom entry for the WhatsApp channel.
 *   { kind: "owner", e164, form }  OpenClaw accepts it as a WhatsApp owner identity (e164 is "+<digits>")
 *   { kind: "wildcard" }           "*": stripped by OpenClaw, never an owner
 *   { kind: "other-channel" }      prefixed for another channel: ignored for WhatsApp
 *   { kind: "unrecognised" }       meant for WhatsApp (unprefixed or "whatsapp:") but OpenClaw cannot resolve it
 */
export function classifyOwnerEntry(raw) {
  const entry = String(raw ?? "").trim();
  if (!entry) return { kind: "unrecognised" };
  if (entry === "*") return { kind: "wildcard" };
  const prefix = CHANNEL_PREFIX_RE.exec(entry)?.[1];
  if (prefix && prefix.toLowerCase() !== "whatsapp") return { kind: "other-channel" };
  let candidate = entry;
  for (let before; before !== candidate;) { before = candidate; candidate = candidate.replace(/^whatsapp:/i, "").trim(); }
  if (!candidate || candidate === "*") return { kind: candidate ? "wildcard" : "unrecognised" };
  if (/@g\.us$/i.test(candidate) || /@newsletter$/i.test(candidate)) return { kind: "unrecognised" };
  const jid = USER_JID_RE.exec(candidate) ?? LEGACY_USER_JID_RE.exec(candidate);
  const lid = LID_RE.exec(candidate);
  let digits;
  let form;
  if (jid) { digits = jid[1]; form = "PN-JID"; }
  else if (lid) { digits = lid[1]; form = "LID"; }
  else if (candidate.includes("@") || CHANNEL_PREFIX_RE.test(candidate)) return { kind: "unrecognised" };
  else { digits = candidate.replace(/\D/g, ""); form = "PN"; }
  return digits ? { kind: "owner", e164: `+${digits}`, form } : { kind: "unrecognised" };
}

/** Normalised (+digits) WhatsApp owners OpenClaw derives from commands.ownerAllowFrom, de-duplicated, in order. */
export function whatsAppOwnersFrom(ownerAllowFrom) {
  const list = Array.isArray(ownerAllowFrom) ? ownerAllowFrom : [];
  return [...new Set(list.map(classifyOwnerEntry).filter((c) => c.kind === "owner").map((c) => c.e164))];
}

/** A sender id / E.164 / JID as OpenClaw normalises it for the owner comparison ("+<digits>"), or undefined. */
export function normalizeWhatsAppSender(value) {
  const c = classifyOwnerEntry(value);
  return c.kind === "owner" ? c.e164 : undefined;
}
