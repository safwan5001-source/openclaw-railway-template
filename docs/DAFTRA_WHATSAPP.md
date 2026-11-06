# BASHT — Daftra answers over WhatsApp

`daftra-cli.mjs list|get|report|statement … --render whatsapp [--lang ar|en] [--view summary|detail]` returns a WhatsApp-sized answer
(`skills/basht-daftra/scripts/daftra-format-whatsapp.mjs`). It is presentation only: same GET requests, no Broker / Daftra API /
approval change, and **it never sends anything**. `--render ar|en` (Markdown with tables) is unchanged.

## What was checked (this repo + the pinned `openclaw@2026.10.9`)

| Question | Finding |
|---|---|
| Is WhatsApp configured in this template? | **No.** `src/server.js` `/setup` configures only Telegram, Discord and Slack (`channels.<name>` via `openclaw config set --json`); pairing approval accepts only `telegram` / `discord`. No WhatsApp variable, env, doc or test exists. |
| Is the WhatsApp plugin in the image? | **No.** It is an external package (`@openclaw/whatsapp`, not bundled in the core `openclaw` npm package). `Dockerfile` installs only `openclaw@2026.10.9`. |
| How does OpenClaw send text on WhatsApp? | Through the gateway-owned WhatsApp Web (Baileys) session; outbound sends fail fast when no linked, listening account exists. Every text goes through `markdownToWhatsAppChunks` (limit `channels.whatsapp.textChunkLimit`, default 4000). |
| What does the converter do? | Markdown → IR → WhatsApp markers: `**x**` → `*x*`, `*x*` → `_x_`, `~~x~~` → `~x~`; tables default to `bullets` (no table is ever shown); `\*` keeps the backslash. |

Consequences for the formatter: the relayed text uses `**bold**` (recipient sees `*bold*`; `preview` shows exactly that), contains no table
syntax, and never backslash-escapes Daftra text (format characters become look-alikes instead).

## Requirements to make it work end to end (none are done by this change)

1. **Install and link WhatsApp** — operator action on the Railway OpenClaw service: `openclaw plugins install @openclaw/whatsapp`, then
   `openclaw channels login --channel whatsapp` (QR, scanned from the phone to link); the WhatsApp auth directory must live on the persistent `/data` volume or the link is lost on redeploy. A dedicated number is recommended.
2. **Access policy** — `channels.whatsapp.dmPolicy` (`pairing` or `allowlist` with `allowFrom: ["+<owner number>"]`); approve the first sender with
   `openclaw pairing approve whatsapp <CODE>`. Note the `/setup` page does not yet offer WhatsApp pairing (`telegram`/`discord` only) — use the CLI/console.
3. **Skill rule** — redeploy so the agent reads the updated `SKILL.md`; it chooses `--render whatsapp` when the inbound message came from WhatsApp.
4. **Defaults are fine** — `channels.whatsapp.markdown.tables` = `bullets` and `textChunkLimit` = 4000 already exceed what the formatter emits (≤ 3,500 chars, no tables).
5. **Approvals are unchanged**: Daftra writes still need the operator console + TOTP; nothing approved or proposed travels over WhatsApp.

## Not covered

No WhatsApp message is sent by the formatter or by any test (a test guards against network calls and against sender/I/O code in the module).
Live verification on a real linked number is a manual step after the requirements above.
