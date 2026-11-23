import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const cli = new URL('./transport-sales.mjs', import.meta.url).pathname;
function run(command, input) {
  const p = spawnSync(process.execPath,[cli,command],{input:JSON.stringify(input),encoding:'utf8',timeout:5000});
  return {code:p.status,out:p.stdout ? JSON.parse(p.stdout):null,err:p.stderr ? JSON.parse(p.stderr):null};
}
test('lead research: duplicate and missing evidence',()=>{
 const r=run('leads',{leads:[
  {name:'شركة أمل',status:'prospect',source_url:'https://example.org/a',checked_at:'2026-11-22'},
  {name:'شركة أمل',status:'verified_open_request',source_url:'http://example.org/b',checked_at:'invalid'}
 ]});
 assert.equal(r.code,0);
 assert.equal(r.out.leads[1].duplicate_of,0);
 assert.ok(r.out.leads[1].issues.includes('manual_confirmation_required_not_automatically_verified'));
 assert.ok(r.out.leads[1].issues.includes('missing_valid_https_source_url'));
});
test('quote margin math not markup',()=>{
 const r=run('quote',{trips:5,daily_cost_sar:900,target_margin_pct:20});
 assert.equal(r.code,0);
 assert.equal(r.out.quote.cost_per_trip_sar,180);
 assert.equal(r.out.quote.illustrative_net_sale_per_trip_sar,225);
 assert.equal(r.out.quote.binding_quote,false);
 assert.equal(r.out.quote.vat_included,false);
});
test('invalid quote rejected',()=>{
 for(const input of [{trips:0,daily_cost_sar:900,target_margin_pct:20},
 {trips:5,daily_cost_sar:900,target_margin_pct:100},
 {trips:3.5,daily_cost_sar:100,target_margin_pct:25}]) {
  const r=run('quote',input);assert.notEqual(r.code,0);assert.equal(r.err.ok,false);
 }
});
test('invalid leads rejected',()=>{
 const r=run('leads',{leads:'not array'});assert.notEqual(r.code,0);
});

test('unsubstantiated verified request is downgraded, retaining claim for audit',()=>{
 const r=run('leads',{leads:[{
  name:'شركة اختبار',status:'verified_open_request',
  source_url:'https://example.org/request',checked_at:'2026-11-23'
 }]});
 assert.equal(r.code,0);
 assert.equal(r.out.leads[0].status,'unverified_request');
 assert.equal(r.out.leads[0].claimed_status,'verified_open_request');
 assert.ok(r.out.leads[0].issues.includes('classification_downgraded_missing_evidence'));
});
test('qualified claim with missing confirmed demand is downgraded',()=>{
 const r=run('leads',{leads:[{
  name:'شركة اختبار',status:'qualified',source_url:'https://example.org/request',
  checked_at:'2026-11-23',loading_location:'الدمام',unloading_location:'الجبيل',
  material:'بحص',vehicle_type:'قلاب'
 }]});
 assert.equal(r.code,0);
 assert.equal(r.out.leads[0].status,'unverified_request');
});
test('qualified missing vehicle fit cannot retain qualified classification',()=>{
 const r=run('leads',{leads:[{
  name:'شركة اختبار',status:'qualified',source_url:'https://example.org/request',
  checked_at:'2026-11-23',request_confirmed_at:'2026-11-23',
  confirmation_evidence:'document reviewed manually',loading_location:'الدمام',
  unloading_location:'الجبيل',material:'بحص'
 }]});
 assert.equal(r.code,0);
 assert.equal(r.out.leads[0].status,'verified_open_request');
 assert.ok(r.out.leads[0].issues.includes('missing_vehicle_type'));
});
test('complete confirmed evidence is not automatically invalidated',()=>{
 const r=run('leads',{leads:[{
  name:'شركة اختبار',status:'verified_open_request',source_url:'https://example.org/request',
  checked_at:'2026-11-23',request_confirmed_at:'2026-11-23',
  confirmation_evidence:'manually verified original dated request'
 }]});
 assert.equal(r.code,0);
 assert.equal(r.out.leads[0].status,'verified_open_request');
 assert.ok(r.out.leads[0].issues.includes('manual_confirmation_required_not_automatically_verified'));
});
