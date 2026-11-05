---
name: basht-daftra
description: "BASHT accounting assistant for the Daftra tenant: read and search sales/purchase invoices, quotes, expenses, payments, clients, suppliers, products, statements and official reports; export PDF/XLSX/CSV/DOCX/JSON; prepare financial operations that execute only after explicit per-operation approval."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "requires": { "bins": ["node"], "env": ["DAFTRA_BASE_URL", "DAFTRA_API_KEY"] },
        "primaryEnv": "DAFTRA_API_KEY",
      },
  }
---

# BASHT × Daftra

All commands: `node {baseDir}/scripts/daftra-cli.mjs <command> ...` — one JSON document on stdout, `{"ok":false,"error":...}` on stderr (exit 1).
Run `capabilities` first if unsure what is installed. **Never claim an operation exists that `capabilities` does not list.**

## 1. Reading (no approval needed, GET only)

| Need | Command |
| --- | --- |
| Search / page through records | `list <entity> [--query k=v]... [--columns a,b]` (one page, **flagged incomplete**) |
| Every record, proven complete | `list <entity> --all [--query k=v]...` |
| One record | `get <entity> <id>` |
| Official Daftra report | `report <name> [--param k=v]...` |
| Client statement | `statement <client-id> --from YYYY-MM-DD --to YYYY-MM-DD` |

Entities: `invoices estimates clients suppliers products invoice_payments client_payments expenses purchase_invoices taxes treasuries`.
Reports: ledger, trial_balance, income_statement, balance_sheet, tax_summary/tax_details/tax_declaration, revenue, payments, expenses_summary/expenses_details, cash_flow, chart_of_accounts, … (`capabilities` lists them all). `--query`/`--param` names are an allowlist taken from the official docs; unknown names are rejected.

**Completeness rule.** Only call something a "full report" or total when the JSON says `"complete": true`. A single page (`list` without `--all`) is a sample. If `--all` fails with "Export blocked", tell the user why; never substitute partial data. Statements are computed locally, exclude opening balances/credit notes, and say `official:false` — when `reconciles:false` do not quote the balance.

## 2. Files (PDF · XLSX · CSV · DOCX · JSON)

Files are written only inside the private `$OPENCLAW_WORKSPACE_DIR/exports/` folder (created automatically, mode 0600).

- **Official PDF first.** For an invoice always try `pdf <invoice-id> <name>.pdf` — this downloads Daftra's own PDF (`invoice_pdf_url`). Quotes, payments, expenses and reports have **no** official PDF in the API.
- `export <entity> --format csv|json|xlsx|docx|pdf --out <name>.<format> [--columns a,b] [--query k=v]...` — complete data only.
- `export-report <name> --format ... --out ... [--param k=v]...`, `export-statement <client-id> --from --to --format ... --out ...`.
- A `pdf` produced by `export*` is a **generated summary**, labelled "not an official Daftra document". Never present it as the official invoice or send it as a tax document. DOCX is for editable letters/summaries only.
- Passwords, tokens and hash-authenticated links (`*_url`) are stripped and cannot be exported. Never print or forward a Daftra PDF link.
- Deliver files only to the authorised user over the approved private channel. Do not claim a file was sent unless the channel tool confirmed it.

## 3. Financial operations — approval protocol (MANDATORY)

Supported: `sales_invoice`, `estimate`, `purchase_invoice`, `expense`, `invoice_payment`, `client_payment`. **Not supported: edit, delete, cancel, refund, e-invoice submission, creating clients/suppliers/products.** Say so; do not improvise another route.

1. `propose <type> --input '<json>' --actor <user>` (or `--input-file`). This is read-only: it validates clients/suppliers/products, **tax ids against the tenant's tax table**, API-key permission, duplicates already in Daftra, overpayment, and computes exact totals. Every invoice line needs an explicit `tax1` (a tax id, or `0` for no tax) and every document an explicit `date`. Documents default to **draft**; add `"finalize": true` only if the user explicitly asks to post it. Payments cannot be drafts.
2. Show the user the preview in their language: operation, party, date, lines, subtotal/tax/total, mode (draft/final), effects, warnings, any duplicates. State clearly that **nothing has been sent**.
3. If `status` is `BLOCKED`, explain the blocking items and stop. Never work around a block (do not edit stored proposals, do not pass `acknowledge_duplicates` unless the user has seen those exact duplicate ids and chosen to proceed).
4. Execute **only** when the user's own latest message contains the exact `approval_phrase` from the preview (`APPROVE prop_… <hash> DRAFT|FINAL`). "yes", "ok", "continue", or approval of a different operation does not count. Never copy the phrase into the command on your own, never run `execute` in the same turn as `propose`.
5. `execute <proposal-id> --phrase "<exact phrase>" --actor <user>` sends exactly the approved request, once. Proposals expire after 15 minutes and are single-use. Report the result faithfully, including `verification.matched:false`.
6. Outcomes: `submitted` ✔ · `rejected` (nothing created; fix and re-propose) · `ambiguous` (may or may not exist — **do not retry**; ask the user to check Daftra, then `resolve <id> --created true|false [--record-id N]`).
7. If `execute` answers `WRITES_DISABLED`, tell the user the operator must enable writes on the server (`DAFTRA_WRITES_ENABLED=1`). Never try to set it yourself or edit the environment.

Examples of `--input`:
- `sales_invoice`: `{"client_id":4,"date":"2025-03-01","items":[{"item":"Diesel","quantity":"1000","unit_price":"1.89","tax1":1}]}`
- `purchase_invoice`: `{"supplier_id":7,"date":"2025-03-01","items":[{"item":"Oil","quantity":"2","unit_price":"10","tax1":0}]}`
- `expense`: `{"amount":"88.50","date":"2025-03-01","description":"…"}`
- `invoice_payment`: `{"invoice_id":3,"amount":"115.00","payment_method":"cash","date":"2025-03-01"}`
- `client_payment`: `{"client_id":4,"amount":"500","payment_method":"bank","date":"2025-03-01"}`

## 4. Hard rules

- Never expose `DAFTRA_API_KEY`, the proposal/ledger contents beyond the preview, or Daftra document links. Do not echo environment variables.
- On 401/403 do not ask for broader key scopes or use an OAuth client secret; report that the key's role does not allow the entity.
- Amounts are exact decimal strings; never recompute them with floating point.
- Daftra's API-key roles are per entity, not per method — read access and write access are the same grant. Write safety therefore comes from this skill's approval protocol and the operator switch, not from Daftra roles.
- Do not modify Gateway, model, browser, or security settings, and do not delete data.

## 5. Operator notes

Environment (Railway): `DAFTRA_BASE_URL` (HTTPS `*.daftra.com` tenant root), `DAFTRA_API_KEY`; optional `OPENCLAW_WORKSPACE_DIR` (default `/data/workspace`), `DAFTRA_WRITES_ENABLED` (default off), `DAFTRA_MAX_WRITES_PER_HOUR` (default 20), `CHROMIUM_PATH`. The operation ledger lives in `$OPENCLAW_WORKSPACE_DIR/daftra-ledger/` (ids, hashes and states only — no amounts or secrets). Full contract: `docs/DAFTRA_INTEGRATION_CONTRACT.md`.
