import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDaftraPage } from './daftra-export.mjs';
test('exports only complete known tenant pages and approved fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basht-daftra-'));
  try {
    await mkdir(join(dir, 'exports'));
    const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'test' };
    const fetcher = async () => new Response(JSON.stringify({
      data: [{ Invoice: { id: '0001', total: '10', private_note: 'not-for-export' } }],
      pagination: { total: 1 }
    }), {status:200});
    const result = await exportDaftraPage('invoices', ['id','total'], 'csv', join(dir,'exports','invoices.csv'), env, fetcher);
    const body = await readFile(result.path, 'utf8');
    assert.ok(body.includes('0001'));
    assert.ok(!body.includes('not-for-export'));
    assert.equal(result.record_count,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('rejects unknown pagination and paths outside private exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basht-daftra-'));
  try {
    await mkdir(join(dir,'exports'));
    const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'test' };
    const incomplete = async () => new Response(JSON.stringify({data:[{Invoice:{id:'1'}}]}), {status:200});
    await assert.rejects(exportDaftraPage('invoices',['id'],'csv',join(dir,'exports','a.csv'),env,incomplete),/all pages/);
    const complete = async () => new Response(JSON.stringify({data:[{Invoice:{id:'1'}}], pagination:{total:1}}),{status:200});
    await assert.rejects(exportDaftraPage('invoices',['id'],'json',join(dir,'outside.json'),env,complete),/private exports/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
