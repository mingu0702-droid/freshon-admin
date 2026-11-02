import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8'),fn=src.slice(src.indexOf('  async function enrichStoreDetail('),src.indexOf('  function scrollSelectedInside('));
for(const kind of ['BASE_ASSIGNMENT_ENRICHED','DAILY_VEHICLE_CHANGED','LOGOUT','OTHER_CUSTOMER','OTHER_MODE'])test('basic Customer detail race: '+kind,async()=>{
 const row={customerCode:'S990001',vehicle:'',lastDeliveryDate:'2026-11-02'},address={textContent:'LOADING'},facts={dataset:{},querySelectorAll:()=>[{textContent:'주소',nextElementSibling:address}],append(){}};let resolve;
 const c=vm.createContext({state:{mode:kind==='DAILY_VEHICLE_CHANGED'?'DATE_ROUTE':'BASE_60D',selected:row,selectedDate:'2026-11-02',detailRequestId:0},snapshotMeta:{},fetchJson:()=>new Promise(r=>resolve=r),document:{body:{dataset:{mapStaffState:'authenticated'}},createElement:()=>({})},Phase2bUi:{storeDetailMatches:(d,code,date)=>d.customerCode===code&&d.detailDate===date},$:(s)=>s==='#detail .dotDetailFacts'?facts:{textContent:''},window:{},positionDetailPopup(){},isSilentRequestError:()=>false,row});
 vm.runInContext(fn,c);const work=vm.runInContext('enrichStoreDetail(row,null)',c);
 c.state.selected.vehicle='101';if(kind==='LOGOUT')c.document.body.dataset.mapStaffState='anonymous';if(kind==='OTHER_CUSTOMER')c.state.selected={customerCode:'S990002'};if(kind==='OTHER_MODE')c.state.mode='DATE_ROUTE';
 resolve({data:{customerCode:'S990001',detailDate:'2026-11-02',address:'SYNTHETIC_CURRENT_ADDRESS',detailAddressState:'EMPTY'}});await work;
 assert.equal(address.textContent,kind==='BASE_ASSIGNMENT_ENRICHED'?'SYNTHETIC_CURRENT_ADDRESS':'LOADING');
});
