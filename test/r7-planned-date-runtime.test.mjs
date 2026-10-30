import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the repository's real controller, with only its I/O and render edges
// replaced. No SDK, browser session, remote API, timer or source write is used.
const runtime=fs.readFileSync(new URL('../public/map-phase2b-runtime.js',import.meta.url),'utf8');
const start=runtime.indexOf('  async function changeSelectedDate(');
const end=runtime.indexOf('  function ensureDateVehicles()',start);
assert(start>=0&&end>start,'actual runtime date controller must be available');
const controller=runtime.slice(start,end);
const plannedDate='2026-11-01',today='2026-10-31';
function harness(response,{error}={}){
 const nodes=new Map(),calls=[],replacements=[];
 const element=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',title:'',value:'',max:today,open:false,dataset:{},classList:{add(){},remove(){},toggle(){}},setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];}});return nodes.get(id);};
 const state={mode:'BASE_60D',selectedDate:'',selectedVehicles:[],routeDate:'',searchRequestId:0,detailRequestId:0,todayRequestId:0,routeRequestId:0,currentRows:[],routeRows:[]};
 const c={state,$:element,generalMap:true,dateReady:false,datedSourceDate:'',dailyMeta:null,initialRequestId:0,initialTimer:null,periodTimer:null,periodRequestId:0,dateRequestId:0,operationStops:[],periodVehicleScope:'all',hybridUiReady:Promise.resolve(null),
  localDate:()=>today,clearTimeout(){},resetRoadRoute(){},cancelManualRoadRoute(){},switchMode:mode=>{state.mode=mode;},syncModeUi(){},setSelectedVehicles(){},refreshVehicleUi(){},refreshDriverMaster:async()=>{},updateDateRange(){},closeClusterPanel(){},clearMap(){},renderRunList(){},clearSelection(){},clearNewAreaBatch(){},updateOperationMetrics(){},
  window:{dispatchEvent(){},MAP_ROLLING_DATE_INDEX_ENABLED:false},CustomEvent:class {constructor(type,init){this.type=type;this.detail=init?.detail;}},
  fetchJson:async(url,options)=>{calls.push({url,channel:options?.channel});if(error)throw error;return structuredClone(response);},
  replaceStoreSnapshot:(rows,meta)=>{replacements.push({rows,meta});state.currentRows=rows;},ensureDateVehicles(){},loadBaseMap:async()=>{},loadOperationStatus:async()=>{},primarySelectedVehicle:()=>'',selectedVehicles:()=>[],isSilentRequestError:()=>false,
 };
 const context=vm.createContext(c);vm.runInContext(controller,context);
 return {context,nodes,calls,replacements,run:date=>vm.runInContext(`changeSelectedDate(${JSON.stringify(date)})`,context),element};
}
const unobserved=()=>({ok:false,data:[],error:'PLANNED_SOURCE_UNOBSERVED',meta:{date:plannedDate,planned:true,sourceObserved:false,complete:false}});
const observed=()=>({ok:true,data:[{customerCode:'S970001',customerName:'SYNTHETIC_ONLY',deliveryDate:plannedDate,vehicle:'101',lat:37.5,lng:127}],meta:{date:plannedDate,planned:true,sourceObserved:true,complete:true,source:'SYNTHETIC_DATED_SOURCE'}});
function assertOnePlannedRequest(h){assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,`/api/map-phase2b/preview/assignments?date=${plannedDate}`);assert.equal(h.calls[0].channel,'selected-date');}
function assertNotPromoted(h){assert.equal(h.context.dateReady,false);assert.equal(h.context.datedSourceDate,'');assert.equal(h.replacements.length,0);assert.equal(h.context.state.currentRows.length,0);}

test('actual date controller requests future scheduled date once instead of rejecting it in the UI',async()=>{
 const h=harness(unobserved());await h.run(plannedDate);assertOnePlannedRequest(h);assert.equal(h.context.state.selectedDate,plannedDate);
 for(const id of ['#selectedDate','#date','#mobileDate']){assert.equal(h.element(id).value,plannedDate);assert.equal(h.element(id).max,'');}
});
test('unobserved scheduled source stays pending without advancing rows or ready state',async()=>{
 const h=harness(unobserved());await h.run(plannedDate);assertOnePlannedRequest(h);assertNotPromoted(h);
 const text=h.element('#freshnessState').textContent+' '+h.element('#mapStatusSub').textContent;assert.match(text,/예정/);assert.match(text,/미|대기|아직|준비|관측|확인/);assert.doesNotMatch(text,/조회 완료/);
});
test('planned-source-unobserved rejection is pending rather than employee logout or success',async()=>{
 const h=harness(null,{error:Object.assign(Error('PLANNED_SOURCE_UNOBSERVED'),{code:'PLANNED_SOURCE_UNOBSERVED',status:202})});await h.run(plannedDate);assertOnePlannedRequest(h);assertNotPromoted(h);
 assert.match(h.element('#freshnessState').textContent+' '+h.element('#mapStatusSub').textContent,/예정/);
});
test('verified scheduled rows preserve planned classification and matching source date',async()=>{
 const h=harness(observed());await h.run(plannedDate);assertOnePlannedRequest(h);assert.equal(h.context.dateReady,true);assert.equal(h.context.datedSourceDate,plannedDate);assert.equal(h.replacements.length,1);assert.equal(h.replacements[0].rows.length,1);assert.equal(h.context.dailyMeta.planned,true);assert.equal(h.context.dailyMeta.sourceObserved,true);
 assert.match(h.element('#freshnessState').textContent+' '+h.element('#mapStatusSub').textContent,/예정/);
});
test('unobserved source cannot be promoted merely because an echoed date and complete flag are present',async()=>{
 const p=observed();p.meta.sourceObserved=false;const h=harness(p);await h.run(plannedDate);assertOnePlannedRequest(h);assertNotPromoted(h);
});
test('wrong-source day and impossible calendar dates never become ready data',async()=>{
 const p=observed();p.meta.date=today;const h=harness(p);await h.run(plannedDate);assertOnePlannedRequest(h);assertNotPromoted(h);
 const invalid=harness(observed());await invalid.run('2026-02-30');assert.equal(invalid.calls.length,0);assert.equal(invalid.context.state.selectedDate,'');assertNotPromoted(invalid);
});
