# Automation safety architecture
## State machine
DRAFT → AWAITING_APPROVAL → APPROVED → EXECUTING → VERIFIED or FAILED. Store owner approval reference, campaign/template, exact recipient list or selection rules, max messages, spending authorization and expiry. Approval for drafting does not authorize dispatch.
## Idempotency and failures
Use stable event ID and deduplication store; retry only idempotent read/actions with bounded exponential backoff. For uncertain delivery, inspect provider status before retrying to avoid duplicates. Expose kill switch, rate limits, quiet hours, opt-out enforcement, dead-letter queue and manual reconciliation.
## Privacy
Least privilege; separate marketing contacts from private WhatsApp contacts; explicit opt-in and unsubscribe. No credentials in logs or skill files. Do not cross entity/tenant boundaries. Human approval required for new audiences or new outbound platforms.
## Tests
Synthetic duplicate lead (only one action), expired approval (block), missing connector (draft only), provider timeout after send (unknown status; no blind resend), opt-out (block), over budget (block). Confirm no live customers contacted.
## Deliverable
Workflow specification, event schema, approval scope, threats and mitigations, observability and restore plan.