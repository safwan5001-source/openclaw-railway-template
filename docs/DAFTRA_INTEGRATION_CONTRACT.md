# BASHT × Daftra — Integration Contract v1

Status: **DESIGN / NOT DEPLOYED**. The existing pilot code is read-only; this contract expands the planned scope without enabling writes.

## Objective
A full accounting assistant for the user's Daftra tenant. Arabic conversational actions, draft-first workflows, and downloadable PDF, XLSX, CSV, DOCX, and JSON. PDF is the preferred *output format*, not the only operation or format.

## Verified references
- API key header `APIKEY`, only-allow route rules: https://docs.daftra.com/tutorial/api/
- Invoice list `GET /api2/invoices.json`: https://docs.daftara.dev/15115241e0
- Single invoice `GET /api2/invoices/{id}.json`: https://docs.daftara.dev/15115238e0
- Estimate creation `POST /api2/estimates.json`: https://docs.daftara.dev/15115247e0
- Expense creation `POST /api2/expenses.json`: https://docs.daftara.dev/40881052e0
- Invoice payments list `GET /api2/invoice_payments.json`: https://docs.daftara.dev/15115306e0
- Daftra UI export and print actions: https://docs.daftra.com/en/tutorial/bulk-actions-in-system-lists/

Docs use both `.daftara.com` examples and `.daftra.com` tenant domains; the user's actual tenant is `https://nepras.daftra.com`. Probe only that allowlisted tenant. API examples sometimes show both APIKEY and Authorization Bearer; verify the minimum required authentication using a GET request before enabling additional methods.

## Operations matrix

| Business function | API implementation | Current status | Approval |
| --- | --- | --- | --- |
| Read/search invoices | GET /api2/invoices.json | Pilot written, not live-tested | None for authorized reads |
| Read one invoice | GET /api2/invoices/{id}.json | Pilot written, not live-tested | None for authorized reads |
| Read customers, suppliers, products, balances | Verify exact endpoints, pagination and permissions | Planned | None for authorized reads |
| Sales invoice | Verify create, draft, tax, numbering, e-invoice semantics | Planned | Explicit for creation/issuance |
| Purchase invoice | Verify create & tax/accounting effects | Planned | Explicit |
| Quote/estimate | POST /api2/estimates.json | Documented, not implemented | Explicit for creation; sending separately |
| Expense | POST /api2/expenses.json | Documented, not implemented | Explicit for creation/posting |
| Invoice payment / client payment | Verify respective endpoints, immediate settlement, idempotency | Planned | Explicit for every payment |
| Customer/supplier/product maintenance | Verify each action and permissions | Planned | Explicit for mutations |
| PDF/Excel/CSV/DOCX/JSON exports | Native where available; locally generated otherwise | Planned except invoice PDF pilot | None for authorized download |

## Exports contract
- PDF: use Daftra's official PDF for invoices/quotes/receipts where supported and authenticated; preserve original template and all mandated invoice fields. Never represent generated PDFs as an official Daftra document.
- XLSX: safe spreadsheet export with typed amounts/dates, preserved leading zeros in IDs, and sheet name validation. Source records must match the chosen date/filter scope.
- CSV: UTF-8 BOM where useful for Excel, localized dates only in presentation, formula injection protection for cells beginning with =,+,-,@, tab, CR.
- DOCX: editable letters/summaries, never substitute for a legally required original invoice.
- JSON: documented schema, source record IDs, retrieval timestamp, pagination completeness and redaction of secrets.
- All formats: attach/source provenance, filter summary, record count and safe file names. No private link in logs. Set access controls, delivery channel confirmation, short retention and deletion policy.
- Direct UI exports do **not** establish an equivalent programmatic endpoint. Missing API export endpoints mean locally generating a file from authorized data.

## Transaction safety contract
1. Resolve exact customer, branch, products, currency, tax rate, amounts, and line rounding before drafting.
2. Show a preflight preview: operation type, counterparty, totals, tax, dates, duplicate candidates, posting/ZATCA effects, user-confirmable action.
3. Default to draft where the actual API supports it; never assume posting is reversible or that a payment can be saved as draft.
4. Require *per-operation* explicit user confirmation for creating, modifying, issuing, settling, emailing, or deleting. A vague 'continue' does not authorize any unrelated financial mutation.
5. Use unique request IDs/idempotency keys wherever Daftra documents them; record a local operation ledger without secrets. On ambiguous network failure, search by unique ID before retry; no blind repeat.
6. Enforce server-side method/path allowlist independently of Daftra's 'only allow' path rules. Those rules may not differentiate GET vs POST.
7. No editing of Gateway, model, browser, existing tools or credentials. Never commit API keys or show them in chat. No production rollout until read/write tests in a safe environment and user approval.
8. Audit record: actor, request, explicit approval, endpoint/method, idempotency ID, result record ID, timestamp, and sanitized error, excluding personal financial details from general logs.

## Acceptance gates
- Unit tests for authentication, pagination, response contracts, exported file type, naming and CSV injection.
- Read-only tenant smoke test with explicit expected IDs and permission failure tests.
- Each write operation: schema validation, permission tests, duplicate prevention, approval gate tests, dry-run/preview tests, and production release approval.
- PDF verified as a real openable file on the user's iPhone, original from Daftra when claimed.
- Rollback plan and documented retention/cleanup before deploying.

## Implementation sequence
1. Harden GET and PDF pilot; verify API response shape, tenant and PDF URL.
2. Add read-only customers, products, supplier, expense, payment list and pagination; local exports in CSV/JSON/XLSX/DOCX and generic PDF reports.
3. Add draft quote/invoice workflows with deterministic validation and approval preview, and test in sandbox before release.
4. Add expenses and payments with stronger approval and reconciliation.
5. Add delivery to approved private channel (WhatsApp integration only after it is actually operational).
