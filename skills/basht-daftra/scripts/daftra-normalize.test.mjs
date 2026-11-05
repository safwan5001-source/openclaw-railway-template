import test from 'node:test';
import assert from 'node:assert/strict';
import { extractList, pickColumns } from './daftra-normalize.mjs';

test('normalizes a known Daftra invoice list', () => {
  const result = extractList({
    data: [{ Invoice: { id: '001', total: '100.00' } }],
    pagination: { total: 1 },
  }, 'invoices');
  assert.equal(result.complete, true);
  assert.equal(result.records[0].id, '001');
  assert.equal(result.warning, null);
});
test('flags pagination uncertainty rather than claiming full report', () => {
  const result = extractList({ data: [{ Client: { id: '2' } }] }, 'clients');
  assert.equal(result.complete, false);
  assert.match(result.warning, /Pagination/);
});
test('rejects unknown response shapes instead of generating empty exports', () => {
  assert.throws(() => extractList({ success: true }, 'invoices'), /Unrecognised/);
  assert.throws(() => extractList({ data: [{}] }, 'expenses'), /Missing model/);
  assert.throws(() => extractList({ data: [] }, '../admin'), /Unsupported/);
  assert.throws(() => extractList({ data: [{}], total: 0 }, 'clients'));
});
test('projects only explicitly selected fields', () => {
  assert.deepEqual(pickColumns([{ id: '001', secret: 'do-not-export' }], ['id']), [{ id: '001' }]);
  assert.throws(() => pickColumns([{}], ['__proto__.secret']));
});
