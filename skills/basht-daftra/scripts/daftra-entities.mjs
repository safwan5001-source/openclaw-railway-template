// Registry of Daftra API v2 resources and reports, transcribed from the official
// OpenAPI pages at https://docs.daftara.dev (page ids in `doc`). Nothing here is guessed:
// - list endpoints:   GET /api2/<path>.json   -> { code, result, data: [{ <model>: {...} }], pagination }
// - pagination:       { prev, next, page, page_count, total_results }  (total_results = ALL pages)
// - purchase invoices use the `PurchaseOrder` model key, not `PurchaseInvoice`.
// - reports:          GET /api2/reports/<name>  (no `.json` suffix, no pagination, 400 above size ceilings)
// Only the query parameters listed here are ever sent (allowlist; anything else is rejected).

export const ENTITIES = Object.freeze({
  invoices: Object.freeze({ path: 'invoices', model: 'Invoice', doc: '15115241e0', params: Object.freeze(['page', 'limit', 'recursive', 'keywords', 'client_id', 'type', 'client_type', 'payment_status', 'draft', 'follow_up_status', 'currency_code', 'no', 'item', 'tags', 'po_number', 'external_source', 'custom_field', 'custom_field_label', 'subscription_id', 'work_order_id', 'source_type', 'source_id', 'order_source_id', 'shipping_option_id', 'summary_total_from', 'summary_total_to', 'date_from', 'date_to', 'due_date_from', 'due_date_to', 'created_from', 'created_to', 'einvoice_status', 'requisition_delivery_status', 'staff_id', 'pos_shift_id', 'sort', 'direction', 'request_branch_id']) }),
  // Official GET All / GET Single Credit Notes (docs.daftara.dev/15115251e0, /15115248e0).
  // Credit-note serial `no` is not the internal id used by GET /credit_notes/{id}.json.
  credit_notes: Object.freeze({ path: 'credit_notes', model: 'CreditNote', doc: '15115251e0', params: Object.freeze(['page', 'limit', 'client_id', 'client_type', 'no', 'item', 'currency_code', 'payment_status', 'tags', 'source_type', 'source_id', 'work_order_id', 'order_source_id', 'custom_field', 'custom_field_label', 'staff_id', 'sales_person_id', 'summary_total_from', 'summary_total_to', 'date_from', 'date_to', 'created_from', 'created_to']) }),
  estimates: Object.freeze({ path: 'estimates', model: 'Estimate', doc: '15115246e0', params: Object.freeze(['page', 'limit', 'name', 'client_id', 'client_type', 'no', 'item', 'currency_code', 'payment_status', 'tags', 'order_source_id', 'work_order_id', 'staff_id', 'sales_person_id', 'summary_total_from', 'summary_total_to', 'date_from', 'date_to', 'created_from', 'created_to']) }),
  clients: Object.freeze({ path: 'clients', model: 'Client', doc: '15115261e0', params: Object.freeze(['keywords', 'assign_staff_id', 'limit', 'page']) }),
  suppliers: Object.freeze({ path: 'suppliers', model: 'Supplier', doc: '15115266e0', params: Object.freeze(['limit', 'page', 'name', 'address', 'postal_code', 'country_code', 'status']) }),
  products: Object.freeze({ path: 'products', model: 'Product', doc: '15115316e0', params: Object.freeze(['limit', 'page', 'keywords', 'category', 'supplier_id', 'brand_id', 'status', 'tracking_type', 'barcode', 'product_code', 'with_images', 'load_custom_data']) }),
  invoice_payments: Object.freeze({ path: 'invoice_payments', model: 'InvoicePayment', doc: '15115306e0', params: Object.freeze(['limit', 'page', 'sort', 'direction', 'no', 'code', 'client_id', 'payment_method', 'include_starting_balance', 'date_from', 'date_to', 'created_from', 'created_to', 'amount_from', 'amount_to', 'id', 'transaction_id', 'status', 'invoiced_by', 'staff_id', 'pos_shift_id']) }),
  client_payments: Object.freeze({ path: 'client_payments', model: 'ClientPayment', doc: '15115311e0', params: Object.freeze(['limit', 'page', 'sort', 'direction', 'no', 'code', 'client_id', 'payment_method', 'include_starting_balance', 'date_from', 'date_to', 'created_from', 'created_to', 'amount_from', 'amount_to', 'id', 'transaction_id', 'status', 'invoiced_by', 'staff_id', 'pos_shift_id']) }),
  expenses: Object.freeze({ path: 'expenses', model: 'Expense', doc: '40881055e0', params: Object.freeze(['limit', 'page', 'sort', 'direction', 'id', 'expense_number', 'date_from', 'date_to', 'created_from', 'created_to', 'amount_from', 'amount_to', 'note', 'expense_category_id', 'vendor', 'client_id', 'journal_account_id', 'status', 'work_order_id', 'recurring_expense_id', 'creation_method', 'staff_id', 'is_mileage']) }),
  purchase_invoices: Object.freeze({ path: 'purchase_invoices', model: 'PurchaseOrder', doc: '15115351e0', params: Object.freeze(['limit', 'page', 'keywords', 'payment_status', 'work_order_id', 'source_type', 'source_id']) }),
  product_categories: Object.freeze({ path: 'product_categories', model: 'ProductCategory', singleModel: 'Category', doc: '15115374e0', params: Object.freeze(['limit', 'page', 'parent_id', 'id']) }),
  // unpaginated: the endpoint takes NO page/limit (sending either is rejected by Daftra/broker). See extractUnpaged().
  taxes: Object.freeze({ path: 'taxes', model: 'Tax', doc: '15115346e0', unpaginated: true, params: Object.freeze(['is_active']) }),
  treasuries: Object.freeze({ path: 'treasuries', model: 'Treasury', doc: '15115371e0', params: Object.freeze(['limit', 'page']) }),
  // Treasuries AND bank accounts: Treasury.type 1 = bank account, 3 = cash treasury (docs 15115371e0 / 15115368e0). There is no separate bank endpoint.
  // Accounting records (docs.daftara.dev Accounting > Journals / Journal Accounts / Journal Cats). Listed `limit` maxima come from the pages:
  // journals 100, journal_accounts / journal_cats / incomes 1000. Requires the journals permission; the API key role must allow the entity.
  journals: Object.freeze({ path: 'journals', model: 'Journal', doc: '40945255e0', maxLimit: 100, params: Object.freeze(['limit', 'page', 'description', 'number', 'draft', 'entity_type', 'entity_id', 'date_from', 'date_to', 'date_selector', 'created_from', 'created_to', 'total_credit_from', 'total_credit_to', 'journal_account_id', 'cost_center', 'added_by', 'recurring_profile', 'fy_id', 'sort', 'direction']) }),
  journal_accounts: Object.freeze({ path: 'journal_accounts', model: 'JournalAccount', doc: '40894808e0', maxLimit: 1000, params: Object.freeze(['limit', 'page', 'journal_cat_id', 'has_cost_centers']) }),
  journal_cats: Object.freeze({ path: 'journal_cats', model: 'JournalCat', doc: '40908338e0', maxLimit: 1000, params: Object.freeze(['limit', 'page']) }),
  incomes: Object.freeze({ path: 'incomes', model: 'Income', doc: '40882577e0', maxLimit: 1000, params: Object.freeze(['limit', 'page', 'sort', 'direction', 'id', 'expense_number', 'date_from', 'date_to', 'created_from', 'created_to', 'amount_from', 'amount_to', 'note', 'expense_category_id', 'vendor', 'client_id', 'journal_account_id', 'status', 'work_order_id', 'recurring_expense_id', 'creation_method', 'staff_id', 'is_mileage']) }),
});

// Things that are asked for but have NO documented read endpoint. They are listed so the agent answers "not available through the API"
// (with the documented substitute) instead of inventing a path. Source: the complete endpoint index at docs.daftara.dev/llms.txt.
export const UNSUPPORTED_READS = Object.freeze({
  expense_categories: 'No expense-category endpoint exists in the Daftra API. Substitutes: `report expenses_summary --param group_by=Category` (subtotal per category) or the `expense_category_id` on `expenses` records. /listing/Category lists product categories only.',
  bank_accounts: 'Bank accounts are not a separate resource: they are `treasuries` rows with type=1 (bank account) / 3 (cash treasury). Use `list treasuries --all`.',
  client_statement_official: 'Daftra documents no client account-statement endpoint or report. `statement <client-id>` is computed locally from invoices and payments and is labelled official:false.',
  supplier_statement: 'Daftra documents no supplier account-statement endpoint or report.',
  cost_centers: 'Documented only as POST-style "list" routes (/cost_center/list/1) with a different filter grammar; not exposed by this read allowlist.',
  deposits: 'No resource named "deposits" is documented. Treasury deposits appear as treasury/journal transactions: use `journals`, `report ledger`, `report financial_transactions` and `list treasuries`.',
  advances: 'Advance-payment invoices are invoices of type 19: `list invoices --query type=19`, and `report advance_payments`.',
  journal_entries: 'The documented resource is `journals` (model Journal), plus `report journals` and `report journal_transactions`.',
});

// Report parameters that legitimately carry non-numeric / negative values although their names end in `_id` (or are branch scopes).
// Source: the parameter tables of the report pages ("`all` or `-1` means every branch the caller may see", "`-1` means without cost centre").
const REPORT_SPECIAL = Object.freeze({
  branch_id: /^(\d{1,15}|-1|all)$/i,
  journals_branch_id: /^(\d{1,15}|-1|all)$/i,
  cost_center_id: /^(\d{1,15}|-1)$/,
  accounts_branch: /^(\d{1,15}|-1)$/,
});

// Documented enumerations per report (case-insensitive on input, canonical case on the wire; expenses/journals say "Case-insensitive").
export const REPORT_ENUMS = Object.freeze({
  income_statement: { date_selector: ['lastmonth', 'lastyear'], accounts_display: ['display_all_accounts', 'display_accounts_with_transactions', 'hide_zero_accounts'] },
  financial_transactions: { date_range_selector: ['lastyear', 'lastmonth'] },
  balance_sheet: { date_selector: ['lastmonth', 'lastyear'], accounts_display: ['display_all_accounts', 'display_accounts_with_transactions', 'hide_zero_accounts'] },
  tax_details: { invoice_type: ['accrual', 'cash', 'partially_paid'], group_by: ['item', 'invoice'] },
  tax_summary: { invoice_type: ['accrual', 'cash', 'partially_paid'] },
  tax_declaration: { invoice_type: ['accrual', 'cash', 'partially_paid'] },
  stock_transactions_profit: { group_by: ['daily', 'weekly', 'monthly', 'yearly', 'client', 'staff', 'product'], is_summary: ['0', '1'] },
  trial_balance_nets: { accounts_display: ['display_all_accounts', 'display_accounts_with_transactions', 'hide_zero_accounts', 'hide_zero_balances'], before_balance_display_type: ['balances_only', 'groups_only'] },
  trial_balance: { accounts_display: ['display_all_accounts', 'display_accounts_with_transactions', 'hide_zero_accounts', 'hide_zero_balances'], before_balance_display_type: ['balances_only', 'groups_only'] },
  trial_nets: { accounts_display: ['display_all_accounts', 'display_accounts_with_transactions', 'hide_zero_accounts', 'hide_zero_balances'], before_balance_display_type: ['balances_only', 'groups_only'] },
  ledger: { display_all_accounts: ['0', '1', 'non_zero_balance'], tags_match: ['any', 'all'] },
  journal_transactions: { tags_match: ['any', 'all'], group_by: ['Journal Number', 'Day', 'Month', 'Year', 'Journal Account', 'Branch', 'Journal'] },
  journals: { group_by: ['Journal', 'Branch'] },
  chart_of_accounts: { account_type: ['0', '1'], order_by: ['Code Ascending', 'Code Descending'] },
  revenue: { report_type: ['client', 'invoice', 'period', 'staff', 'sales_person'], group_by: ['daily', 'weekly', 'monthly', 'yearly', 'client', 'staff', 'sales_person', 'lastyear', 'lastmonth'], show_not_taxed: ['0', '1'] },
  products: { group_by: ['daily', 'weekly', 'monthly', 'yearly', 'staff', 'sales_person', 'collected_by', 'client', 'product', 'category', 'brand'], is_summary: ['0', '1'], invoice_type: ['0', '5', '6', '8', '16'], add_draft: ['0', '1'], include_inactive_products: ['0', '1'] },
  payments: { group_by: ['daily', 'weekly', 'monthly', 'yearly', 'client', 'staff', 'collected_by', 'payment_method'], is_summary: ['0', '1'] },
  accounts_profit_accrual: { group_by_date: ['monthly', 'quarterly', 'annually'] },
  products_profit: { type: ['product', 'client', 'staff', 'sales_person'], date_range_selector: ['lastmonth', 'lastyear'] },
  invoice_return_cross_reference: { invoice_status: ['0', '1', '2', '3', '4', '5'], return_type: ['5', '6'], e_invoice_status: ['Not Submitted', 'Invalid', 'Valid'], group_by: ['Invoice', 'Client', 'Sales Person', 'Branch'] },
  advance_payments: { group_by: ['daily', 'weekly', 'monthly', 'yearly', 'client', 'staff', 'payment_method'], is_summary: ['0', '1'], invoice_type: ['advance_payment', 'credit_note'] },
  expenses_details: { group_by: ['Yearly', 'Monthly', 'Weekly', 'Daily', 'Category', 'Staff', 'Vendor', 'Treasury', 'Client', 'Branch'], is_mileage: ['0', '1'] },
  expenses_summary: { group_by: ['Yearly', 'Monthly', 'Weekly', 'Daily', 'Category', 'Staff', 'Vendor', 'Treasury', 'Client', 'Branch'], is_mileage: ['0', '1'] },
  e_invoices_submission: { date_type: ['created', 'issue_date', 'submission_date', 'date'], e_invoice_status: ['Not Submitted', 'Invalid', 'Valid'], client_type: ['2', '3'], group_by: ['Electronic Invoice Status', 'Daily', 'Weekly', 'Monthly', 'Yearly', 'Client', 'Branch'] },
  invoice_net_position: { payment_status: ['0', '1', '2', '3', '4', '5'], e_invoice_status: ['Not Submitted', 'Invalid', 'Valid'] },
});

// Enumerations whose violation is rejected locally with the accepted list (the page documents a 400 / "refused rather than defaulted").
// Every other enumeration is only case-normalised and left for Daftra to validate (its 400 names the parameter; see validation_errors).
const STRICT_ENUMS = new Set(['revenue.report_type', 'revenue.group_by', 'expenses_summary.group_by', 'expenses_details.group_by']);

// revenue: "The valid set depends on report_type, and a value outside it is a 400".
const REVENUE_GROUP_BY = Object.freeze({
  invoice: ['daily', 'weekly', 'monthly', 'yearly', 'client', 'staff', 'sales_person'],
  period: ['daily', 'weekly', 'monthly', 'yearly', 'lastyear', 'lastmonth'],
  sales_person: ['sales_person'],
  client: [],
  staff: [],
});

// Equivalent date-range names across reports (the pages use date_from/date_to on some, from_date/to_date on others).
const DATE_ALIASES = Object.freeze([['date_from', 'from_date'], ['date_to', 'to_date']]);
// date range pairs whose order Daftra validates ("Must not be earlier than ...")
const DATE_PAIRS = Object.freeze([['date_from', 'date_to'], ['from_date', 'to_date'], ['date_range_from', 'date_range_to']]);

export class ReportParamError extends Error {
  constructor(message) { super(message); this.name = 'ReportParamError'; }
}

// Normalise and validate the parameters of a report call against the documented contract. Pure; returns a new plain object.
//  - maps date_from/date_to <-> from_date/to_date when the report only knows the other spelling
//  - canonicalises documented enumeration values (case-insensitive) and rejects the strict ones with the accepted list
//  - enforces the cross-parameter rules the pages document (revenue group_by per report_type, ledger date, selector vs dates, date order)
export function normalizeReportParams(name, params = {}) {
  if (typeof name !== 'string' || !Object.hasOwn(REPORTS, name)) throw new ReportParamError('Report not authorized');
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid query');
  const spec = REPORTS[name];
  const out = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) out[k] = String(v);
  for (const [a, b] of DATE_ALIASES) {
    for (const [from, to] of [[a, b], [b, a]]) {
      if (Object.hasOwn(out, from) && !spec.params.includes(from) && spec.params.includes(to)) {
        if (Object.hasOwn(out, to)) throw new ReportParamError('Use either ' + from + ' or ' + to + ', not both (' + name + ' takes ' + to + ')');
        out[to] = out[from]; delete out[from];
      }
    }
  }
  for (const key of Object.keys(out)) {
    if (!spec.params.includes(key)) {
      const hint = key === 'brand' && spec.params.includes('brand_id') ? ' (use brand_id; brand is refused by this report)'
        : key === 'category_id' && spec.params.includes('category') ? ' (this report takes category)'
        : key === 'category' && spec.params.includes('category_id') ? ' (this report takes category_id)' : '';
      throw new ReportParamError('Query parameter not allowed: ' + key + ' (report ' + name + ')' + hint + '. Accepted: ' + spec.params.join(', '));
    }
  }
  const enums = REPORT_ENUMS[name] ?? {};
  for (const [key, allowed] of Object.entries(enums)) {
    if (!Object.hasOwn(out, key)) continue;
    const hit = allowed.find((a) => a.toLowerCase() === out[key].trim().toLowerCase());
    if (hit !== undefined) out[key] = hit;
    else if (STRICT_ENUMS.has(name + '.' + key)) throw new ReportParamError(name + ': ' + key + ' must be one of ' + allowed.join(', ') + ' (got "' + out[key].slice(0, 40) + '")');
  }
  if (name === 'revenue' && Object.hasOwn(out, 'group_by') && Object.hasOwn(out, 'report_type')) {
    const ok = REVENUE_GROUP_BY[out.report_type];
    if (!ok.includes(out.group_by)) {
      throw new ReportParamError('revenue: group_by "' + out.group_by + '" is not valid with report_type=' + out.report_type
        + (ok.length ? ' (accepted: ' + ok.join(', ') + ')' : ' (omit group_by for this report_type)'));
    }
  }
  if (name === 'ledger' && !Object.hasOwn(out, 'date_from') && !Object.hasOwn(out, 'date_to'))
    throw new ReportParamError('ledger: at least one of date_from / date_to is required (Daftra prints nothing without a date range)');
  for (const sel of ['date_selector', 'date_range_selector']) {
    if (Object.hasOwn(out, sel)) {
      for (const k of ['date_from', 'date_to', 'date_range_from', 'date_range_to']) {
        if (Object.hasOwn(out, k)) throw new ReportParamError(name + ': ' + sel + ' cannot be combined with ' + k);
      }
    }
  }
  for (const [from, to] of DATE_PAIRS) {
    if (Object.hasOwn(out, from) && Object.hasOwn(out, to) && isCalendarDate(out[from]) && isCalendarDate(out[to]) && out[to] < out[from])
      throw new ReportParamError(name + ': ' + to + ' must not be earlier than ' + from);
  }
  return out;
}

// Query string for a report: the generic allowlist + per-key validation of buildQuery(), plus the documented special values.
export function buildReportQuery(name, params = {}) {
  const spec = REPORTS[name];
  const normalised = normalizeReportParams(name, params);
  const special = {}; const rest = {};
  for (const [k, v] of Object.entries(normalised)) {
    if (Object.hasOwn(REPORT_SPECIAL, k)) special[k] = v; else rest[k] = v;
  }
  const out = buildQuery(spec.params, rest);
  for (const [k, v] of Object.entries(special)) {
    if (!REPORT_SPECIAL[k].test(v)) throw Error(k + ' has an unsupported value');
    out.set(k, v);
  }
  return out;
}

export const REPORTS = Object.freeze({
  cash_flow: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'branch_id']) }),
  income_statement: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'date_selector', 'accounts_display', 'level', 'cost_center_id', 'fy_id', 'journals_branch_id', 'accounts_branch']) }),
  financial_transactions: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_range_selector', 'date_range_from', 'date_range_to', 'currency', 'branch_id', 'work_order_id', 'page']) }),
  balance_sheet: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'date_selector', 'accounts_display', 'level', 'cost_center_id', 'fy_id', 'journals_branch_id', 'accounts_branch']) }),
  tax_details: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'tax_id', 'invoice_type', 'group_by', 'currency', 'branch_id', 'show_not_taxed']) }),
  tax_summary: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'tax_id', 'invoice_type', 'currency', 'branch_id', 'show_not_taxed']) }),
  tax_declaration: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'invoice_type', 'tax_id', 'currency', 'branch_id']) }),
  stock_transactions_profit: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['group_by', 'is_summary', 'date_from', 'date_to', 'client_id', 'client_category', 'product_id', 'staff_id', 'branch_id', 'order_source_id']) }),
  trial_balance_nets: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'journal_cat_id', 'journal_account_id', 'accounts_display', 'level', 'cost_center_id', 'fy_id', 'staff_id', 'before_balance_display_type', 'journals_branch_id', 'accounts_branch']) }),
  trial_balance: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'journal_cat_id', 'journal_account_id', 'accounts_display', 'level', 'cost_center_id', 'fy_id', 'staff_id', 'before_balance_display_type', 'journals_branch_id', 'accounts_branch']) }),
  trial_nets: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_to', 'journal_cat_id', 'journal_account_id', 'accounts_display', 'cost_center_id', 'fy_id', 'staff_id', 'before_balance_display_type', 'journals_branch_id', 'accounts_branch']) }),
  ledger: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'journal_cat_id', 'journal_account_id', 'display_all_accounts', 'cost_center_id', 'fy_id', 'staff_id', 'currency', 'journals_branch_id', 'accounts_branch', 'tags', 'tags_match']) }),
  journal_transactions: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['from_date', 'to_date', 'source', 'journal_account_id', 'show_all_transaction', 'cost_center_id', 'tags', 'tags_match', 'branch_id', 'work_order_id', 'selected_journal_ids', 'group_by']) }),
  journals: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['from_date', 'to_date', 'source', 'journal_account_id', 'branch_id', 'group_by']) }),
  chart_of_accounts: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['account_level', 'account_type', 'display_all_account_except', 'branch_id', 'order_by']) }),
  revenue: Object.freeze({ required: Object.freeze(['report_type']), params: Object.freeze(['report_type', 'group_by', 'date_from', 'date_to', 'client_id', 'client_category', 'staff_id', 'invoice_type', 'currency', 'shipping_option_id', 'show_not_taxed', 'work_order_id', 'order_source_id', 'branch_id', 'e_invoice_status']) }),
  products: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['group_by', 'is_summary', 'date_from', 'date_to', 'currency', 'client_id', 'client_category', 'product_id', 'category', 'brand_id', 'supplier_id', 'staff_id', 'invoice_type', 'invoice_status', 'store', 'branch_id', 'order_source_id', 'add_draft', 'include_inactive_products']) }),
  payments: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['group_by', 'is_summary', 'date_from', 'date_to', 'currency', 'client_id', 'client_category', 'payment_method', 'staff_id', 'collected_by', 'branch_id', 'order_source_id']) }),
  accounts_profit_accrual: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['date_from', 'date_to', 'group_by_date', 'max_level', 'cost_center_id', 'fy_id', 'journals_branch_id', 'accounts_branch']) }),
  products_profit: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['type', 'date_range_selector', 'date_range_from', 'date_range_to', 'category', 'item_group_id', 'product_id', 'brand', 'supplier_id', 'staff_id', 'branch_id']) }),
  invoice_return_cross_reference: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['from_date', 'to_date', 'client_id', 'invoice_status', 'return_type', 'e_invoice_status', 'branch_id', 'currency', 'group_by', 'order_by']) }),
  advance_payments: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['group_by', 'is_summary', 'date_from', 'date_to', 'currency', 'invoice_type', 'client_id', 'payment_method', 'staff_id', 'branch_id']) }),
  expenses_details: Object.freeze({ required: Object.freeze(['group_by']), params: Object.freeze(['group_by', 'from_date', 'to_date', 'treasury_id', 'vendor', 'category_id', 'journal_account_id', 'supplier_id', 'branch_id', 'is_mileage', 'currency']) }),
  expenses_summary: Object.freeze({ required: Object.freeze(['group_by']), params: Object.freeze(['group_by', 'from_date', 'to_date', 'treasury_id', 'vendor', 'category_id', 'journal_account_id', 'supplier_id', 'branch_id', 'is_mileage', 'currency']) }),
  e_invoices_submission: Object.freeze({ required: Object.freeze(['date_from', 'date_to']), params: Object.freeze(['date_from', 'date_to', 'date_type', 'client_id', 'e_invoice_status', 'client_type', 'branch_id', 'currency', 'group_by']) }),
  invoice_net_position: Object.freeze({ required: Object.freeze([]), params: Object.freeze(['from_date', 'to_date', 'payment_status', 'client_id', 'client_category', 'staff_id', 'hide_credit_notes', 'e_invoice_status', 'branch_id', 'currency']) }),
});

const DATE_PARAMS = new Set(['date_from', 'date_to', 'due_date_from', 'due_date_to', 'created_from', 'created_to',
  'from_date', 'to_date', 'date_range_from', 'date_range_to']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Free-text search parameters accept ordinary punctuation (product names like "Oil 5W-30 (4L) & Filter, 100%");
// values are always URL-encoded, only control characters are refused.
const FREE_TEXT = new Set(['keywords', 'name', 'note', 'vendor', 'address', 'item', 'description']);
const FREE_TEXT_RE = new RegExp('^[^\\u0000-\\u001f\\u007f-\\u009f]{1,200}$', 'u');
const TEXT_RE = /^[\p{L}\p{N} _.:@\-\/]{1,100}$/u;

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Strict normalisation of a date VALUE returned by Daftra to ISO YYYY-MM-DD. The same document can carry its date as
// "2026-10-05" (list) or "05/10/2026" (detail, DD/MM/YYYY). Accepted, nothing else:
//   YYYY-MM-DD            optionally followed by a time ("T..." or " ...")
//   DD/MM/YYYY            day first, 2-digit day and month; optionally followed by a time
// The result must be a real calendar date. Anything else (MM/DD, 2-digit years, other separators, impossible dates, empty,
// non-strings) returns null: the caller must reject it, never guess. Because DD/MM and MM/DD cannot be told apart for days
// <= 12, callers compare the normalised value with another source instead of trusting a single reading.
export function normalizeDaftraDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  let iso;
  if (m) iso = m[1] + '-' + m[2] + '-' + m[3];
  else if ((m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.exec(s))) iso = m[3] + '-' + m[2] + '-' + m[1];
  else return null;
  return isCalendarDate(iso) ? iso : null;
}

// Validate and normalise a query-parameter bag against an allowlist.
export function buildQuery(allowed, query = {}) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw Error('Invalid query');
  const out = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (!allowed.includes(key)) throw Error('Query parameter not allowed: ' + key);
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    if (key === 'page' || key === 'limit') {
      if (!/^[1-9]\d{0,5}$/.test(value)) throw Error(key + ' must be a positive integer');
    } else if (/_id$/.test(key) || key === 'id') {
      if (!/^[0-9]{1,15}$/.test(value)) throw Error(key + ' must be an integer id');
    } else if (/(_from|_to)$/.test(key) && /amount|total/.test(key)) {
      if (!/^\d{1,12}(\.\d{1,4})?$/.test(value)) throw Error(key + ' must be a number');
    } else if (DATE_PARAMS.has(key)) {
      if (!isCalendarDate(value)) throw Error(key + ' must be a valid YYYY-MM-DD date');
    } else if (FREE_TEXT.has(key) ? !FREE_TEXT_RE.test(value) : !TEXT_RE.test(value)) {
      throw Error(key + ' has unsupported characters');
    }
    out.set(key, value);
  }
  return out;
}
