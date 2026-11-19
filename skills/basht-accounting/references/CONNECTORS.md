# Connector and ERP interoperability contract

## Support model
A **universal accounting skill does not magically connect to every ERP**. First discover authorized tools or ask for original exports. Each adapter must expose a verified and bounded contract, at minimum:
- `system_id`, `tenant_id`, legal entity, branch, timezone, source extraction timestamp, supported objects, allowed operations and effective role.
- Object provenance: source record IDs and URLs only when safe, issue/posted/due/value dates, currency, raw status and normalized status with confidence, journal ID, attachments/receipt refs.
- Pagination and complete range verification; fetch and update controls (ETag/modified time) where available.
- No writes as a fallback for missing reads; writes through adapter-specific approval and audit log only.

## Readiness matrix
- Daftra: existing `basht-daftra` connector, bounded by its capability response; do not claim reports work when API replies 404/405.
- AWJ ERP: not assumed connected; require a verified connector or authorized export and branch/tenant filters.
- QuickBooks, Xero, Odoo, Zoho Books, SAP, Oracle NetSuite, Microsoft Dynamics, other ERP: **not connected by this skill itself**; use a verified available connector or user export. Never improvise endpoints based on the name.
- XLSX/CSV/PDF: permitted as source documents, not live-system access. A PDF scan may need manual verification of reading accuracy.

## Canonical accounting objects
Account {source_system, tenant, account_id, code, name, parent_id, type, currency, active}
JournalLine {journal_id, line_id, account_id, posting_date, period, debit, credit, currency, dimensions, source_ref, reversal_ref}
Invoice {id, type, party_id, document_date, posting_date, due_date, status, currency, subtotal, discounts, tax, total, open_balance, lines[], linked_credit_ids[]}
Payment {id, posting_date, bank_value_date, amount, currency, party_id, reference, status, allocations[{invoice_id, amount}], fee, reversal_id}
BankLine {statement_id, line_id, value_date, booking_date, amount_signed, currency, reference, counterparty, balance}
TaxLine {document_id, line_id, taxable_base, tax_code, rate, tax_amount, inclusive, jurisdiction}
ItemMovement {id, sku, quantity, uom, location, date, valuation, currency, type}
Asset {id, acquisition_date, cost, salvage_value, life, method, accumulated_depreciation, disposal_date}

Never invent missing fields; preserve `unknown` distinct from zero. Preserve original raw payload separately behind access controls and redact secrets.

## Multiple systems in one review
1. Confirm legal entity and accounting period for each system; never merge entities/tenants by name resemblance.
2. Establish whether systems are authoritative, upstream, replica, or partially overlapping; define one source of truth per metric.
3. Create explicit crosswalk for account/party/document IDs and currency/unit conventions; do not assume IDs match.
4. Deduplicate only with evidence (shared external identifier plus consistent values); don't erase similar records merely due to same amount/date.
5. Report timing differences, integration lags, FX and postings separately.
6. If no approved write adapter, propose correction in the relevant source system; do not silently propagate changes.
