import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/opsmap/phase2b-ui-helpers.js';
const source=fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8');
const enrich=source.slice(source.indexOf('  async function enrichStoreDetail('),source.indexOf('  function scrollSelectedInside('));
const latest=source.slice(source.indexOf('  function hasLatestStoreAddress('),source.indexOf('  function readSelectedStoreDetail('));
const code='S990001',date='2026-11-02';
async function render(overrides={}, {stage=false,refresh}={}){
 const row={customerCode:code,vehicle:'101',lastDeliveryDate:date};
 const nodes=Object.fromEntries(['#detailAddressLabel','#detailAddressValue','#detailDeliveryDaysLabel','#detailDeliveryDaysValue','#detailAddressRegion'].map(id=>[id,{textContent:'',hidden:true}]));
 Object.assign(nodes['#detailDeliveryDaysLabel'],{hidden:false});
 Object.assign(nodes['#detailDeliveryDaysValue'],{textContent:'월 수',hidden:false});
 const address=nodes['#detailBasicAddress']={textContent:'',dataset:{state:'loading'}};
 const status=nodes['#detailAddressStatus']={textContent:'',hidden:true,dataset:{}};
 const facts={dataset:{}},requests=[];
 const exact={customerCode:code,detailDate:null,sourceBasis:'CURRENT_CUSTOMER_LOOKUP',locationState:'SOURCE_ROW',address:'SYNTHETIC_ADDRESS',detailAddress:'SYNTHETIC_DETAIL',detailAddressState:'PRESENT',deliveryPattern:'월수금',...overrides};
 const context=vm.createContext({state:{mode:'BASE_60D',selected:row,selectedDate:date,detailRequestId:0},snapshotMeta:{},liveAddressLocations:null,fetchJson:async()=>({data:exact}),document:{body:{dataset:{mapStaffState:'authenticated'}}},Phase2bUi:globalThis.Phase2bUi,$:s=>s==='#detail .dotDetailFacts'?facts:nodes[s]||{textContent:''},window:{},positionDetailPopup(){},isSilentRequestError:()=>false,row,
  stageAddressBatchEnabled:()=>stage,storeDetailDate:()=>date,storeDetailLatest:Promise.resolve(),
  async readSelectedStoreDetail(_row,_date,fresh=false){requests.push(fresh);return fresh?refresh({address,status}):{data:exact};}});
 vm.runInContext(latest+enrich,context);await vm.runInContext('enrichStoreDetail(row,null)',context);return {nodes,facts,address,status,requests};
}
for(const basis of ['CURRENT_CUSTOMER_LOOKUP','DATED_CUSTOMER_LOOKUP'])test('customer enrichment retains the already rendered fixed schedule for '+basis,async()=>{
 const {nodes,facts}=await render({sourceBasis:basis,detailDate:basis==='DATED_CUSTOMER_LOOKUP'?date:null});
 assert.equal(nodes['#detailDeliveryDaysValue'].textContent,'월 수');assert.equal(nodes['#detailDeliveryDaysLabel'].hidden,false);assert.equal(nodes['#detailDeliveryDaysValue'].hidden,false);
 assert.equal(facts.dataset.sourceBasis,basis);assert.equal(facts.dataset.deliveryPattern,'월수금');
});
for(const [name,data]of [
 ['fixed-dispatch weekdays',{deliveryPattern:null,weekdays:{Mon:'101',Wed:'101',Fri:'101'}}],
 ['empty value',{deliveryPattern:' '}],
 ['unconfirmed value',{deliveryPattern:'미확인'}],
 ['unconfirmed location',{locationState:'UNCONFIRMED'}],
 ['stored historical projection',{sourceBasis:'STORED_DAY',sourceDate:date,detailDate:date}]
])test(name+' cannot replace the verified fixed weekdays',async()=>{
 const {nodes,facts}=await render(data);assert.equal(nodes['#detailDeliveryDaysLabel'].hidden,false);assert.equal(nodes['#detailDeliveryDaysValue'].hidden,false);assert.equal(nodes['#detailDeliveryDaysValue'].textContent,'월 수');
 assert.equal(facts.dataset.sourceBasis,data.sourceBasis||'CURRENT_CUSTOMER_LOOKUP');
});
const saved={sourceBasis:'STAGE_VERIFIED_REGISTRY',sourceDate:'2026-11-07',detailDate:date,address:'SYNTHETIC_SAVED'};
test('the selected staff card replaces its saved address automatically and removes the pending label',async()=>{
 const result=await render(saved,{stage:true,refresh:({address,status})=>{
  assert.equal(address.textContent,'SYNTHETIC_SAVED');assert.equal(status.dataset.currentness,'checking');
  return {data:{customerCode:code,sourceBasis:'CURRENT_CUSTOMER_LOOKUP',detailDate:null,locationState:'SOURCE_ROW',address:'SYNTHETIC_FRESH'}};
 }});
 assert.deepEqual(result.requests,[false,true]);assert.equal(result.address.textContent,'SYNTHETIC_FRESH');
 assert.equal(result.status.hidden,true);assert.equal(result.status.dataset.currentness,'confirmed');
 assert.doesNotMatch(source,/detailAddressRetry|최신 주소 조회/);
});
test('the saved address survives an upstream error or response that cannot prove freshness',async()=>{
 for(const refresh of [()=>{throw Error('DETAIL_UPSTREAM_TIMEOUT');},()=>({data:{
   customerCode:code,detailDate:null,sourceBasis:'CURRENT_CUSTOMER_LOOKUP',locationState:'SOURCE_ROW',address:'SYNTHETIC_UNVERIFIED'
 },meta:{cache:{stale:true}}})]){
  const result=await render(saved,{stage:true,refresh});
  assert.equal(result.address.textContent,'SYNTHETIC_SAVED');
  assert.equal(result.status.textContent,'최신 주소 미확인');assert.equal(result.status.hidden,false);
 }
});
test('empty or withheld detail address is omitted while private state metadata survives',async()=>{
 for(const state of ['EMPTY','WITHHELD','UNOBSERVED']){const {nodes,facts}=await render({detailAddress:null,detailAddressState:state});assert.equal(nodes['#detailAddressValue'].hidden,true);assert.equal(nodes['#detailAddressLabel'].hidden,true);assert.equal(facts.dataset.detailAddressState,state);}
});
