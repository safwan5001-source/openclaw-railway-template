// In-memory fake of the Daftra API for tests. Records every request so tests can prove
// that no write ever happens unless explicitly approved.
export class FakeDaftra {
  constructor(seed = {}) {
    this.calls = [];
    this.taxes = seed.taxes ?? [{ id: 1, name: 'VAT', value: 15, included: 0, is_active: 1 }];
    this.records = seed.records ?? {
      clients: { 4: { id: 4, business_name: 'شركة نبراس' } },
      suppliers: { 7: { id: 7, business_name: 'مورد' } },
      products: { 9: { id: 9 } },
      invoices: { 3: { id: 3, draft: 0, summary_total: '115.00', summary_unpaid: '115.00', client_id: 4 } },
    };
    this.lists = seed.lists ?? {};
    this.forbidden = new Set(seed.forbidden ?? []);
    this.post = seed.post ?? ((url, body) => ({ status: 202, json: { code: 202, result: 'successful', id: 5001 } }));
    this.postError = seed.postError ?? null;
    this.created = {};
  }
  get posts() { return this.calls.filter((c) => c.method !== 'GET'); }
  fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const path = url.pathname; const search = url.search;
    this.calls.push({ method, path, search, body: options.body, headers: options.headers });
    if (method === 'POST') {
      if (this.postError) throw this.postError;
      const out = this.post(url, JSON.parse(options.body));
      return new Response(JSON.stringify(out.json), { status: out.status });
    }
    const m = path.match(/^\/api2\/([a-z_]+?)(?:\/(\d+))?\.json$/);
    if (!m) return new Response('{}', { status: 404 });
    const [, resource, id] = m;
    if (this.forbidden.has(resource)) return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
    const models = { clients: 'Client', suppliers: 'Supplier', products: 'Product', invoices: 'Invoice', estimates: 'Estimate', expenses: 'Expense',
      invoice_payments: 'InvoicePayment', client_payments: 'ClientPayment', purchase_invoices: 'PurchaseOrder', taxes: 'Tax' };
    const model = models[resource];
    if (id) {
      const rec = this.records[resource]?.[id] ?? this.created[resource]?.[id];
      return rec ? new Response(JSON.stringify({ code: 200, data: { [model]: rec } }), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    const all = resource === 'taxes' ? this.taxes : (this.lists[resource] ?? []);
    const limit = Number(url.searchParams.get('limit') || 20); const page = Number(url.searchParams.get('page') || 1);
    const pageCount = Math.ceil(all.length / limit);
    const rows = all.slice((page - 1) * limit, page * limit);
    return new Response(JSON.stringify({
      code: 200, data: rows.map((r) => ({ [model]: r })),
      pagination: { prev: page > 1 ? 'p' : null, next: page < pageCount ? 'n' : null, page, page_count: pageCount, total_results: all.length },
    }), { status: 200 });
  };
}
