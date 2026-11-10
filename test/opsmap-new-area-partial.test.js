import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/opsmap/map-period-ui.js';
import '../public/opsmap/phase2b-ui-helpers.js';
import '../public/opsmap/manual-waypoints.js';
import '../public/opsmap/new-area-requests.js';
import {batchDomNode,batchDomTemplate} from './fixtures/new-area-dom.mjs';

const source = fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8');
const exposure = `
  window.test={state,judgeNewAreaPoint,judgeNewAreaRow,runNewArea,clearNewAreaBatch,exportNewArea,
    setup(rows=[],meta={},snapshot=[]){state.rangeStart='2026-09-01';state.rangeEnd='2026-11-02';dateReady=false;
      periodRows=rows;periodMeta={startDate:state.rangeStart,endDate:state.rangeEnd,complete:false,...meta};
      latestSnapshotRows=snapshot;allStores=rows;storesByCode.clear();coordinateByCode.clear();
      for(const row of [...snapshot,...rows]){storesByCode.set(row.customerCode,row);coordinateByCode.set(row.customerCode,row);}
      for(const row of rows)if(row.vehicle)baseVehicles.set(row.customerCode,{baseVehicle:row.vehicle});},
    ready(){dateReady=true;},generation(value){snapshotMeta={source:'STAGE_VERIFIED_REGISTRY',sourceGeneration:value};},manual:point=>manualDraft.add(point),
    setJudge:fn=>judgeNewAreaRow=fn};
})();`;
export const newAreaTestRuntime = source.slice(0,source.indexOf('\n  initVehicles();')) + exposure;
const near = {customerCode:'S990001',customerName:'합성 인근 배송처',address:'경기도 화성시 합성로 1',lat:37.2,lng:127,vehicle:'101',deliveryPattern:'월수금',lastDeliveryDate:'2026-11-02'};
const completed={...near,history:[
  {kind:'COMPLETED',vehicle:'101',center:'osan',deliveryDate:'2026-11-02',address:near.address},
  {kind:'ASSIGNED',vehicle:'122',center:'osan',deliveryDate:'2026-10-31',address:near.address},
  {kind:'COMPLETED',vehicle:'202',center:'osan',deliveryDate:'2026-10-31',address:'경기도 화성시 다른로 1'}
]};
function fixture({location,fetch} = {}) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,batchDomNode());return nodes.get(id);};
  let calls=0;
  const window={addEventListener(){},VEHICLE_AREA_DATA:{vehicles:[]},ManualWaypoints:globalThis.ManualWaypoints,KAKAO_MAP_CONFIG:{allowExternalAddressLookup:false},kakaoGeocoder:{addressSearch(){calls++;throw Error('EXTERNAL_LOOKUP_FORBIDDEN');}}};
  window.location=location;
  const ctx=vm.createContext({window,location,fetch,document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},createElement:batchDomTemplate,body:node('body')},MapPeriodUi:globalThis.MapPeriodUi,Phase2bUi:globalThis.Phase2bUi,NewAreaRequests:globalThis.NewAreaRequests,Map,Set,URL,URLSearchParams,AbortController,AbortSignal,Date,Intl,Number,performance,setTimeout,clearTimeout,innerWidth:1440});
  vm.runInContext(newAreaTestRuntime,ctx);
  return {...window.test,node,externalCalls:()=>calls,window};
}
test('a partial period shows only recorded weekdays while explicit exclusions still apply',()=>{
  const f=fixture();f.setup([completed],{segmented:true,displayComplete:true,aggregateComplete:false,coverageComplete:false});
  const row=f.judgeNewAreaPoint({address:'경기도 화성시 합성로 2'},{lat:37.201,lng:127});
  assert.equal(row.decision,'검토');assert.equal(row.evidenceCount,1);assert.equal(row.deliveryDays,'월수금');assert.match(row.evidence,/도로 진입 판정 아님/);
  assert.deepEqual(Array.from(Phase2bUi.vehiclesAtRadius(row.actualVehicles,30),item=>[item.vehicle,item.weekdays.join('')]),[['101','월']]);
  assert.equal(f.judgeNewAreaPoint({address:'제주특별자치도 합성로 1'},null).reason,'제주도');
  assert.equal(f.judgeNewAreaPoint({address:'서울특별시 합성아파트 101동 102호'},{lat:37.5,lng:127}).reason,'아파트');
  assert.equal(f.judgeNewAreaPoint({address:'서울특별시 합성로 1',customer:'동선외'},{lat:37.5,lng:127}).decision,'X');
  assert.equal(f.judgeNewAreaPoint({address:'서울특별시 합성상가 101동 102호'},{lat:37.5,lng:127}).decision,'검토');
});
test('500m alone is insufficient; a complete source with actual route and weekday enables O',()=>{
  const f=fixture();f.setup([near],{complete:true,coverageComplete:true,missingCoordinate:0});f.ready();
  assert.equal(f.judgeNewAreaPoint({address:near.address},{lat:37.201,lng:127}).decision,'검토');
  f.setup([{...completed,deliveryPattern:'월화수목금토'}],{complete:true,coverageComplete:true,missingCoordinate:0});f.ready();
  const qualified=f.judgeNewAreaPoint({address:near.address},{lat:37.201,lng:127});
  assert.equal(qualified.decision,'O');assert.equal(qualified.possibleWeekdays.join(''),'월');assert.equal(qualified.deliveryDays,'');
  assert.match(qualified.evidence,/배송 수락 및 차량 진입은 별도 확인/);
  assert.equal(f.judgeNewAreaPoint({address:near.address,customer:'지하 하역장'},{lat:37.201,lng:127}).decision,'검토');
  assert.equal(f.judgeNewAreaPoint({address:'경상북도 안동시 합성로 1'},{lat:36.56,lng:128.73}).decision,'검토');
  f.setup([near],{complete:true,segmented:true,aggregateComplete:false,coverageComplete:true});f.ready();
  assert.equal(f.judgeNewAreaPoint({address:near.address},{lat:37.201,lng:127}).decision,'검토');
});
test('nearest registered store can be an undelivered store outside the filtered delivery rows',()=>{
  const f=fixture();
  f.setup([near],{},[{...near,customerCode:'S990002',customerName:'배송 이력 없는 매장',lat:37.2015,lastDeliveryDate:''},
    {...near,customerCode:'S990003',customerName:'배송 전용',lat:37.2016,deliveryOnly:true}]);
  const row=f.judgeNewAreaPoint({address:'경기도 화성시 합성로 2'},{lat:37.2016,lng:127});
  assert.equal(row.nearestStore,'배송 이력 없는 매장');
  assert.equal(row.nearestStoreCode,'S990002');assert.equal(row.nearestDistanceMeters,11);
});
test('archive coverage from another center cannot turn an observed visit into a positive decision',()=>{
  const f=fixture();f.setup([],{},[near]);f.state.rangeStart='2026-08-05';
  const archive={start:f.state.rangeStart,end:f.state.rangeEnd,days:90,unknownDays:0,vehicleStatus:'READY',
    vehicles:[{...near,vehicle:'202',center:'honam',mask:2}],observed:[],fixed:[]};
  const point={lat:37.201,lng:127};
  const judge=observedByCenter=>f.judgeNewAreaPoint({address:near.address},point,{archive:{...archive,observedByCenter}});
  assert.equal(judge({osan:90,honam:76}).decision,'검토');
  assert.equal(judge({osan:90,honam:90}).possibleWeekdays.join(''),'월');
});
test('wrong-period rows never count, while dated snapshot delivery remains partial evidence',()=>{
  const f=fixture();f.setup([{...near,customerCode:'S990009'}],{startDate:'2025-01-01'},[near,{...near,customerCode:'S990002',lastDeliveryDate:'2025-01-01'}]);
  const row=f.judgeNewAreaPoint({address:near.address},{lat:37.2,lng:127});assert.equal(row.evidenceCount,1);assert.equal(row.decision,'검토');
});
test('empty partial page still uses dated snapshot evidence and does not revive conflicted same-code rows',()=>{
  const f=fixture();f.setup([],{complete:false},[near]);
  assert.equal(f.judgeNewAreaPoint({address:near.address},{lat:37.2,lng:127}).evidenceCount,1);
  f.setup([{...near,coordinateStatus:'CONFLICT'}],{complete:false},[near]);
  assert.equal(f.judgeNewAreaPoint({address:near.address},{lat:37.2,lng:127}).evidenceCount,0);
});
test('conflicting, blank and out-of-country coordinates cannot become nearby evidence',()=>{
  const f=fixture();f.setup([{...near,coordinateStatus:'CONFLICT'},{...near,lat:null},{...near,lat:0}]);
  const row=f.judgeNewAreaPoint({address:near.address},{lat:37.2,lng:127});assert.equal(row.evidenceCount,0);
  assert.equal(f.judgeNewAreaPoint({address:near.address},{lat:NaN,lng:127}).reason,'주소 확인 필요');
});
test('customer code, stored address and existing manual coordinate input require zero lookup calls',async()=>{
  const f=fixture();f.setup([near]);
  assert.equal((await f.judgeNewAreaRow({address:near.customerCode,customer:''})).evidenceCount,1);
  assert.equal((await f.judgeNewAreaRow({address:near.address,customer:''})).evidenceCount,1);
  f.manual({label:'대구광역시 동구 합성로 2',lat:35.9,lng:128.65});
  assert.equal((await f.judgeNewAreaRow({address:'대구광역시 동구 합성로 2'})).coordinateSource,'MANUAL_WAYPOINT');
  const unknown=await f.judgeNewAreaRow({address:'서울특별시 영등포구 합성로 2'});assert.equal(unknown.reason,'주소 확인 필요');assert.equal(unknown.lookupError,undefined);
  assert.equal(f.externalCalls(),0);
});
test('confirmed manual pin projection is reused without pin writes',async()=>{
  const f=fixture();f.setup([{...near,lat:null,lng:null}]);f.window.MapManualPins={apply(row){row.lat=near.lat;row.lng=near.lng;row.coordinateStatus='CONFIRMED';row.coordinateSource='MANUAL_PIN';}};
  assert.equal((await f.judgeNewAreaRow({address:near.customerCode})).evidenceCount,1);assert.equal(f.externalCalls(),0);
});
test('TSV multiline preserves X/Y order and separates invalid addresses and row errors',async()=>{
  const f=fixture();f.setup([near]);f.node('#newAreaBatchInput').value=`${near.customerCode}\t"합성 고객\n상세주소"\n서울특별시 영등포구 합성로 2\t합성 고객2\n잘못된 입력\t오류\t추가열`;
  await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  const rows=f.state.newAreaResults;assert.equal(rows.length,3);assert.equal(rows[0].originalCustomer,'합성 고객\n상세주소');assert.equal(rows[1].reason,'주소 확인 필요');assert.equal(rows[2].reason,'입력 열 확인 필요');
  assert.equal(f.node('#exportNewAreaCsv').disabled,false);assert.match(f.node('#newAreaBatchResults').innerHTML,/30km 내 실제 운행호차/);
  const output=globalThis.MapPeriodUi.areaExportRows(rows,'2026-11-02');assert.equal(output[0][0],near.customerCode);assert.equal(output[0][2],'검토필요');assert.equal(output[0][1],'합성 고객\n상세주소');
  assert.equal(globalThis.MapPeriodUi.areaTsv(rows,'2026-11-02','decision').split('\r\n').length,3);
  f.setJudge(async row=>{if(row.address==='실패')throw Error('SYNTHETIC_ROW_FAILURE');return {...row,decision:'검토',reason:'주소 확인 필요',nearby:[]};});
  f.node('#newAreaBatchInput').value='실패\t고객1\n경기도 화성시 합성로 2\t고객2';await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  assert.equal(f.state.newAreaResults.length,2);assert.equal(f.state.newAreaResults[0].lookupError,true);assert.equal(f.state.newAreaResults[1].lookupError,undefined);assert.match(f.node('#newAreaBatchStatus').textContent,/실패 1/);
});
test('Stage recovers 57 failed rows in one retry and keeps the already located row',async()=>{
  const origin='https://freshon-admin-stage-preview-template.onrender.com', requests=[];
  const f=fixture({location:{origin,href:origin},fetch:async(url,{body})=>{
    assert.equal(url,'/api/map-phase2b/private/stage-address-evidence');
    const {generation,rows}=JSON.parse(body);requests.push(rows);
    const data=rows.map(([query])=>query===near.customerCode||requests.length>1
      ?{status:'STORED',point:{lat:near.lat,lng:near.lng}}:{status:'OFFICIAL_ADDRESS_INDEX_UNAVAILABLE'});
    return Response.json({generation,data});
  }});
  const original=[near.customerCode,...Array.from({length:57},(_,i)=>'경기도 오산시 합성로 '+(i+1))];
  f.setup([near]);f.node('#newAreaBatchInput').value=original.join('\n');
  const run=retry=>f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults',retry);
  await run(false);
  const first=f.state.newAreaResults[0];
  assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 1 .*시스템 오류 57/);
  await run(true);
  assert.deepEqual(requests.map(rows=>rows.length),[58,57]);
  assert.equal(f.state.newAreaResults[0],first);
  assert.equal(f.state.newAreaResults.map(row=>row.originalAddress).join('\n'),original.join('\n'));
  assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 58 .*시스템 오류 0/);
  assert.equal(f.externalCalls(),0);
});
test('Stage preserves HTTP status even when a gateway sends HTML',async()=>{
  const origin='https://freshon-admin-stage-preview-template.onrender.com';
  const f=fixture({location:{origin,href:origin},fetch:async()=>new Response('<html>denied</html>',{status:403})});
  f.setup([]);f.node('#newAreaBatchInput').value=near.customerCode;
  await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  const result=f.state.newAreaResults[0];
  assert.equal(result.lookupStatus,'FAILED');assert.equal(result.lookupHttpStatus,403);
  assert.match(MapPeriodUi.areaExportRows([result])[0][3],/HTTP 403/);
});
test('a failed delivery record request preserves confirmed points and retries only missing addresses',async()=>{
  const origin='https://freshon-admin-stage-preview-template.onrender.com', generation='a'.repeat(64);
  const requests=[];let historyReads=0;
  const f=fixture({location:{origin,href:origin},fetch:async(url,{body})=>{
    if(url.includes('stage-nearby-evidence')){
      if(++historyReads===1)return new Response(null,{status:502});
      return Response.json({generation,source:'STAGE_ARCHIVE_ADDRESS_BOUND',start:'2026-08-05',end:'2026-11-02',
        observedDays:76,unknownDays:14,rows:[[near.customerCode,'2026-11-02','101',2]],fixedRows:[],
        vehicleStatus:'READY',vehicleDays:[[near.customerCode,'101','osan',2]]});
    }
    const {rows}=JSON.parse(body);requests.push(rows);
    return Response.json({generation,data:rows.map(([query])=>query===near.customerCode||requests.length>1
      ?{status:'STORED',point:{lat:near.lat,lng:near.lng}}:{status:'OFFICIAL_ADDRESS_UNAVAILABLE'})});
  }});
  f.setup([],{},[near]);f.generation(generation);
  f.node('#newAreaBatchInput').value=near.customerCode+'\n경기도 오산시 합성로 100';
  const run=retry=>f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults',retry);
  await run(false);
  assert.deepEqual(Array.from(f.state.newAreaResults,row=>row.lookupStatus),['SUCCESS','FAILED']);
  assert.equal(f.state.newAreaResults[0].deliveryEvidenceState,'UNAVAILABLE');
  await run(true);
  assert.deepEqual(requests.map(rows=>rows.length),[2,1]);
  assert.deepEqual(Array.from(f.state.newAreaResults,row=>row.lookupStatus),['SUCCESS','SUCCESS']);
  assert.equal(f.state.newAreaResults[0].deliveryEvidenceState,'READY');
  assert.equal(f.state.newAreaResults[0].actualVehicles[0].vehicle,'101');
});
test('cancel pending batch then rerun keeps input and suppresses stale completion',async()=>{
  const f=fixture();f.setup([near]);f.node('#newAreaBatchInput').value=near.customerCode;
  let finish;f.setJudge(row=>new Promise(resolve=>{finish=()=>resolve({...row,decision:'검토',nearby:[]});}));
  const pending=f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');f.clearNewAreaBatch(false);finish();await pending;
  assert.equal(f.state.newAreaResults.length,0);assert.equal(f.node('#newAreaBatchInput').value,near.customerCode);
  f.setJudge(async row=>({...row,decision:'검토',nearby:[]}));await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');assert.equal(f.state.newAreaResults.length,1);
});
