// Registry of Daftra API v2 resources and reports, transcribed from the official
// OpenAPI pages at https://docs.daftara.dev (page ids in `doc`). Nothing here is guessed:
// - list endpoints:   GET /api2/<path>.json   -> { code, result, data: [{ <model>: {...} }], pagination }
// - pagination:       { prev, next, page, page_count, total_results }  (total_results = ALL pages)
// - purchase invoices use the `PurchaseOrder` model key, not `PurchaseInvoice`.
// - reports:          GET /api2/reports/<name>  (no `.json` suffix, no pagination, 400 above size ceilings)
// Only the query parameters listed here are ever sent (allowlist; anything else is rejected).

export const ENTITIES = Object.freeze({
  invoices: Object.freeze({ path: 'invoices', model: 'Invoice', doc: '15115241e0', params: Object.freeze(['page', 'limit', 'recursive', 'keywords', 'client_id', 'type', 'client_type', 'payment_status', 'draft', 'follow_up_status', 'currency_code', 'no', 'item', 'tags', 'po_number', 'external_source', 'custom_field', 'custom_field_label', 'subscription_id', 'work_order_id', 'source_type', 'source_id', 'order_source_id', 'shipping_option_id', 'summary_total_from', 'summary_total_to', 'date_from', 'date_to', 'due_date_from', 'due_date_to', 'created_from', 'created_to', 'einvoice_status', 'requisition_delivery_status', 'staff_id', 'pos_shift_id', 'sort', 'direction', 'request_branch_id']) }),
  estimates: Object.freeze({ path: 'estimates', model: 'Estimate', doc: '15115246e0', params: Object.freeze(['page', 'limit', 'name', 'client_id', 'client_type', 'no', 'item', 'currency_code', 'payment_status', 'tags', 'order_source_id', 'work_order_id', 'staff_id', 'sales_person_id', 'summary_total_from', 'summary_total_to', 'date_from', 'date_to', 'created_from', 'created_to']) }),
  clients: Object.freeze({ path: 'clients', model: 'Client', doc: '15115261e0', params: Object.freeze(['keywords', 'assign_staff_id', 'limit', 'page']) }),
  suppliers: Object.freeze({ path: 'suppliers', model: 'Supplier', doc: '15115266e0', params: Object.freeze(['limit', 'page', 'name', 'address', 'postal_code', 'country_code', 'status']) }),
  products: Object.freeze({ path: 'products', model: 'Product', doc: '15115316e0', params: Object.freeze(['limit', 'page', 'keywords', 'category', 'supplier_id', 'brand_id', 'status', 'tracking_type', 'barcode', 'product_code', 'with_images', 'load_custom_data']) }),
  invoice_payments: Object.freeze({ path: 'invoice_payments', model: 'InvoicePayment', doc: '15115306e0', params: Object.freeze(['limit', 'page', 'sort', 'direction', 'no', 'code', 'client_id', 'payment_method', 'include_starting_balance', 'date_from', 'date_to', 'created_from', 'created_to', 'amount_from', 'amount_to', 'id', 'transaction_id', 'status', 'invoiced_by', 'staff_id', 'pos_shift_id']) }),
  client_payments: Object.freeze({ path: 'client_payments', model: 'ClientPayment', doc: '15115311e0', params: Object.freeze(['limit', 'page', 'sort', 'direction', 'no', 'code', 'client_id', 'payment_method', 'include_starting_balance', 'date_from', 'date_to', 'created_from', 'created_to', 'amount_from', 'amount_to', 'id', 'transaction_id', 'status', 'invoiced_by', 'staff_id', 'pos_shift_id']) }),
  expenses: Object.freeze({ path: 'expenses', model: 'Expense', doc: '40881055e0', params: Object.freeze(['limit', 'page', 'sort', 'direction', 'id', 'expense_number', 'date_from', 'date_to', 'created_from', 'created_to', 'amount_from', 'amount_to', 'note', 'expense_category_id', 'vendor', 'client_id', 'journal_account_id', 'status', 'work_order_id', 'recurring_expense_id', 'creation_method', 'staff_id', 'is_mileage']) }),
  purchase_invoices: Object.freeze({ path: 'purchase_invoices', model: 'PurchaseOrder', doc: '15115351e0', params: Object.freeze(['limit', 'page', 'keywords', 'payment_status', 'work_order_id', 'source_type', 'source_id']) }),
  product_categories: Object.freeze({ path: 'product_categories', model: 'ProductCategory', singleModel: 'Category', doc: '15115374e0', params: Object.freeze(['limit', 'page', 'parent_id', 'id']) }),
  taxes: Object.freeze({ path: 'taxes', model: 'Tax', doc: '15115346e0', params: Object.freeze(['is_active']) }),
  treasuries: Object.freeze({ path: 'treasuries', model: 'Treasury', doc: '15115371e0', params: Object.freeze(['limit', 'page']) }),
});

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
const FREE_TEXT = new Set(['keywords', 'name', 'note', 'vendor', 'address', 'item']);
const FREE_TEXT_RE = new RegExp('^[^\\u0000-\\u001f\\u007f-\\u009f]{1,200}$', 'u');
const TEXT_RE = /^[\p{L}\p{N} _.:@\-\/]{1,100}$/u;

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
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
