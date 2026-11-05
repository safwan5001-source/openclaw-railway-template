# BASHT × Daftra — Integration Contract v2

Status: **IMPLEMENTED & UNIT-TESTED AGAINST A FAKE — NOT LIVE-TESTED, NOT DEPLOYED.**
Code: `skills/basht-daftra/` (self-contained OpenClaw skill: `SKILL.md` + `scripts/`). Zero runtime npm dependencies.

## 1. Verified API facts (official docs, https://docs.daftara.dev)

| Fact | Source page |
| --- | --- |
| Auth header `APIKEY` (API-key roles are **per entity, not per method**; 403 when blocked). Docs flag `apikey` as deprecated in favour of an OAuth Bearer token; this skill keeps `APIKEY` and never uses an OAuth client secret. | 933385m0, 15115241e0 |
| List: `GET /api2/<resource>.json` → `{code,result,data:[{<Model>:{…}}],pagination}` | 15115241e0 and siblings |
| **Pagination = `{prev,next,page,page_count,total_results}`; `total_results` counts ALL pages.** Default 20/page, `limit` has no server maximum. | every list page |
| Model keys: `Invoice Estimate Client Supplier Product InvoicePayment ClientPayment Expense Tax Treasury`; purchase invoices use **`PurchaseOrder`** (not `PurchaseInvoice`). | 15115351e0 |
| Single: `GET /api2/<resource>/<id>.json` → `{data:{<Model>:{…}}}` (invoices endpoint returns standard invoices only). | 15115238e0 |
| Official PDF exists **only for invoices**: `invoice_pdf_url` (hash-authenticated, same tenant). No official PDF for estimates, payments, expenses or reports. | 15115238e0 |
| Reports: `GET /api2/reports/<name>` (**no `.json`**), 26 reports, JSON only. Single response, HTTP 400 above size ceilings instead of truncating — **except `financial_transactions`, which is paged (300 rows/page, `pagination {page,per_page,total_rows,total_pages}`, per-page totals).** | 46396925e0 … 46527358e0 |
| Invoice list rows contain `password`, `invoice_html_url`, `invoice_pdf_url`: sensitive. | 15115241e0 |
| Write shapes: `Invoice`+`InvoiceItem[]` (draft = `Invoice.draft` 0/1), estimates same shape, `PurchaseOrder`+`PurchaseOrderItem[]` (`?send=draft`), `Expense` (`?send=draft` **and** `status:"draft"`; real idempotency via `unique_id`), `InvoicePayment`, `ClientPayment`. Success = HTTP 202 + `id`. | 15115242e0, 15115247e0, 15115352e0, 40881052e0, 15115307e0, 15115312e0 |
| Invoice `unique_id` is *not* idempotency (server recalculates offers/discounts when present) → never sent for invoices. Payments have no idempotency key. | 15115242e0 |
| Omitting `tax1` makes Daftra inherit the product's tax → every line must send `tax1` explicitly (`0` = no tax). | 15115242e0 |
| `GET /site_payment_gateway/list/1` (payment methods) is a v2 endpoint on **Bearer** auth → payment-method validity cannot be verified with an API key; Daftra rejects unknown methods. | 40952350e0 |

Tenant is pinned to `DAFTRA_BASE_URL` (HTTPS `*.daftra.com` root); redirects are never followed.

## 2. Operations matrix

| Business function | Implementation | Tests | Live-tested | Approval |
| --- | --- | --- | --- | --- |
| Read/search sales invoices, estimates, purchase invoices, expenses, invoice & client payments, clients, suppliers, products, taxes, treasuries | `list`, `get` (allowlisted entities + query params, GET only) | ✔ | ✘ | none |
| **Complete** collections | `list --all` → `fetchAllRecords` (page walk + proof) | ✔ | ✘ | none |
| Official reports (ledger, trial balance, income statement, balance sheet, tax, revenue, payments, expenses, cash flow, chart of accounts, …) | `report <name>`; `financial_transactions` auto-walks pages | ✔ | ✘ | none |
| Client statement | `statement` (local, reconciles against per-invoice `summary_unpaid`, `official:false`) | ✔ | ✘ | none |
| Supplier statement | **Not implemented**: purchase-invoice list exposes no totals/payments; use the `ledger` report with `journal_account_id` | — | — | — |
| Official invoice PDF | `pdf <invoice-id> <file>` | ✔ | ✘ | none |
| Exports PDF/XLSX/CSV/DOCX/JSON | `export`, `export-report`, `export-statement` | ✔ (opened with openpyxl / python-docx / LibreOffice / Chromium) | n/a | none |
| Create sales invoice · estimate · purchase invoice · expense · invoice payment · client payment | `propose` → `execute` (draft by default; payments are final) | ✔ (fake) | ✘ | **explicit, per operation** |
| Edit / delete / refund / e-invoice submission / create clients, suppliers, products | **Not implemented** (no PUT/PATCH/DELETE code exists) | — | — | — |

## 3. Pagination contract

- `extractList` marks a single response complete only if: `total_results === rows`, `page_count ≤ 1`, `page ≤ 1`, and `next` is empty. A client-supplied `complete` field is ignored. Non-integer / negative / boolean / empty-string metadata throws. (An empty collection may report `page_count: 0`.)
- `fetchAllRecords` additionally requires: pages arrive in order; `page_count`/`total_results` stay constant (else one restart, then block); every non-final page has `next`, the final one does not; ids unique across pages; rows collected `=== total_results`; limits `maxPages 500`, `maxRecords 50 000`. Anything unprovable **throws** — no partial result is ever labelled complete.
- 429/502/503/504 on GET are retried (Retry-After honoured, max 3). Writes are never retried.

## 4. Export contract

- Destination: only `$OPENCLAW_WORKSPACE_DIR/exports/` (auto-created 0700), file mode 0600, `wx` (never overwrite), safe file names, symlink-escape checks.
- PDF: **official Daftra PDF first** (`pdf`). Any `--format pdf` export is a generated summary labelled "not an official Daftra document" (EN + AR), rendered by headless Chromium from escaped HTML under a CSP, network blocked.
- XLSX: pure-Node writer; numeric columns are real numbers (negatives intact), IDs stay text (leading zeros kept), RTL sheet, `Info` sheet with provenance. DOCX: bordered RTL-aware table. CSV: UTF-8 BOM, always quoted. JSON: `schema_version`, `record_count`, metadata (`complete`, `official:false`, filters, timestamp).
- Spreadsheet injection: cells starting `= + - @`/control chars get an apostrophe, except strict numbers.
- Sensitive keys (`password`, `token`, `secret`, `apikey`, `hash`, `*_url`) are stripped; requesting one explicitly is refused.

## 5. Transaction safety (implemented in `daftra-proposal/write/ledger`)

1. **Preview** (`propose`, GET only): references exist, tax ids exist & active in the tenant tax table, exact decimal totals (tax-exclusive/inclusive), API-key role can read the entity, remote duplicates (same party/date/total), payment ≤ invoice `summary_unpaid`, invoice not draft, local ledger duplicate.
2. **Bound approval**: phrase `APPROVE <proposal-id> <hash8> <DRAFT|FINAL>`, bound to the SHA-256 of the exact request; 15-minute TTL; single use; stored request re-hashed (tamper → refuse).
3. **Operator kill switch**: `DAFTRA_WRITES_ENABLED=1` must be set on the server (default off).
4. **Route allowlist**: six POST endpoints (`?send=draft` only query). PUT/PATCH/DELETE do not exist in the code.
5. **Pre-submit re-check**: balance/duplicates/permissions re-read immediately before sending.
6. **No blind retry**: one attempt. Network error / 5xx / success-without-id ⇒ `ambiguous`; the identical request is blocked until a human runs `resolve`. 4xx ⇒ `rejected` (nothing created, may re-propose).
7. **Idempotency**: expenses carry a deterministic `unique_id`; for the others the ledger + duplicate scan is the protection.
8. **Rate limit**: `DAFTRA_MAX_WRITES_PER_HOUR` (default 20).
9. **Read-back**: after creation the record is re-read and the total compared with the approved total; mismatch is reported.
10. **Ledger** `daftra-ledger/ledger.jsonl` (0600): ts, state, proposal id, type, request hash, endpoint, actor, record id, HTTP status. No amounts, names or secrets.

**Known limit:** the approval phrase proves the agent was given the phrase, not that a human typed it. The hard out-of-band control is the operator's `DAFTRA_WRITES_ENABLED` switch; keep it off except for supervised sessions.

## 6. Not verified / needs the real tenant

Live JSON shapes of each endpoint and report; whether the API key's role allows each entity; real `invoice_pdf_url` download; ZATCA/e-invoice side effects of final invoices; open/closed financial periods; tenant payment-method names; tax inclusive/exclusive rounding vs Daftra's own (the read-back catches differences); PDF Arabic fonts and Chromium inside the Railway image; delivery on iPhone.

## 7. Acceptance gates before any production use

1. Read-only smoke test on the tenant: `capabilities`, `list invoices --all`, `get`, `report trial_balance`, `pdf <id>` (compare with Daftra UI).
2. Draft-only write test on a **non-production tenant or a disposable draft**, with `DAFTRA_WRITES_ENABLED=1` set by the operator for that session only.
3. Skill placement in the OpenClaw persistent workspace (`<workspace>/skills/basht-daftra`) — requires explicit deployment approval. The Docker image currently copies only `src/`.
4. Rollback: remove the skill directory; the ledger and exports live in the workspace volume and are untouched by a redeploy.
