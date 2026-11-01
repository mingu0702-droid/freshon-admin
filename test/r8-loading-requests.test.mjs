import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';
const runtime=fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8');
const source=runtime.slice(runtime.indexOf('  async function fetchJson('),runtime.indexOf('  function showMobileMap()'));
function fixture(){
 const calls=[],pending=[],requestControllers=new Map(),memoryResponses=new Map();
 const context=vm.createContext({URL,location:{href:'https://localhost/opsmap/'},AbortController,Map,Symbol,Date,performance,requestControllers,memoryResponses,apiDiagnostics:new Map(),setTimeout,clearTimeout,Phase2bUi:{requestError:(error,details)=>Object.assign(error,details,{silent:details.stale||details.aborted})},fetch:(url,options)=>new Promise((resolve,reject)=>{
  calls.push(url);pending.push({resolve:(status=200,value={ok:true})=>resolve({status,ok:status===200,headers:{get:()=>null},json:async()=>value}),reject});options.signal.addEventListener('abort',()=>reject(Object.assign(Error('ABORTED'),{name:'AbortError'})));
 })});vm.runInContext(source,context);
 return {calls,pending,requestControllers,read:(url,options)=>context.fetchJson(url,options)};
}
test('identical concurrent general reads share one request and completed requests do not stay in flight',async()=>{
 const f=fixture(),a=f.read('/api/map-phase2b/preview/period-status'),b=f.read('/api/map-phase2b/preview/period-status');
 assert.equal(f.calls.length,1);f.pending[0].resolve();assert.deepEqual(await a,await b);assert.equal(f.requestControllers.size,0);
 const c=f.read('/api/map-phase2b/preview/period-status');assert.equal(f.calls.length,2);f.pending[1].resolve();await c;
});
test('different period/date URL cancels the earlier channel and never returns stale rows',async()=>{
 const f=fixture(),a=f.read('/api/map-phase2b/preview/period?startDate=2026-10-23',{channel:'period'});const rejected=assert.rejects(a,error=>error.silent===true);
 const b=f.read('/api/map-phase2b/preview/period?startDate=2026-10-24',{channel:'period'});assert.equal(f.calls.length,2);f.pending[1].resolve(200,{date:'2026-10-24'});assert.equal((await b).date,'2026-10-24');await rejected;assert.equal(f.requestControllers.size,0);
});
test('protected and header-dependent requests do not share results across callers',async()=>{
 for(const [url,options]of [['/api/map-phase2b/private/customer-detail?customerCode=S970001',{}],['/api/map-phase2b/preview/status',{headers:{'x-synthetic-scope':'one'}}]]){
  const f=fixture(),a=f.read(url,options),rejected=assert.rejects(a,error=>error.silent===true),b=f.read(url,options);assert.equal(f.calls.length,2);f.pending[1].resolve();await b;await rejected;
 }
});
test('failed shared read is evicted and an explicit retry can make a fresh request',async()=>{
 const f=fixture(),a=f.read('/api/map-phase2b/preview/period-status'),b=f.read('/api/map-phase2b/preview/period-status');const failures=Promise.all([assert.rejects(a),assert.rejects(b)]);f.pending[0].resolve(503,{error:'MODEL_UNAVAILABLE'});await failures;assert.equal(f.requestControllers.size,0);
 const c=f.read('/api/map-phase2b/preview/period-status');assert.equal(f.calls.length,2);f.pending[1].resolve(200,{ready:false});assert.equal((await c).ready,false);
});
test('pending period status checks stop after three delayed retries instead of polling forever',async()=>{
 const selected=runtime.slice(runtime.indexOf('  function pendingPeriodDelay('),runtime.indexOf('  async function selectLatestRoute()'));
 const timers=[],elements=new Map();let reads=0;
 const context=vm.createContext({generalMap:false,recentPeriodMode:true,initialRequestId:0,periodRequestId:0,dateRequestId:0,initialTimer:null,periodTimer:null,dateReady:false,modelStatus:null,state:{mode:'BASE_60D'},window:{MAP_ROLLING_DATE_INDEX_ENABLED:true},hybridUiReady:Promise.resolve({readPeriodStatus:async()=>{reads++;return {ready:false};}}),clearTimeout(){},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},switchMode(){},syncModeUi(){},setPeriodViewState(){},renderPeriodStoreList(){},$:key=>{if(!elements.has(key))elements.set(key,{});return elements.get(key);},isSilentRequestError:()=>false});
 vm.runInContext(selected,context);await context.initializePeriod();const delays=[];
 while(timers.length){const t=timers.shift();delays.push(t.ms);t.fn();for(let n=0;n<10;n++)await Promise.resolve();assert(reads<=4);}
 assert.deepEqual(delays,[15000,30000,60000]);assert.equal(reads,4);assert.match(elements.get('#freshnessState').textContent,/기간 적용으로 다시 확인/);
 await context.initializePeriod();assert.equal(reads,5);assert.equal(timers[0].ms,15000);
});
