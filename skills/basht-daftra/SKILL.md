---
name: basht-daftra
description: "BASHT accounting assistant for the Daftra tenant: read/search invoices, quotes, expenses, payments, clients, suppliers, products and reports; export PDF/XLSX/CSV/DOCX/JSON; duplicate existing documents into new drafts; create/update products and categories; every write executes only after explicit per-operation human approval."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "requires": { "bins": ["node"], "env": ["DAFTRA_BASE_URL"] },
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
| Credit notes (read-only) | `list credit_notes --all --query client_id=48` or `list credit_notes --query no=00004`; `get credit_notes <internal-id>` |
| Official Daftra report | `report <name> [--param k=v]...` |
| Client statement | `statement <client-id> --from YYYY-MM-DD --to YYYY-MM-DD` |
| Invoice ↔ payment reconciliation | `reconcile-payments <client-id> --from YYYY-MM-DD --to YYYY-MM-DD` |

**Chat-ready output:** add `--render ar|en [--view summary|detail]` to `list`, `get`, `report` or `statement` and the CLI prints `{"ok":true,"markdown":"…","complete":…}` — relay `markdown` as-is (section 9). The same GETs run; nothing else changes. Writes, approvals and every other command refuse `--render`.

**WhatsApp replies:** when the user's message arrived over WhatsApp (the inbound envelope says the channel is WhatsApp), use `--render whatsapp [--lang ar|en] [--view summary|detail]` instead of `--render ar|en` (`--lang` = the language of the user's last message, default `ar`). The CLI prints `{"ok":true,"channel":"whatsapp","markdown":"…","preview":"…"}` — relay **`markdown`** unchanged as the reply (section 9, "WhatsApp"). `preview` only shows what the recipient will see; do not paste it.

Entities: `invoices estimates credit_notes clients suppliers products invoice_payments client_payments expenses incomes purchase_invoices product_categories taxes treasuries journals journal_accounts journal_cats`.

**Accounting reads (documented GETs).** Journal entries = `journals` (`list journals --all --query date_from=… --query date_to=…`, page size capped at the documented 100; `get journals <id>`). Chart of accounts = `list journal_accounts --all` (main accounts: `journal_cats`) or `report chart_of_accounts`. Ledger / trial balance / income statement / balance sheet = `report ledger|trial_balance|trial_nets|income_statement|balance_sheet`. **Bank accounts are `treasuries` rows with `type` 1 (bank) / 3 (cash)**; there is no separate bank endpoint. If `get treasuries <id>` fails server-side the answer falls back to the complete list and says `"source":"list_fallback"`.

**Not available in the Daftra API (do not invent a path; say so and use the substitute):** expense categories (use `report expenses_summary --param group_by=Category`), an official client/supplier account statement (`statement` is computed locally, `official:false`), "deposits" (use `journals` / `report ledger` / `treasuries`), "advances" (`list invoices --query type=19`, `report advance_payments`), "journal_entries" (= `journals`). `capabilities` prints this list under `not_available_in_daftra_api`.

**Report parameters (checked locally against the official pages before any request).** Date spellings differ per report (`date_from/date_to` vs `from_date/to_date`; the wrong one is mapped). Enumerations are case-insensitive and sent in the documented case (`expenses_summary --param group_by=category` → `Category`). `revenue` needs `report_type` (`invoice|period|client|staff|sales_person`) and its `group_by` must fit it (`client`/`staff`: omit; `period`: `daily|weekly|monthly|yearly|lastyear|lastmonth`; `invoice`: `daily|weekly|monthly|yearly|client|staff|sales_person`). `ledger` needs `date_from` or `date_to`. `date_selector`/`date_range_selector` cannot be combined with explicit dates. `branch_id`/`journals_branch_id` accept `all` or `-1`; `cost_center_id` accepts `-1`.

**What a failure means (read the `category` in the error, never guess from the number):** `forbidden` (403) is the ONLY status that means a missing permission/role/plugin/machine-access → owner action. `report_not_exposed` (404 on a report) = Daftra does not expose that report on this deployment (not a permission problem, not a bug). `validation` (400) = a parameter or size ceiling; Daftra's `validation_errors` is quoted. `invalid_page` = Daftra refused the pagination request (the reader already retries the first page bare once). `transient` (429/502/503/504) is retried; `upstream_error` (500) is a Daftra-side failure. `access-report [entity|report|entity:<name>|report:<name>]` runs ONE minimal GET per endpoint and prints the classified matrix plus the owner actions (read-only; changes nothing).

**Credit notes:** `credit_notes` uses the documented `CreditNote` model and accepts the official list filters; the visible credit-note number (`no`, e.g. `00004`) must first be resolved from a list response before using the internal record `id` with `get`. Access may be restricted by Daftra's API-key role; do not claim visibility until verified against the tenant. This is GET-only through Broker and does not enable credit-note issuance, edits, deletion or refund.
Reports: ledger, trial_balance, income_statement, balance_sheet, tax_summary/tax_details/tax_declaration, revenue, payments, expenses_summary/expenses_details, cash_flow, chart_of_accounts, … (`capabilities` lists them all). `--query`/`--param` names are an allowlist taken from the official docs; unknown names are rejected.

**Payment reconciliation (`reconcile-payments`, read-only, `official:false`).** The `invoice_payments` list can omit settlements Daftra applied to an invoice (seen with `client_credit`), so a page-complete list is **not** proof of accounting coverage. Sources, in order: (1) invoices of the period (complete, scope-checked); (2) the client's `invoice_payments` list (complete, no status/date filter); (3) each invoice's **detail** `GET invoices/<id>`, payments read from exactly these three paths — `data.Payment`, `data.InvoicePayment`, `data.Invoice.InvoicePayment` (all three count as ONE source "detail"; the evidence status of each path is in `docs/DAFTRA_INTEGRATION_CONTRACT.md` §6.1, which is the single reference); (4) `GET invoice_payments/<id>` only for payments not corroborated. Never read other paths or infer a payment from a total.

*Merging.* Payments are merged by their Daftra **id**. A payment repeated inside one source (list, or the detail, including across its paths) is counted once **only if every repeat is identical** in amount, invoice link, status, method and date — a field present in one copy but missing, empty or unparseable in another **is a difference** (missing values are compared, not skipped). Any difference is a conflict (`within_source: true`) and the payment is `unresolved`: no copy is counted, no merged value is offered, and the single GET (a separate source) can never cancel it, even if it matches one copy. Conflicts between sources (amount, invoice link, status, method) are shown and leave the payment and its invoice `unresolved`; nothing is chosen silently. A payment without a stable id is never matched by amount; equal amounts with different ids are different payments.

*Evidence.* `amount`, `status` and the invoice link each need two sources or the single GET; only `status` `1` counts as successful (`0`/cancelled/failed = not counted, anything else `unresolved`). If none of the three paths exists, the invoice is `unresolved` — a missing section or `summary_unpaid = 0` is never evidence. An invoice is `matched` only when `summary_paid` equals the sum of payments verified by id, or (unpaid invoice) the section exists, is empty and the list holds nothing for it (`evidence` says which); otherwise `mismatch`/`unresolved`. Dates are normalised strictly (ISO `YYYY-MM-DD` or `DD/MM/YYYY`, optional time); anything else, or a reading that disagrees with the list, is `unresolved`; list rows outside the requested client/period abort the run.

*Classification (`payment_method`).* Only `client_credit` (case-insensitive, exact) → `client_credit`, and the built-ins `cash`, `bank`, `cheque` → `cash_bank`, and only when ≥ 2 sources (or the single GET) supply the same method. Everything else — missing, a value seen in one source only, `credit`, `offline`, `bank_transfer`, tenant-defined names — is **`unclassified`** with `classification_reason`; it still counts as applied money (id/amount/status are proven separately) but is never guessed into cash/bank, and `classification_complete` is `false` (also false for any invoice that is not `matched`, and for the whole report while any payment is unresolved or has no id). `credit_source_unverified: true` marks every invoice with a `client_credit` payment (or a source claiming it): that is payment evidence only — the origin of the customer balance and its journal entry need independent proof (client statement / ledger); never call it accounting-correct.

*Reporting.* Keep `listing_complete` (all pages read) apart from `accounting_coverage` (`complete` only when every invoice is `matched`). Report `state_counts` (matched / mismatch / unresolved) and the `warnings`; amounts are exact decimals; it is not an official statement.

**Completeness rule.** Only call something a "full report" or total when the JSON says `"complete": true`. A single page (`list` without `--all`) is a sample. If `--all` fails with "Export blocked", tell the user why; never substitute partial data. Statements are computed locally, exclude opening balances/credit notes, and say `official:false` — when `reconciles:false` do not quote the balance.

## 2. Files (PDF · XLSX · CSV · DOCX · JSON)

Files are written only inside the private `$OPENCLAW_WORKSPACE_DIR/exports/` folder (created automatically, mode 0600).

- **Official PDF first.** For an invoice always try `pdf <invoice-id>` — this downloads Daftra's own PDF (`invoice_pdf_url`). Quotes, payments, expenses and reports have **no** official PDF in the API.
  - **Redirects (HTTP 301/302/303/307/308) are followed by the tool, never by you.** At most 3 hops; each hop must be HTTPS, DNS-named, default port, no embedded credentials, and on the tenant host, another `*.daftra.com` host, or an exact host the operator listed in `DAFTRA_PDF_REDIRECT_HOSTS`. Any other destination is refused *before* it is requested (`PDF redirect refused: untrusted destination host <host>`) — tell the operator that host if they want it allowed; do not work around it. **No hop ever carries the API key, `Authorization` or a cookie** (the document link authenticates itself). Error texts never include the link, path or hash.
  - **Drafts:** the tool attempts the official PDF for drafts too and returns `draft: true`. Whether Daftra serves a draft PDF is Daftra's decision (not documented either way); if it refuses (HTTP 403/404, HTML, login redirect) the error says the invoice is a draft — report that plainly and do **not** substitute a generated PDF as "official". A draft PDF is not a posted tax invoice: say so.
  - **Non-PDF answers are diagnosed, read-only.** The error reads `Response is not PDF [HTTP <status>, <media type>, <n> redirect(s), page=<login|invoice_view|error|empty|not_html|unknown>]`. The page class is derived in memory from the first 64 KiB and discarded: no HTML is stored and no link, path, hash, key or page text is ever returned or logged. The broker also logs one `invoice_pdf_not_pdf` line with the same four fields. `page=login` means Daftra wants a signed-in browser session for that document; report it and do not try to sign in.
  - **iPhone download:** the result has `download_path` (`/setup/exports/invoice-<id>-<random>.pdf`). It is a one-file link on the operator's gateway, served only after the existing `/setup` login, `application/pdf` inline (Safari viewer → Share → Save to Files). Give the user only that path on their own gateway domain; never a Daftra URL. Nothing else in `exports/` is downloadable this way.
- `export <entity> --format csv|json|xlsx|docx|pdf --out <name>.<format> [--columns a,b] [--query k=v]...` — complete data only.
- `export-report <name> --format ... --out ... [--param k=v]...`, `export-statement <client-id> --from --to --format ... --out ...`.
- A `pdf` produced by `export*` is a **generated summary**, labelled "not an official Daftra document". Never present it as the official invoice or send it as a tax document. DOCX is for editable letters/summaries only.
- Passwords, tokens and hash-authenticated links (`*_url`) are stripped and cannot be exported. Never print or forward a Daftra PDF link (it contains an access hash) or a redirect `Location`.
- Deliver files only to the authorised user over the approved private channel. Do not claim a file was sent unless the channel tool confirmed it.

## 3. Financial operations — approval protocol (MANDATORY)

Supported: `sales_invoice`, `estimate`, `purchase_invoice`, `expense`, `invoice_payment`, `client_payment`, plus catalog operations `product_create`, `product_update`, `category_create`, `category_update` (section 4), customer/supplier operations `client_create`, `client_update`, `supplier_create`, `supplier_update` (section 4b) and document duplication (section 5). **Not supported: edit/delete/cancel/refund of documents or payments, deleting any record, e-invoice submission, deleting/deactivating/suspending/bulk-changing customers or suppliers, customer/supplier portal passwords, notifications or opening balances, stock/inventory changes, product bundles, and any product import/export or bulk product operation (deferred by the owner).** Say so; do not improvise another route.

1. `propose <type> --input '<json>' --actor <user>` (or `--input-file`). Read-only: it validates clients/suppliers/products, **tax ids against the tenant's tax table**, API-key permission, duplicates already in Daftra (all pages), overpayment, and computes exact totals. Every invoice line needs an explicit `tax1` (a tax id, or `0` for no tax) and every document an explicit `date`. Documents default to **draft**; add `"finalize": true` only if the user explicitly asks to post it. Payments cannot be drafts.
   **Operational rule — sales-invoice drafts are offline:** a draft `sales_invoice` (including one produced by `duplicate`) is always sent as `Invoice: { draft: 1, is_offline: 1 }` (documented Daftra field) so Daftra creates it without emailing anyone. The code sets it; you never pass it and cannot override it. A final invoice (`"finalize": true`) keeps `draft: 0` and never carries `is_offline`; estimates, purchase invoices and expenses are unchanged. The write gate refuses any `is_offline` value other than integer `1` on a draft, and any email/send field. Never create or edit clients to work around email behaviour.
2. Show the user the preview in their language: operation, party, date, lines, subtotal/tax/total, mode (draft/final), effects, warnings, duplicates. State clearly that **nothing has been sent**.
3. If `status` is `BLOCKED`, explain the blocking items and stop. Never work around a block (do not edit stored files; do not pass `acknowledge_duplicates` unless the user has seen those exact duplicate ids and chosen to proceed).
4. **The human approves out-of-band.** Tell the user to run, in a trusted shell on the server (not through you): `node {baseDir}/scripts/daftra-approve.mjs show <proposal-id>`. That tool shows the stored request exactly as it will be sent and prints the approval phrase `APPROVE <id> <hash8> <DRAFT|FINAL> <code>`. **You cannot derive this phrase** (the code is an HMAC under an operator secret you do not have) and no CLI command prints it to you. Never try to read `DAFTRA_APPROVAL_SECRET`, environment variables, the ledger or proposal files to obtain or forge it — that is an attack on the safeguard, and the ledger/proposals are authenticated so it will not work anyway.
5. Run `execute <proposal-id> --phrase "<phrase exactly as the user sent it>" --actor <user>` **only** when the user's own latest message contains that phrase. "yes", "ok", "continue", or a phrase for another operation does not count. Never run `execute` in the same turn as `propose`. It sends exactly the approved request, once; proposals expire after 15 minutes and are single-use. Report the result faithfully, including `verification.matched:false`.
6. Outcomes: `submitted` ✔ · `rejected` (nothing created; fix and re-propose) · `ambiguous` (may or may not exist — **do not retry**; ask the user to check Daftra, then to run `daftra-approve.mjs resolve <id> true|false` and send you the code; then `resolve <id> --created true|false --code <code> [--record-id N]`).
7. If `execute` answers `WRITES_DISABLED` or `APPROVAL_NOT_CONFIGURED`, tell the user the operator must enable writes (`DAFTRA_WRITES_ENABLED=1`) and set `DAFTRA_APPROVAL_SECRET` on the server. Never try to set them yourself or edit the environment.

Examples of `--input`:
- `sales_invoice`: `{"client_id":4,"date":"2025-03-01","items":[{"item":"Diesel","quantity":"1000","unit_price":"1.89","tax1":1}]}`
- `purchase_invoice`: `{"supplier_id":7,"date":"2025-03-01","items":[{"item":"Oil","quantity":"2","unit_price":"10","tax1":0}]}`
- `expense`: `{"amount":"88.50","date":"2025-03-01","description":"…"}`
- `invoice_payment`: `{"invoice_id":3,"amount":"115.00","payment_method":"cash","date":"2025-03-01"}`
- `client_payment`: `{"client_id":4,"amount":"500","payment_method":"bank","date":"2025-03-01"}`

## 4. Products and categories

Read/search (no approval): `list products --query keywords=<text>` (also `category`, `supplier_id`, `brand_id`, `status`, `barcode`, `product_code`; add `--all` for a complete list), `get products <id>`, `list product_categories`. Product links/images are stripped from output.

Writes use the same `propose` → human approval → `execute` protocol:
- `propose product_create --input '{"name":"…","unit_price":"2.18","tax1":1,"barcode":"…","product_code":"…","categories_id":[12],"status":0}'` — `name`, `unit_price` and an **explicit** `tax1` are required (otherwise Daftra silently applies the account default tax).
- `propose product_update --input '{"product_id":9,"changes":{"unit_price":"21.5"}}'` — partial update: only fields that really change are sent; the preview shows `current => new` for each and a **PRICE CHANGE** line with the percentage. A product edited in Daftra after the preview is blocked at approval time.
- `propose category_create --input '{"name":"…","parent_id":0}'`, `propose category_update --input '{"category_id":12,"changes":{"name":"…"}}'`.
- Writable product fields (documented): `name type(1 product|2 service) product_code barcode(≥5 chars, unique) description notes unit_price buy_price minimum_price profit_margin discount discount_type tax1 tax2 supplier_id categories_id tags status availabe_online duration_minutes`. Category fields: `name parent_id description display_order`.
- **Refused on purpose:** stock fields (`track_stock`, `tracking_type`, `initial_stock_level`, `store_id`, `low_stock_thershold`), bundles (`type 3`, `ProductBundle`), `brand` and `category` by name (they auto-create records), unit, deleting, bulk operations. Never claim stock can be changed.
- Checks run before any approval: tax ids exist and are active, supplier/category/parent exist, duplicate barcode/code/name, price 0 needs `allow_zero_price:true`.
- **Duplicate guard** (products and categories): the complete list is read with **no search filters** (Daftra's `keywords` filter on products fails with "Invalid page") and barcode / product code / name (or category name + parent) are compared locally. If the list cannot be proven complete, or the API fails, the proposal is `BLOCKED` (fail closed) — never override that with `acknowledge_duplicates`; report it to the operator.

## 4b. Customers and suppliers

Read/search (no approval): `list clients|suppliers --query keywords=<text>` (add `--all` for the complete book), `get clients <id>`, `get suppliers <id>`. Passwords and links are stripped from output.

Writes use the same `propose` → human approval → `execute` protocol:
- `propose client_create --input '{"business_name":"…","email":"…","phone1":"…","country_code":"SA","bn1":"<VAT number>","bn1_label":"VAT number","type":3}'`; `propose supplier_create` (needs `email` or `"is_offline":1`).
- `propose client_update --input '{"client_id":4,"changes":{"email":"…"}}'` — only fields that really change are sent (documented partial update). `propose supplier_update --input '{"supplier_id":7,"changes":{…}}'` — Daftra does not document partial supplier updates, so the **full current record** is sent with the changes (to avoid blanking anything) and a read-back reports any carried field that changed. Say this to the user.
- Fields: names, `email`, `phone1/2`, addresses (+ secondary), `country_code` (ISO alpha-2), `default_currency_code`, `language_code`, `notes`, `bn1/bn1_label/bn2/bn2_label` (tax/VAT number), and for customers also `type 2|3`, `national_id`, `category/category_id`, `group_price_id`, `credit_limit`, `credit_period`, `birth_date`, `gender`, `link`. Credit-terms, e-mail, tax-number, name and currency changes are shown as **KEY FIELD CHANGE**.
- **Refused on purpose:** `password`/`confirm_password` (portal login), `send_notify` (e-mails the party), `starting_balance` (creates an accounting entry), `suspend`, attachments, custom/extended data, branch, numbering, deleting/deactivating, bulk operations. Empty values never clear a field (rejected).
- **Duplicate guard** (Daftra enforces unique e-mail only): all records are compared by normalised tax number, e-mail, phone digits and name; a match blocks the proposal and names the reason. The whole book is read without filters; if it cannot be read completely the proposal is blocked (no keyword-search fallback). Only re-propose with `acknowledge_duplicates:["clients#12"]` if the user has seen that exact record and still wants a new one. A record edited in Daftra after the preview is blocked at approval time.
- Free text is validated: control characters, newlines and bidi-override characters are rejected (they can disguise the approval preview).
- Supplier statements are **not** implemented (the purchase-invoice list exposes no totals). For supplier balances use the **official** `report ledger --param journal_account_id=<id>` / `trial_balance`; never present anything computed locally as an official statement.

## 5. Duplicating a document

Daftra documents **no** copy endpoint, so a duplicate is: read the source (GET) → a normal create proposal. `duplicate <invoices|estimates|purchase_invoices> <document-id> --input '{"date":"2025-03-01", …}'`.
- `date` is mandatory (a copy never inherits the original date). Optional overrides: `client_id`/`supplier_id`, `currency_code`, `notes`, `finalize`, `line_overrides` (`{"1":{"unit_price":"2.5"}}`, 1-based), `remove_lines`, `add_lines`, `accept_total_difference`, `acknowledge_duplicates`.
- Copied: party, currency, notes, lines (item, description, quantity, price, discount, taxes, product). **Never copied:** id, number, payments/receipts, paid/unpaid/settlement, e-invoice (ZATCA) state, created/issue timestamps, links, source links. Daftra assigns the new id/number.
- The preview (and the operator tool) show **original vs proposed**, header and line by line, plus what was not copied. Taxes/products/clients are re-validated; a source header discount/shipping/deposit that a copy cannot reproduce blocks the proposal until the user accepts the difference. Purchase-line tax values are mapped to a tax id only when exactly one active tax matches.
- **Source vs. other duplicates:** the source document is verified from the document Daftra returns (its own `id` must equal the requested id) and is the only record ignored by the remote duplicate scan, and only for this explicit `duplicate` command. Any OTHER matching document still blocks. A normal `propose sales_invoice` never ignores anything. The exemption lives in the signed proposal (`duplicate_of` + `source_fingerprint`); at execution the source is re-read and a changed, deleted or unreadable source blocks the approval (`RECHECK_FAILED`). Every duplicate preview warns that approving and executing **creates a new financial document**.
- Drafts first (all three document types support draft). Copying with the original date/client/total is flagged as a likely duplicate of the original.

## 6. Privilege separation — SERVICE MODE (recommended) and local broker

**Service mode** (`DAFTRA_BROKER_URL` + `DAFTRA_BROKER_TOKEN` set): the agent holds **no Daftra credential at all** (Daftra API-key roles are per *entity*, not per method, so any key that can read can also write). Every read (`list`, `get`, `report`, `statement`, exports, `pdf`) goes through the separate broker service (GET-only, allowlisted); `propose`, `duplicate`, `show` and `status <proposal-id>` also go to the broker. **There is no `execute` or `resolve` for you**: the operator approves in the broker's console from their own device (password + a fresh authenticator code per approval). After proposing, show the preview, tell the user to open the operator console and review/approve there, and poll `status <proposal-id>`; never try to obtain, derive or relay approvals. If `capabilities` reports `daftra_credentials_on_agent: true` or lists `env_warnings`, tell the operator to remove those variables.

**Local broker mode** (`DAFTRA_BROKER_SOCKET`): `propose`, `duplicate`, `show`, `execute`, `resolve` are forwarded to a privileged local process (different OS user); you still cannot derive the phrase (section 3). See `docs/DAFTRA_BROKER.md`.

Deployment (owner only, nothing deployed yet): `docs/DAFTRA_RAILWAY_ROLLOUT.md`.

## 7. Hard rules

- Never expose `DAFTRA_API_KEY`, the proposal/ledger contents beyond the preview, or Daftra document links. Do not echo environment variables.
- On 401/403 do not ask for broader key scopes or use an OAuth client secret; report that the key's role does not allow the entity.
- Amounts are exact decimal strings; never recompute them with floating point.
- Daftra's API-key roles are per entity, not per method — read access and write access are the same grant. Write safety therefore comes from this skill's approval protocol and the operator switch, not from Daftra roles.
- Do not modify Gateway, model, browser, or security settings, and do not delete data.

## 8. Operator notes

Environment (Railway): `DAFTRA_BASE_URL` (HTTPS `*.daftra.com` tenant root; the only variable the skill gating requires, because in service mode the agent holds no key), `DAFTRA_API_KEY` (single-process mode only — avoid in production); optional `OPENCLAW_WORKSPACE_DIR` (default `/data/workspace`), `DAFTRA_WRITES_ENABLED` (default off), `DAFTRA_APPROVAL_SECRET` (≥32 random chars; required for any financial operation; keep it out of the agent's exec environment where possible), `DAFTRA_MAX_WRITES_PER_HOUR` (default 20), `CHROMIUM_PATH`; service mode: agent env = only `DAFTRA_BASE_URL`, `DAFTRA_BROKER_URL`, `DAFTRA_BROKER_TOKEN`; the broker service holds `DAFTRA_WRITE_API_KEY`, `DAFTRA_APPROVAL_SECRET`, `BROKER_AGENT_TOKEN`, `OPERATOR_PASSWORD`, `OPERATOR_TOTP_SEED` (see the notes doc). Local broker mode: `DAFTRA_BROKER_SOCKET` (agent side), `DAFTRA_APPROVAL_SECRET_FILE` and `DAFTRA_WRITE_API_KEY_FILE` (broker side only). The operation ledger lives in `$OPENCLAW_WORKSPACE_DIR/daftra-ledger/` (ids, hashes and states only — no amounts or secrets; HMAC-chained, tampering stops all writes). Full contract: `docs/DAFTRA_INTEGRATION_CONTRACT.md`.

## 9. Presenting results to the user (PERMANENT RULE — Daftra answers in chat)

Formatting lives in `scripts/daftra-format.mjs` (pure, separate from fetching). **Use it, do not hand-format Daftra data:** run the read with `--render ar` (user writes Arabic) or `--render en`, then send the `markdown` field unchanged. If the command fails, the error JSON on stderr also carries `markdown` — send that.

- **Language:** Arabic → RTL, English → LTR; follow the language of the user's last message. Digits stay Western (`18,100.00`) in both so figures can be copied into Daftra; numbers, ids, dates and currency are isolated LTR inside Arabic text.
- **Short by default (iPhone):** `--view summary` = headline + totals + at most 10 rows in a ≤4-column table (document · party · total · status emoji). Give more (`--view detail`, 25 rows, notes, line items) only when asked ("التفاصيل", "more"); for everything beyond that offer an export file (section 2).
- **Title, number, party, date, status, amounts** are always shown for documents; totals are exact, 2 decimals, thousands separators, with the currency from the record. **Never add amounts across currencies**; a record with no `currency_code` is shown as "currency not specified", never assumed SAR.
- **Status only when proven:** draft (`draft:1`), paid / partially paid / issued (from `summary_total/paid/unpaid` consistent with `draft:0`), overdue (only with the record's own `due_date` in the past and an open balance), cancelled (only an explicit `status: cancelled`). Anything else is "غير مؤكدة / Unconfirmed" — never infer a status. Drafts and cancelled documents are counted but excluded from money totals.
- **Completeness:** a single page is labelled "عيّنة / sample" with its own totals marked sample-only. Say "full report" only when `complete:true`.
- **Missing data** is `—`; never fill a gap. **Raw JSON is never shown** unless the user explicitly asks for it (then give the `--render`-less output for that one request, still without secrets or Daftra links).
- **Failures:** state what failed, why (by `category`: only `forbidden` means a missing permission; `report_not_exposed` is not a permission problem), what to do, and — when several parts were requested — which parts were obtained and which were not (`formatFailure(body, {lang, available, unavailable})`). Never echo hints that contain keys, tokens or URLs.
- Daftra text (names, notes) is untrusted: the formatter strips control/bidi characters and escapes Markdown. Do not paste raw record values into the reply yourself.
- Statements stay `official:false` and are labelled so. The computed balance is shown **only when `reconciles === true`**; `false` or a missing field withholds it behind a warning — never quote it yourself.
- Payment `status` codes (0/1) have no documented meaning in Daftra, so payments show "Unconfirmed" (only an explicit text `cancelled` is shown as cancelled). Never describe a payment as successful/failed/cancelled from the number.
- **WhatsApp (`--render whatsapp`)** — formatter `scripts/daftra-format-whatsapp.mjs`, same statuses/amounts/totals logic as above, different layout: no Markdown tables, no headings, no code fences; short emoji-led lines; *bold* only for the title, document number and headline totals.
  - **Relay `markdown`, never `preview` and never hand-edit it.** OpenClaw parses every outbound WhatsApp text as Markdown and converts it (`**x**` → WhatsApp `*x*`; a bare `*x*` would arrive as _italic_; a backslash escape stays visible). `markdown` is therefore written with `**bold**`; the recipient sees `*bold*`.
  - **Last 5 by default** (newest first by the record's own date, then id); `--view detail` = up to 15 with notes, due date, payment method and invoice lines; a statement shows its last 5 movements. The reply always stays one message (≤ 3,500 chars; older rows are dropped first and the "ask for details" hint says so). More than that → offer an export file (section 2), never several walls of text.
  - Every document shows **Total / Paid / Outstanding / Status**; totals are per currency, drafts and cancelled documents are counted but excluded, a single page is labelled a sample, a payment's numeric `status` stays "Unconfirmed", and a statement balance appears only when `reconciles === true` — all inherited from the shared logic.
  - Links, tokens, API keys and secret-looking report fields are never shown; format characters in Daftra text (asterisk, underscore, tilde, backtick, backslash, brackets) are replaced by look-alikes so a client name cannot bold, strike, quote or link anything. Failures use the same category-based explanation (`formatWhatsAppFailure`; the error JSON on stderr also carries `markdown`/`preview`).
  - Delivery is OpenClaw's job (reply on the same chat). This script never sends a message; if WhatsApp is not linked/enabled there is nothing to format for — answer in the channel you are on with `--render ar|en`. Setup requirements: `docs/DAFTRA_WHATSAPP.md`.
- Presentation only: this layer never calls Daftra, never changes API access, roles, writes or the approval protocol (sections 3 and 6 are unchanged).

