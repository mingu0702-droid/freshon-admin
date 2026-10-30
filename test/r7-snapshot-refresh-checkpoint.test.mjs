import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const refresh=code.slice(code.indexOf('async function refreshPhase2bSnapshot() {'),code.indexOf('function schedulePhase2bSnapshotRefresh'));
function harness({through='2026-10-30',missing=['2026-10-31'],status,fail=false}={}){
 const original={rows:[{customerCode:'S970001',lat:37.5,lng:127.1,lastDeliveryDate:'2026-10-23'}],latestDate:'2026-10-23',refreshedThrough:through};
 const writes=[];let statusCalls=0;
 const context=vm.createContext({previewEnabled:()=>true,phase2bSnapshotRefreshPromise:null,readPhase2bSnapshot:async()=>original,phase2bSnapshotMemory:original,
  phase2bSnapshotPayload:(rows,state={})=>({rows,latestDate:rows.at(-1).lastDeliveryDate,...state}),phase2bKstDate:()=> '2026-10-31',phase2bSnapshotMissingDates:()=>missing,
  phase2bSnapshotDateRows:async()=>[],phase2bTodayStatus:async()=>{statusCalls++;if(fail)throw Error('FIXTURE_UPSTREAM_FAILED');return status||{date:'2026-10-31',vehicles:[]};},
  phase2bRuntimeSnapshotUrl:'isolated-fixture',fs:{writeFile:async(_file,text)=>writes.push(JSON.parse(text))},console:{info(){},error(){}},normalizeCell:v=>String(v||'').trim(),setTimeout:()=>({unref(){}}),warmPhase2bBounds:async()=>{}});
 vm.runInContext(refresh,context);
 return {run:()=>vm.runInContext('refreshPhase2bSnapshot()',context),writes,context,statusCalls:()=>statusCalls};
}
test('failed daily source keeps last checkpoint incomplete without emptying known coordinates',async()=>{
 const h=harness({fail:true});assert.equal(await h.run(),null);assert.equal(h.writes.length,1);assert.equal(h.writes[0].refreshComplete,false);assert.equal(h.writes[0].rows[0].lat,37.5);
});
test('bounded missing-date batch does not jump its completion pointer over unread dates',async()=>{
 const h=harness({through:'2026-09-01',missing:['2026-09-02']});const result=await h.run();assert.equal(result.refreshedThrough,'2026-09-02');assert.equal(result.refreshComplete,false);assert.equal(h.statusCalls(),0);assert.equal(h.writes.length,1);
});
test('null delivery coordinates preserve known point and unknown customers never receive zero pins',async()=>{
 const h=harness({status:{date:'2026-10-31',vehicles:[{vehicle:'101',stops:[{customerCode:'S970001',lat:null,lng:''},{customerCode:'S970002',lat:null,lng:null}]}]}});
 const result=await h.run();assert.equal(result.refreshComplete,true);assert.equal(result.rows.at(-1).lat,37.5);assert.equal(result.rows.at(-1).lng,127.1);assert.equal(result.rows.some(row=>row.customerCode==='S970002'),false);
});
test('wrong-day response cannot certify today as refreshed',async()=>{
 const h=harness({status:{date:'2026-10-30',vehicles:[]}});assert.equal(await h.run(),null);assert.ok(h.writes.every(row=>row.refreshComplete===false));
});
