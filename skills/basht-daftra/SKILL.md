---
name: basht-daftra
description: Read Daftra invoice data and obtain the original official invoice PDF. Initial scope is strictly read-only.
---
# BASHT × Daftra — pilot skill

Use only when the user explicitly requests Daftra invoice lookup or the **original Daftra PDF**. First verify the API key's allowed paths and never expose API credentials or private PDF URLs to third parties.

## Usage
Run from the repository root after the client has been deployed and made available to the agent:
- `node src/daftra-readonly.mjs list` — read invoice list.
- `node src/daftra-readonly.mjs get 123` — get one invoice.
- `node src/daftra-readonly.mjs pdf 123 /data/workspace/invoice-123.pdf` — download the official PDF to a new file.

The filename must be in the agent's private workspace, never a public webroot. Do not print, log, or relay raw PDF URLs because they may contain access hashes. The PDF may include sensitive customer information: transmit it only through an approved private channel to the authorized user.

## Mandatory controls
1. This release permits GET only. Never infer permission to create invoices, estimates, expenses, or payments from the presence of an API key. Financial writes require a separate audited implementation and explicit approval for each transaction.
2. The Daftra host is pinned to the HTTPS tenant in `DAFTRA_BASE_URL`; no arbitrary domains, redirects, or external PDF URLs.
3. If fetching fails due to 401/403, do not broaden the API key scopes or retry with OAuth Client Secret.
4. If PDF delivery fails, report the error; do not invent a PDF or claim it was generated.
5. Production installation requires a review of the runtime workspace, a deploy approval, and a real read-only smoke test; this GitHub file by itself is **not** an installed OpenClaw skill.

## Environment
`DAFTRA_BASE_URL` and `DAFTRA_API_KEY` are supplied by Railway. Use the APIKEY header per official Daftra guidance: https://docs.daftra.com/tutorial/api/. Never commit real values.

## Rollout checklist
- [ ] Verify key was rotated if leaked, and its roles explicitly allow required GET paths.
- [ ] Validate GET /api2/invoices.json and GET /api2/invoices/{id}.json with a genuine tenant (no writes).
- [ ] Verify invoice_pdf_url exists and responds with an authentic PDF.
- [ ] Confirm secure delivery on iPhone and file cleanup / retention policy.
- [ ] Confirm skill placement in actual OpenClaw workspace. The repository is a Railway wrapper and does not automatically load `skills/` on the persistent volume.
