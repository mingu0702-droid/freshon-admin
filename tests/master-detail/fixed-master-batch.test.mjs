import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../../public/map-phase2b-runtime.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('  async function collectBaseVehicleBatches('),source.indexOf('  async function loadBaseVehicles('));
const collect=new Function(block+';return collectBaseVehicleBatches;')();
const version='a'.repeat(64),checkedAt='2026-10-26T00:00:00.000Z';
const meta={basis:'FIXED_DISPATCH_PRIMARY',version,checkedAt,stale:false};
function payload(codes,change={}){const m={...meta,...change};return {ok:true,meta:m,data:codes.map(customerCode=>({customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:m.version,baseVehicleCheckedAt:m.checkedAt,baseVehicleStale:m.stale,baseVehicleSource:m.basis}))};}
const result=[];async function test(name,fn){await fn();result.push({name,status:'PASS'});}
await test('multiple bounded batches accumulate exact same-evidence rows only',async()=>{let calls=0;const r=await collect([['S1'],['S2']],async b=>{calls++;return payload(b);});assert.equal(calls,2);assert.deepEqual(r.data.map(r=>r.customerCode),['S1','S2']);});
await test('first batch null version cannot be replaced by a later version',async()=>{let calls=0;await assert.rejects(collect([['S1'],['S2']],async b=>{calls++;return payload(b,{version:calls===1?null:version});}),/BASE_BATCH_EVIDENCE/);assert.equal(calls,1);});
await test('changed version/checkedAt/source/stale all reject partial install',async()=>{for(const change of [{version:'b'.repeat(64)},{checkedAt:'2026-10-26T00:00:01.000Z'},{basis:'OTHER'},{stale:true}]){let calls=0;await assert.rejects(collect([['S1'],['S2']],async b=>payload(b,++calls===2?change:{})),/BASE_/);}});
await test('missing duplicate and row metadata mismatch reject',async()=>{for(const mutate of [p=>p.data.pop(),p=>p.data.push(p.data[0]),p=>p.data[0].baseVehicleVersion='b'.repeat(64)])await assert.rejects(collect([['S1','S2']],async b=>{const p=payload(b);mutate(p);return p;}),/BASE_BATCH_/);});
await test('late NOT_READY rejects while first NOT_READY is safe no-data',async()=>{const empty={ok:false,phase:'NOT_READY',meta:{refresh:'READ_ONLY'}};let calls=0;await assert.rejects(collect([['S1'],['S2']],async b=>++calls===1?payload(b):empty),/BASE_BATCH_INCOMPLETE/);assert.equal(await collect([['S1']],async()=>empty),empty);});
await test('readonly no-data exits before polling/version acceptance; 500 GET remains',()=>{const notReady=source.indexOf("if(stageReadOnly&&payload?.meta?.refresh==='READ_ONLY'");assert.ok(notReady>0);assert.ok(notReady<source.indexOf('const previousMeta=baseVehicleMeta;',notReady));assert.match(source.slice(notReady,source.indexOf('const previousMeta=baseVehicleMeta;',notReady)),/clearTimeout\(baseVehicleTimer\)[\s\S]*return;/);assert.ok(source.includes('const batchSize=stageReadOnly?500:10000;'));});
console.log(JSON.stringify({scope:'actual runtime collector function extracted unchanged from source; synthetic response contracts only',passed:result.length,failed:0,result},null,2));
