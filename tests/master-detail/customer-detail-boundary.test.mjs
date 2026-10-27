import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {staffStoreDetail,staffCustomerDetail} from '../../src/mapStaffDetail.js';
const runtime=fs.readFileSync(new URL('../../public/map-phase2b-runtime.js',import.meta.url),'utf8');
const functionText=runtime.slice(runtime.indexOf('  async function enrichStoreDetail('),runtime.indexOf('  function scrollSelectedInside('));
const identity={customerCode:'S970007',date:'2026-10-23'};
const source={customerCode:'S970007',customerName:'합성매장',customerAddress:'서울특별시 합성로 123',detailAddress:'2층',confirmedVehicle:'용01',password:'SECRET',accessMemo:'출입방법: TEST'};
test('selected Customer field allowlist rejects identity mismatch and mixed security prose',()=>{
 const result=staffStoreDetail(source,identity);
 assert.equal(result.address,source.customerAddress);assert.equal(result.detailAddress,'2층');
 assert.equal(result.customerName,'합성매장');assert.equal(result.businessCoverageVerified,false);
 for(const key of ['password','accessMemo','confirmedVehicle','vehicle'])assert.equal(key in result,false);
 assert.equal(staffStoreDetail({...source,customerAddress:'합성로 123 출입비밀번호 1234'},identity).address,null);
 assert.throws(()=>staffStoreDetail({...source,customerCode:'S970008'},identity));
 assert.equal(staffCustomerDetail(source,identity).customerCode,'S970007');
});
function setup(mode='BASE_60D'){
 const row={customerCode:'S970007',vehicle:mode==='DATE_ROUTE'?'용01':'101',address:'',lastDeliveryDate:'2026-10-23',lat:37,lng:127};
 const state={detailRequestId:0,mode,selectedDate:'2026-10-23',selected:row};
 const title={textContent:'합성명'},address={textContent:'주소 미확인'},label={textContent:'주소',nextElementSibling:address};
 const facts={querySelectorAll:()=>[label],children:[],append(...nodes){this.children.push(...nodes);}};
 const document={body:{dataset:{mapStaffState:'authenticated'}},createElement:()=>({textContent:''})};
 const calls=[];let answer=async()=>({data:staffStoreDetail(source,identity)});
 const context={state,document,snapshotMeta:{latestDate:'2026-10-23'},$:selector=>selector.includes('storeName')?title:selector.includes('dotDetailFacts')?facts:null,
 fetchJson:async(url,options)=>{calls.push({url,options});return answer();},positionDetailPopup(){},isSilentRequestError:error=>error.name==='AbortError'};
 vm.runInNewContext(functionText+';this.run=enrichStoreDetail;',context);
 return {row,state,document,calls,title,address,facts,run:()=>context.run(row),setAnswer:fn=>answer=fn};
}
test('BASE and dated selection use existing private handler once ttl0 and update DOM only',async()=>{
 for(const mode of ['BASE_60D','DATE_ROUTE']){const c=setup(mode);const before=JSON.stringify(c.row);await c.run();assert.equal(c.calls.length,1);assert.match(c.calls[0].url,/private\/customer-detail\?view=store/);assert.equal(c.calls[0].options.ttl,0);assert.equal(c.address.textContent,source.customerAddress);assert.equal(c.facts.children[1].textContent,'2층');assert.equal(JSON.stringify(c.row),before);}
 assert.match(runtime,/if \(!skipEnrich && row.customerCode\) enrichStoreDetail/);
});
test('selection change and logout reject late location data',async()=>{
 for(const logout of [false,true]){const c=setup();let resolve;c.setAnswer(()=>new Promise(r=>resolve=r));const pending=c.run();if(logout)c.document.body.dataset.mapStaffState='signed-out';else c.state.selected={customerCode:'S970006'};resolve({data:staffStoreDetail(source,identity)});await pending;assert.equal(c.address.textContent,'주소 미확인');assert.equal(c.facts.children.length,0);}
});

test('general map without selected day uses observed saved-model date, never empty-date fallback',async()=>{
 const c=setup();c.row.lastDeliveryDate='';c.state.selectedDate='';await c.run();
 assert.match(c.calls[0].url,/date=2026-10-23$/);assert.equal(c.address.textContent,source.customerAddress);
});
test('wrong code/date response and read failure never populate source addresses',async()=>{
 for(const overrides of [{customerCode:'S970006'},{detailDate:'2026-10-22'}]){const c=setup();c.setAnswer(async()=>({data:{...staffStoreDetail(source,identity),...overrides}}));await c.run();assert.equal(c.address.textContent,'주소 미확인');}
 const c=setup();c.setAnswer(async()=>{throw Error('synthetic read failure');});await c.run();assert.match(c.address.textContent,/조회 (실패|지연)/);assert.equal(c.row.address,'');
});
test('existing route keeps exact staff gate and Customer action, no Snapshot dependency in selected store branch',()=>{
 const text=fs.readFileSync(new URL('../../src/productionMapIntegration.js',import.meta.url),'utf8');
 assert.match(text,/app.use\('\/api\/map-phase2b\/private',mapStaff.requireStaff\)/);
 assert.match(text,/storeView\s*\?\s*['"]customerDetail['"]\s*:\s*['"]staffCustomerDetail['"]/);
 assert.match(text,/useCache:\s*false,\s*privateRead:\s*true/);
 assert.match(text,/return mapStaff\.requireStaff\(req,res,\(\)=>res\.set\('Cache-Control','private, no-store'\)\.json\(\{ok:true,data:result.value/);
 assert.match(text,/if \(req.query.view && !storeView\)/);
});
