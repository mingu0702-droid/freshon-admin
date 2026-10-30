import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {assertDatedAssignmentSource} from '../src/phase2bAssignments.js';
const code=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const extract=(start,end)=>code.slice(code.indexOf(start),code.indexOf(end,code.indexOf(start)));
const refresh=extract('async function refreshPhase2bSnapshot() {','function schedulePhase2bSnapshotRefresh');
const payload=extract('function phase2bSnapshotPayload(','function phase2bSnapshotMissingDates');
function harness({through='2026-10-30',missing=['2026-10-31'],status,fail=false,files=new Map(),publishFail=false}={}){
 const original={rows:[{customerCode:'S970001',lat:37.5,lng:127.1,lastDeliveryDate:'2026-10-23'}],latestDate:'2026-10-23',refreshedThrough:through};
 const writes=[],reads=[];let statusCalls=0;
 const context=vm.createContext({stageVerificationOnly:false,productionMap:{usePublishedHubReads:()=>false},crypto,previewEnabled:()=>true,phase2bSnapshotRefreshPromise:null,readPhase2bSnapshot:async()=>original,phase2bSnapshotMemory:original,
  phase2bKstDate:()=> '2026-10-31',phase2bSnapshotMissingDates:from=>{reads.push(from);return typeof missing==='function'?missing(from):missing;},normalizeDateValue:v=>v,
  phase2bSnapshotDateRows:async date=>[{customerCode:'S970003',lastDeliveryDate:date,lat:null,lng:null}],phase2bTodayStatus:async()=>{statusCalls++;if(fail)throw Error('FIXTURE_UPSTREAM_FAILED');return status||{date:'2026-10-31',vehicles:[]};},
  phase2bRuntimeSnapshotUrl:'isolated-fixture',fs:{readFile:async file=>{if(!files.has(file))throw Object.assign(Error(),{code:'ENOENT'});return files.get(file);},writeFile:async(file,text)=>{writes.push(file);files.set(file,text);},rename:async(from,to)=>{if(publishFail&&to==='isolated-fixture')throw Error('FIXTURE_DISK_FAILED');files.set(to,files.get(from));files.delete(from);}},
  schedulePhase2bSnapshotRefresh:()=>{},process:{env:{}},console:{info(){},error(){}},normalizeCell:v=>String(v||'').trim(),setTimeout:()=>({unref(){}}),warmPhase2bBounds:async()=>{}});
 vm.runInContext(payload+refresh,context);
 return {run:()=>vm.runInContext('refreshPhase2bSnapshot()',context),writes,context,original,files,reads,statusCalls:()=>statusCalls};
}
test('failed current source leaves live memory/file and lastSuccess unchanged; progress is separate',async()=>{
 const h=harness({fail:true});assert.equal(await h.run(),null);assert.equal(h.context.phase2bSnapshotMemory,h.original);assert(!h.files.has('isolated-fixture'));
 const progress=JSON.parse(h.files.get('isolated-fixture.checkpoint.json'));assert.equal(progress.payload.refreshedThrough,'2026-10-31');assert.equal(progress.payload.refreshComplete,false);
});
test('bounded date batch retains last good public snapshot without advancing completion',async()=>{
 const h=harness({through:'2026-09-01',missing:['2026-09-02']});assert.equal(await h.run(),h.original);assert.equal(h.statusCalls(),0);assert(!h.files.has('isolated-fixture'));
 assert.equal(JSON.parse(h.files.get('isolated-fixture.checkpoint.json')).payload.refreshedThrough,'2026-09-02');
});
test('process restart resumes from committed progress; unlocated customers remain in list',async()=>{
 const files=new Map();await harness({through:'2026-09-01',missing:['2026-09-02'],files}).run();
 const h=harness({through:'2026-09-01',missing:from=>from==='2026-09-02'?['2026-10-31']:[],files});
 const value=await h.run();assert.equal(h.reads[0],'2026-09-02');assert.equal(value.refreshComplete,true);assert.equal(value.rows.find(r=>r.customerCode==='S970003').lat,null);
 assert.equal(h.context.phase2bSnapshotMemory,value);assert(h.files.has('isolated-fixture'));
});
test('null delivery coordinates preserve known point and unknown customers never receive zero pins',async()=>{
 const h=harness({status:{date:'2026-10-31',vehicles:[{vehicle:'101',stops:[{customerCode:'S970001',lat:null,lng:''},{customerCode:'S970002',lat:null,lng:null}]}]}});
 const result=await h.run();const known=result.rows.find(r=>r.customerCode==='S970001'),unknown=result.rows.find(r=>r.customerCode==='S970002');
 assert.equal(known.lat,37.5);assert.equal(known.lng,127.1);assert.equal(unknown.lat,null);assert.equal(unknown.lng,null);
});
test('wrong-day response never publishes a completed snapshot',async()=>{
 const h=harness({status:{date:'2026-10-30',vehicles:[]}});assert.equal(await h.run(),null);assert.equal(h.context.phase2bSnapshotMemory,h.original);assert(!h.files.has('isolated-fixture'));
});
test('interruption before checkpoint rename cannot move the cursor',async()=>{
 const files=new Map([['isolated-fixture.checkpoint.json.next','incomplete']]);const h=harness({files});assert.equal((await h.run()).refreshComplete,true);assert.equal(h.reads[0],'2026-10-30');
});
test('corrupt checkpoint fails closed and preserves the last good snapshot',async()=>{
 const h=harness({files:new Map([['isolated-fixture.checkpoint.json','{']])});assert.equal(await h.run(),null);assert.equal(h.context.phase2bSnapshotMemory,h.original);assert.equal(h.statusCalls(),0);
});
test('changed public base rejects stale checkpoint reuse',async()=>{
 const files=new Map();await harness({through:'2026-09-01',missing:['2026-09-02'],files}).run();const h=harness({files});await h.run();assert.equal(h.reads[0],'2026-10-30');
});
test('failed atomic publication leaves live memory and file untouched',async()=>{
 const h=harness({publishFail:true});assert.equal(await h.run(),null);assert.equal(h.context.phase2bSnapshotMemory,h.original);assert(!h.files.has('isolated-fixture'));
});
test('date tiles reject source version changes, caps and incomplete responses',async()=>{
 const source=extract('async function phase2bSnapshotDateRows(','async function readPhase2bSnapshot');let call=0;
 const context=vm.createContext({assertDatedAssignmentSource,callHub:async()=>({ok:true,data:[],meta:{date:'2026-10-31',sourceVersion:String(++call)}})});vm.runInContext(source,context);
 await assert.rejects(vm.runInContext("phase2bSnapshotDateRows('2026-10-31',[{},{}])",context),/SOURCE_VERSION_CHANGED/);
 context.callHub=async()=>({ok:true,data:[],meta:{partial:true}});await assert.rejects(vm.runInContext("phase2bSnapshotDateRows('2026-10-31',[{}])",context),/SOURCE_TRUNCATED/);
});
test('full Delivery page budget is incomplete, never an empty or completed day',async()=>{
 const source=extract('async function fetchDeliveryTaskRowsForDate(','async function buildDailyRouteFromDeliveryAdmin');let calls=0;
 const context=vm.createContext({URLSearchParams,deliveryAdminJson:async()=>{calls++;return Array.from({length:300},()=>({}));},extractDeliveryTaskRows:v=>v});vm.runInContext(source,context);
 await assert.rejects(vm.runInContext("fetchDeliveryTaskRowsForDate('2026-10-31')",context),/DELIVERY_TASK_PAGE_LIMIT/);assert.equal(calls,20);
});

test('Delivery HTML/error payload cannot become a successful empty day',async()=>{
 const source=extract('async function fetchDeliveryTaskRowsForDate(','async function buildDailyRouteFromDeliveryAdmin');
 const context=vm.createContext({URLSearchParams,deliveryAdminJson:async()=>({raw:'synthetic-login-html'})});vm.runInContext(source,context);
 await assert.rejects(vm.runInContext("fetchDeliveryTaskRowsForDate('2026-10-31')",context),/DELIVERY_TASK_PAGE_INVALID/);
 context.deliveryAdminJson=async()=>({ok:false,data:[]});await assert.rejects(vm.runInContext("fetchDeliveryTaskRowsForDate('2026-10-31')",context),/DELIVERY_TASK_PAGE_FAILED/);
 context.deliveryAdminJson=async()=>({data:{content:[]}});assert.equal((await vm.runInContext("fetchDeliveryTaskRowsForDate('2026-10-31')",context)).length,0);
});
test('actual unassigned stops remain visible without a fabricated base vehicle',async()=>{
 const source=extract('async function phase2bTodayStatus(','app.get("/api/map-phase2b/preview/status"');
 // Extract the function only, independent of following route declarations.
 const functionSource=source.slice(0,source.lastIndexOf('\n}')+2);
 const context=vm.createContext({phase2bTodayCache:new Map(),phase2bTodayInflight:new Map(),fetchDeliveryTaskRowsForDate:async()=>[{customerCode:'S970004'}],deliveryTaskVehicle:()=>'',phase2bTodayVehicleSummary:(vehicle,rows,date)=>({vehicle,date,stops:rows})});
 vm.runInContext(functionSource,context);const value=await vm.runInContext("phase2bTodayStatus('2026-10-31')",context);
 assert.equal(value.vehicles.length,1);assert.equal(value.vehicles[0].vehicle,'');assert.equal(value.vehicles[0].stops[0].customerCode,'S970004');
});
