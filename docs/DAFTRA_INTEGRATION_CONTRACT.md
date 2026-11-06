# BASHT × Daftra — Integration Contract v4

Status: **IMPLEMENTED & UNIT-TESTED AGAINST A FAKE — NOT LIVE-TESTED, NOT DEPLOYED.**
Code: `skills/basht-daftra/` (self-contained OpenClaw skill: `SKILL.md` + `scripts/`). Zero runtime npm dependencies.

## 1. Verified API facts (official docs, https://docs.daftara.dev)

| Fact | Source page |
| --- | --- |
| Auth header `APIKEY` (API-key roles are **per entity, not per method** — Only Allow / Only Block lists of entities — so a key that can read an entity can also write it; there is no read-only key; 403 when blocked). Docs flag `apikey` as deprecated in favour of an OAuth Bearer token; this skill keeps `APIKEY` and never uses an OAuth client secret. | 933385m0, 15115241e0 |
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
| **No copy/clone endpoint exists** for invoices, estimates or purchase invoices (the only "clone" is the audit field `clone_id` on expenses). Duplication = GET source + normal create. All three create endpoints accept draft (`Invoice.draft` for invoices/estimates, `?send=draft` for purchase invoices). | llms.txt index; 15115242e0, 15115247e0, 15115352e0 |
| Single invoice/purchase responses carry lines as a sibling of the header (`data.InvoiceItem[]`, `data.PurchaseOrderItem[]`); the estimate response only says lines are "nested" (location unspecified → read defensively, fail closed). Invoice line `tax1/tax2` are tax **ids**; purchase line `tax1/tax2` are tax **values**. | 15115238e0, 15115348e0, 15115243e0 |
| Products: `POST /api2/products.json` (only `name` required; 202 `{id}`; 400 `DUPLICATED` with the existing id), `PUT /api2/products/{id}.json` is a **partial** update (200 confirmation, no echo; some changes blocked after stock movements), `DELETE` exists (not used). `initial_stock_level`+`store_id` create stock; `brand`/`category` names auto-create records; omitted taxes default silently. | 15115317e0, 15115314e0, 15115315e0 |
| Categories: `POST /api2/product_categories.json` `{Category:{name,category_type:1,parent_id,…}}` and `PUT …/{id}.json` answer HTTP 200 with body `code 202`; list rows use `ProductCategory`, single uses `Category`. | 39121469e0, 39121470e0, 15115374e0 |
| Customers: `POST /api2/clients.json` (`Client`, only `business_name` required, 202 `{id, client_number}`, 400 `validation_errors`), `PUT /api2/clients/{id}.json` is a documented **partial** update. Suppliers: `POST /api2/suppliers.json` (email required unless `is_offline`), `PUT /api2/suppliers/{id}.json` requires `business_name` and documents **no partial semantics**. Only e-mail uniqueness is enforced by Daftra; tax-number/phone/name duplicates are not. Tax/VAT number = `bn1` (+ `bn1_label`). Side-effect fields: `password`, `send_notify` (e-mails the client), `starting_balance` (accounting entry), `suspend`. | 15115262e0, 15115259e0, 15115267e0, 15115264e0 |
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
| **Duplicate** sales invoice / purchase invoice / estimate into a new draft | `duplicate <source> <id>` → proposal with original-vs-proposed diff | ✔ (fake) | ✘ | **explicit, per operation** |
| **Products & categories**: search/read | `list/get products`, `list product_categories` | ✔ | ✘ | none |
| **Product create / update (price, tax, supplier, categories, code, barcode, status…)**, category create / update | `propose product_create|product_update|category_create|category_update` | ✔ (fake) | ✘ | **explicit, per operation** (price changes highlighted) |
| **Customers & suppliers**: list/search/show | `list/get clients|suppliers` | ✔ | ✘ | none |
| **Customer / supplier create & update** (names, contacts, addresses, tax number, currency, credit terms) | `propose client_create|client_update|supplier_create|supplier_update` (before/after preview, duplicate guard, stale-edit guard) | ✔ (fake) | ✘ | **explicit, per operation** |
| Supplier statement | **Not implemented**: no verified totals in the API list; official `ledger`/`trial_balance` reports (by `journal_account_id`) are the supported route | — | — | — |
| Delete/deactivate/suspend or bulk-change customers/suppliers; portal passwords; notifications; opening balances; custom fields | **Not implemented** (separate authorisation required) | — | — | — |
| Edit / delete / refund / e-invoice submission of documents or payments; **delete** of any record | **Not implemented** (no DELETE/PATCH code exists; PUT only for products, categories, customers and suppliers) | — | — | — |
| Stock/inventory changes, product bundles, units, brand creation | **Not implemented** (stock endpoints and financial/inventory effects not verified) | — | — | — |
| Product import / export, bulk product operations | **DEFERRED by the owner** (general PDF/XLSX/CSV/DOCX/JSON exports of invoices, statements and reports are unaffected) | — | — | — |

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

## 5. Transaction safety (implemented in `daftra-proposal/write/ledger/auth/approve`)

Threat model: the agent controls CLI arguments and can read/write the workspace, so everything it can see or write is untrusted. The one thing it must not have is the operator's `DAFTRA_APPROVAL_SECRET`; all trust is anchored in HMAC-SHA256 under that secret. (An independent adversarial review found the first design, which printed a derivable phrase and kept unauthenticated proposal/ledger files, bypassable — see "Review findings" below; this section describes the fixed design.)

1. **Preview** (`propose`, GET only): references exist, tax ids exist & are active, exact decimal totals (tax-exclusive/inclusive, ≤12 integer digits), API-key role can read the entity, remote duplicates over **all pages**, payment ≤ invoice `summary_unpaid`, invoice not draft, ledger duplicate.
2. **Authenticated proposals**: every field that affects what is sent or checked (type, request, hash, totals, party, expiry, mode, acknowledged duplicates, `ready`) is covered by an HMAC `auth`. Any edit without the secret ⇒ `TAMPERED`. Expiry fails closed.
3. **Out-of-band human approval**: phrase `APPROVE <id> <hash8> <DRAFT|FINAL> <code>`; `<code>` is an HMAC the agent cannot compute and no agent-facing command prints. The human runs the operator tool `daftra-approve.mjs show <id>` in a trusted shell, reviews the stored request, and sends the phrase. Bound to the proposal, 15-minute TTL.
4. **Operator switches**: `DAFTRA_WRITES_ENABLED=1` (default off) and `DAFTRA_APPROVAL_SECRET` (required).
5. **Route + body allowlist**: six POST create endpoints for documents/payments, `POST /api2/products.json`, `POST /api2/product_categories.json`, and `POST /api2/clients.json`, `POST /api2/suppliers.json`, and `PUT` only to `/api2/products/<id>.json`, `/api2/product_categories/<id>.json`, `/api2/clients/<id>.json`, `/api2/suppliers/<id>.json` (id pinned to the signed target). `?send=draft` only on the two endpoints that document it. A per-type body-key allowlist makes stock/bundle/identity fields unsendable. PATCH/DELETE do not exist in the code.
6. **Atomic claims**: O_EXCL locks per proposal and per request hash ⇒ parallel `execute` calls send at most once. A proposal is single-use even when it is refused before sending.
7. **HMAC-chained ledger** (`daftra-ledger/ledger.jsonl`): edits or mid-file truncation ⇒ `LEDGER_TAMPERED`, all writes stop. Records ids, hashes, states, actor, record id — no amounts, names or secrets.
8. **Pre-submit re-check**: balance/duplicates/permissions re-read immediately before sending, derived from the authenticated request body only.
9. **No blind retry**: one attempt. Network error / 5xx / success-without-id ⇒ `ambiguous`; the identical request is blocked until a human obtains a resolve code from the operator tool. 4xx ⇒ `rejected` (nothing created, may re-propose).
10. **Idempotency**: expenses carry a deterministic `unique_id`; others rely on the ledger + duplicate scan. **Rate limit** `DAFTRA_MAX_WRITES_PER_HOUR` (default 20). **Read-back** compares the created total with the approved total.

11. **Privilege separation (broker) — two deployment options.** (a) *Separate Railway service* (recommended, `docs/DAFTRA_RAILWAY_SERVICE_NOTES.md`, `docs/DAFTRA_RAILWAY_ROLLOUT.md`): the agent holds **no Daftra credential**; reads go through a GET-only allowlisted proxy (`/v1/get`, `/v1/invoice_pdf`); proposals via `/v1/propose|propose_duplicate|show|status`; approval only in the operator console (password + fresh TOTP per approval, CSRF, lockout, HMAC audit) — the agent has no execute/approve route and no phrase exists; private API refuses public-edge/Host-mismatched requests; writes disabled unless the *service's own* `DAFTRA_WRITES_ENABLED=1`. (b) *Local Unix-socket broker* (below).

   Local-broker detail: With `DAFTRA_BROKER_SOCKET`, propose/duplicate/show/execute/resolve run only in a separate privileged process (different OS user) that alone holds the approval secret and the write-capable API key; the agent holds only the read key and the socket. Proven with a real unprivileged uid (65534): it cannot read the secret/key files, the broker's state, or `/proc/<pid>/environ`, cannot execute without the operator's phrase, and strict-schema requests reject any `env`/secret/path field. Recipe and limits: `docs/DAFTRA_BROKER.md`. **Not deployed**: it needs a Dockerfile/entrypoint/Railway change that awaits the owner's approval.

**If the separation cannot be enforced on Railway** (single container, one OS user, the volume owned by the agent's user, no second service): the agent and the secrets share a trust domain, so a hostile agent could read `DAFTRA_APPROVAL_SECRET`/the write key from its environment or tamper with the ledger directory, and customer/supplier/product/financial writes lose their independent gate. In that case keep `DAFTRA_WRITES_ENABLED` unset (all writes impossible) and use the skill read-only; enable writes only in short supervised sessions or after deploying the broker as a separate service/user with a root-owned (or separate-volume) ledger directory.

**Residual limits (honest):**
- Without the broker (single-process mode), if the agent's process can read the server environment, it can read `DAFTRA_APPROVAL_SECRET` **and `DAFTRA_API_KEY`** and bypass everything (including calling Daftra directly with the key). Software in the same trust domain cannot prevent that. Mitigations: keep writes off (`DAFTRA_WRITES_ENABLED` unset) except in supervised sessions; keep the approval secret only in the operator's shell/secret store rather than the gateway service where the platform allows; use OpenClaw exec allow-lists/sandboxing; restrict the Daftra API key's roles.
- Truncating the **tail** of the ledger cannot be detected by a chain alone; replay is limited by the 15-minute proposal expiry and the proposal claim lock.
- Review findings fixed in this revision: self-approval, forged proposals/ledger, parallel double-send, unsigned side fields, ungated `resolve`, page-1-only duplicate scan, export-path TOCTOU, key-name-only redaction, unbounded totals.

## 6. Not verified / needs the real tenant

Live JSON shapes of each endpoint and report; whether the API key's role allows each entity; real `invoice_pdf_url` download; ZATCA/e-invoice side effects of final invoices; open/closed financial periods; tenant payment-method names; **payment reconciliation inputs** (§6.1); tax inclusive/exclusive rounding vs Daftra's own (the read-back catches differences); PDF Arabic fonts and Chromium inside the Railway image; delivery on iPhone.

### 6.1 Payment reconciliation sources (`reconcile-payments`) — single reference

`daftra-reconcile.mjs` reads payments from exactly these places. The code constant is `EMBEDDED_PATHS`; a test fails if this document or `SKILL.md` names another path.

| Source | Path / endpoint | Evidence status |
|---|---|---|
| List | `GET /api2/invoice_payments.json?client_id=` (all pages, no status/date filter) | Documented list endpoint; known to omit some settlement types (e.g. `client_credit`). Page-complete ≠ accounting-complete. |
| Detail, path 1 | `data.Payment` (array) of `GET /api2/invoices/<id>.json` | Already read by the document-copy code (`daftra-duplicate.mjs`); not live-verified for reconciliation. |
| Detail, path 2 | `data.InvoicePayment` (array) | No live evidence; accepted as an alternative placement. |
| Detail, path 3 | `data.Invoice.InvoicePayment` (array) | Reported by the client-48 live test (maintainer); not independently re-observed here. |
| Single | `GET /api2/invoice_payments/<id>.json` → `data.InvoicePayment` | Used to corroborate; shape assumed from the documented model key. |

The three detail paths are one source ("detail"): the same payment on several paths is a repeat inside one source (counted once only when identical in amount, invoice link, status, method and date, where a value missing in one copy but present in another counts as a difference; otherwise a conflict that the single GET cannot cancel). Elements may be flat or wrapped in an `InvoicePayment` key. If none of the paths exists the invoice is `unresolved`.

Other inputs still **not verified live**: the `invoice_payments.status` codes (only `1` counts as successful, `0`/cancelled/failed are not counted, anything else is `unresolved`); the detail date format `DD/MM/YYYY` (strictly normalised, always compared with the list's ISO date); and `payment_method` values: only `client_credit` and the built-ins `cash`, `bank`, `cheque` are classified, everything else is `unclassified`. The documented built-ins `credit` and `offline` are deliberately **not** treated as cash/bank because their accounting meaning is not established. A `client_credit` payment proves that Daftra applied customer credit to the invoice, not where that credit came from or that its journal entry is correct.

## 7. Acceptance gates before any production use

1. Read-only smoke test on the tenant: `capabilities`, `list invoices --all`, `get`, `report trial_balance`, `pdf <id>` (compare with Daftra UI).
2. Draft-only write test on a **non-production tenant or a disposable draft**, with `DAFTRA_WRITES_ENABLED=1` set by the operator for that session only.
3. Skill placement in the OpenClaw persistent workspace (`<workspace>/skills/basht-daftra`) — requires explicit deployment approval. The Docker image currently copies only `src/`.
4. Rollback: remove the skill directory; the ledger and exports live in the workspace volume and are untouched by a redeploy.
