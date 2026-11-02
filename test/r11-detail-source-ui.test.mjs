import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/opsmap/phase2b-ui-helpers.js';
const source=fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8');
const enrich=source.slice(source.indexOf('  async function enrichStoreDetail('),source.indexOf('  function scrollSelectedInside('));
const code='S990001',date='2026-11-02';
async function render(overrides={}){
 const row={customerCode:code,vehicle:'101',lastDeliveryDate:date};
 const nodes=Object.fromEntries(['#detailAddressLabel','#detailAddressValue','#detailDeliveryDaysLabel','#detailDeliveryDaysValue','#detailAddressRegion'].map(id=>[id,{textContent:'',hidden:true}]));
 const address={textContent:''},facts={dataset:{},querySelectorAll:()=>[{textContent:'주소',nextElementSibling:address}]};
 const exact={customerCode:code,detailDate:null,sourceBasis:'CURRENT_CUSTOMER_LOOKUP',locationState:'SOURCE_ROW',address:'SYNTHETIC_ADDRESS',detailAddress:'SYNTHETIC_DETAIL',detailAddressState:'PRESENT',deliveryPattern:'월수금',...overrides};
 const context=vm.createContext({state:{mode:'BASE_60D',selected:row,selectedDate:date,detailRequestId:0},snapshotMeta:{},fetchJson:async()=>({data:exact}),document:{body:{dataset:{mapStaffState:'authenticated'}}},Phase2bUi:globalThis.Phase2bUi,$:s=>s==='#detail .dotDetailFacts'?facts:nodes[s]||{textContent:''},window:{},positionDetailPopup(){},isSilentRequestError:()=>false,row});
 vm.runInContext(enrich,context);await vm.runInContext('enrichStoreDetail(row,null)',context);return {nodes,facts,address};
}
for(const basis of ['CURRENT_CUSTOMER_LOOKUP','DATED_CUSTOMER_LOOKUP'])test('Customer delivery pattern stays before driver for '+basis,async()=>{
 const {nodes,facts}=await render({sourceBasis:basis,detailDate:basis==='DATED_CUSTOMER_LOOKUP'?date:null});
 assert.equal(nodes['#detailDeliveryDaysValue'].textContent,'월수금');assert.equal(nodes['#detailDeliveryDaysLabel'].hidden,false);assert.equal(nodes['#detailDeliveryDaysValue'].hidden,false);
 assert.equal(facts.dataset.sourceBasis,basis);assert.equal(facts.dataset.deliveryPattern,'월수금');
});
for(const [name,data]of [
 ['fixed-dispatch weekdays',{deliveryPattern:null,weekdays:{Mon:'101',Wed:'101',Fri:'101'}}],
 ['empty value',{deliveryPattern:' '}],
 ['unconfirmed value',{deliveryPattern:'미확인'}],
 ['unconfirmed location',{locationState:'UNCONFIRMED'}],
 ['stored historical projection',{sourceBasis:'STORED_DAY',sourceDate:date,detailDate:date}]
])test(name+' cannot become delivery weekdays',async()=>{
 const {nodes,facts}=await render(data);assert.equal(nodes['#detailDeliveryDaysLabel'].hidden,true);assert.equal(nodes['#detailDeliveryDaysValue'].hidden,true);assert.equal(nodes['#detailDeliveryDaysValue'].textContent,'');
 assert.equal(facts.dataset.sourceBasis,data.sourceBasis||'CURRENT_CUSTOMER_LOOKUP');
});
test('empty or withheld detail address is omitted while private state metadata survives',async()=>{
 for(const state of ['EMPTY','WITHHELD','UNOBSERVED']){const {nodes,facts}=await render({detailAddress:null,detailAddressState:state});assert.equal(nodes['#detailAddressValue'].hidden,true);assert.equal(nodes['#detailAddressLabel'].hidden,true);assert.equal(facts.dataset.detailAddressState,state);}
});
