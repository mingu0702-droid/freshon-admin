import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/opsmap/map-period-ui.js';
import '../public/opsmap/phase2b-ui-helpers.js';
import '../public/opsmap/manual-waypoints.js';
import '../public/opsmap/new-area-requests.js';
import * as fixedWeekdays from '../public/opsmap/fixed-delivery-weekdays.mjs';
import {batchDomNode,batchDomTemplate} from './fixtures/new-area-dom.mjs';

const source = fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8');
const exposure = `
  window.test={state,judgeNewAreaPoint,judgeNewAreaRow,runNewArea,clearNewAreaBatch,exportNewArea,rankSearchRows,setNewAreaRadius,
    setup(rows=[],meta={},snapshot=rows){state.rangeStart='2026-09-01';state.rangeEnd='2026-11-02';dateReady=false;
      periodRows=rows;periodMeta={startDate:state.rangeStart,endDate:state.rangeEnd,complete:false,...meta};
      latestSnapshotRows=snapshot;allStores=rows;storesByCode.clear();coordinateByCode.clear();
      for(const row of [...snapshot,...rows]){storesByCode.set(row.customerCode,row);coordinateByCode.set(row.customerCode,row);}
      baseVehicles.clear();baseVehicleMeta=null;},
    assign(rows){baseVehicles=new Map(rows.map(row=>[row.customerCode,row]));baseVehicleMeta={checkedAt:'2026-09-24T04:37:59.102Z',stale:true};},
    waitForAssignment(result){baseVehicleRequest=result.then(rows=>{window.test.assign(rows);baseVehicleRequest=null;});return baseVehicleRequest;},
    ready(){dateReady=true;},generation(value){snapshotMeta={source:'STAGE_VERIFIED_REGISTRY',sourceGeneration:value};},manual:point=>manualDraft.add(point),
    setJudge:fn=>judgeNewAreaRow=fn};
})();`;
export const newAreaTestRuntime = source.slice(0,source.indexOf('\n  initVehicles();')) + exposure;
const near = {customerCode:'S990001',customerName:'합성 인근 배송처',address:'경기도 화성시 합성로 1',lat:37.2,lng:127,vehicle:'101',deliveryPattern:'월수금',lastDeliveryDate:'2026-11-02'};
const assigned={customerCode:near.customerCode,baseVehicle:'101',baseVehicleGroup:'osan',
  baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY'};
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
  window.MapFixedDeliveryWeekdays=fixedWeekdays;
  window.location=location;
  const ctx=vm.createContext({window,location,fetch,document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},createElement:batchDomTemplate,body:{dataset:{}}},MapPeriodUi:globalThis.MapPeriodUi,Phase2bUi:globalThis.Phase2bUi,NewAreaRequests:globalThis.NewAreaRequests,Map,Set,URL,URLSearchParams,AbortController,AbortSignal,Date,Intl,Number,performance,setTimeout,clearTimeout,innerWidth:1440});
  vm.runInContext(newAreaTestRuntime,ctx);
  return {...window.test,node,externalCalls:()=>calls,window};
}
test('500 m includes an undelivered fixed registration and preserves legacy exclusions',()=>{
  const f=fixture();f.setup([],{},[{...near,lastDeliveryDate:''}]);f.generation('a'.repeat(64));
  const at=meters=>({lat:near.lat+meters/6371000*180/Math.PI,lng:near.lng});
  const request={address:'경기도 화성시 합성로 2'};
  const qualifies=f.judgeNewAreaPoint(request,at(500));
  assert.equal(qualifies.decision,'O');assert.equal(qualifies.eligibilityBasis,'FIXED_REGISTRY_500M');
  assert.equal(qualifies.nearestDistanceMeters,500);assert.equal(qualifies.nearestStoreCode,near.customerCode);
  assert.equal(qualifies.nearestDispatchLabel,'미확인');assert.equal(qualifies.dispatchVehicles.length,0);
  assert.match(qualifies.evidence,/실제 수락·배송일 별도 확인/);
  const outside=f.judgeNewAreaPoint(request,at(500.0000005));
  assert.equal(outside.nearestDistanceMeters,500);
  assert.ok(outside.nearestDistance>0.5);
  assert.equal(outside.decision,'X','the unrounded distance is outside the limit');
  assert.equal(outside.reason,'배송동선 맞지않음');
  for(const [row,reason] of [
    [{address:'경기도 화성시 합성아파트',customer:'101동 102호'},'아파트'],
    [{...request,customer:'동선외'},'배송동선 맞지않음'],
    [{address:'제주특별자치도 합성로 2'},'제주도']
  ]){
    assert.equal(f.judgeNewAreaPoint(row,at(383)).decision,'X');
    assert.equal(f.judgeNewAreaPoint(row,at(775)).reason,reason);
    assert.equal(f.judgeNewAreaPoint(row,null).reason,reason);
  }
  assert.equal(f.judgeNewAreaPoint(request,{...at(218),coordinateSource:'MAP_CLICK_TEMPORARY'}).decision,'검토');
  assert.equal(f.judgeNewAreaPoint({address:'S990001'},{...at(218),address:'제주특별자치도 합성로 2'}).reason,'제주도');
  assert.equal(f.judgeNewAreaPoint({...request,customer:'합성상가 101동 102호'},at(218)).decision,'O');
  const facility={...request,customer:'지하 하역장'};
  assert.match(f.judgeNewAreaPoint(facility,at(218)).evidence,/차량 진입 별도 확인/);
  const outsideFacility=f.judgeNewAreaPoint(facility,at(775));
  assert.equal(outsideFacility.decision,'X');
  assert.equal(outsideFacility.reason,'배송동선 맞지않음');
});
test('temporary, invalid, deleted and delivery-only coordinates cannot provide 500 m eligibility',()=>{
  const f=fixture();
  f.setup([],{},[{...near,coordinateSource:'KAKAO_ADDRESS_LIVE'},
    {...near,customerCode:'S990003',customerRegistryStatus:'DELETED'},
    {...near,customerCode:'S990004',deliveryOnly:true},
    {...near,customerCode:'S990005',coordinateStatus:'CONFLICT'},
    {...near,customerCode:'S990006',lat:null},{...near,customerCode:'S990007',lat:0},
    {...near,customerCode:'S990002',lat:37.21,coordinateSource:'ADDRESS_REPRESENTATIVE'}]);
  const row=f.judgeNewAreaPoint({address:near.address},{lat:37.2,lng:127});
  assert.equal(row.nearestStoreCode,'S990002');
  assert.equal(row.decision,'X');
  assert.equal(row.reason,'배송동선 맞지않음');
  assert.equal(f.judgeNewAreaPoint({address:near.address},{lat:NaN,lng:127}).reason,'주소 확인 필요');
});
test('completed visits, archive coverage, and nearby dispatch vehicles cannot decide O/X',()=>{
  const f=fixture(), request={address:'경기도 화성시 합성로 2'};
  const fixed={...near,lastDeliveryDate:'',lat:37.2};
  const point={lat:37.207,lng:127};
  f.setup([],{},[fixed]);f.state.rangeStart='2026-08-05';
  const before=f.judgeNewAreaPoint(request,point);
  assert.equal(before.decision,'X');
  assert.equal(before.reason,'배송동선 맞지않음');
  const archive={start:f.state.rangeStart,end:f.state.rangeEnd,days:76,unknownDays:14,vehicleStatus:'READY',
    vehicles:[{...near,vehicle:'999',center:'osan',mask:2}],observed:[],fixed:[]};
  f.setup([completed],{complete:true,coverageComplete:true},[fixed]);f.ready();
  f.assign([{...assigned,weekdays:{Mon:'101',Tue:'122'}}]);
  const after=f.judgeNewAreaPoint(request,point,{archive});
  assert.equal(after.decision,before.decision);
  assert.equal(after.reason,before.reason);
  assert.equal(after.evidence,before.evidence);
  assert.equal(after.nearestDistanceMeters,778);
  assert.deepEqual(Array.from(MapPeriodUi.areaDispatchVehicles(after,30),item=>[item.vehicle,item.weekdays.join('')]),[['101','월'],['122','화']]);
  assert.equal(f.judgeNewAreaPoint(request,{lat:37.201,lng:127},{archive}).decision,'O');
});
test('new area displays the nearby fixed schedule without changing the nearest-store decision',()=>{
  const f=fixture();
  const second={...near,customerCode:'S990002',lat:near.lat+.002};
  const held={...near,customerCode:'S990003',lat:near.lat+.003};
  const far={...near,customerCode:'S990004',lat:near.lat+.006};
  f.setup([],{},[near,second,held,far]);f.generation('a'.repeat(64));
  f.assign([{...assigned,weekdays:{Mon:'101',Sun:'101'}},
    {...assigned,customerCode:second.customerCode,weekdays:{Wed:'122'}},
    {...assigned,customerCode:held.customerCode,baseVehicle:'오산보류',weekdays:{Thu:'122'}},
    {...assigned,customerCode:far.customerCode,weekdays:{Sat:'122'}}]);
  const row=f.judgeNewAreaPoint({address:near.address},near);
  assert.equal(row.decision,'O');
  assert.deepEqual(row.fixedNearbyWeekdays,['월','수']);
  assert.equal(row.fixedNearbyWeekdayState,'PARTIAL');
  const column=MapPeriodUi.areaExportHeadings.indexOf('500m 내 등록 매장 배송요일');
  assert.match(MapPeriodUi.areaExportRows([row])[0][column],/^월 · 수/);
});
test('changing 30/40/50 km and clearing all delivery history leave O, X and review unchanged',()=>{
  const f=fixture();
  const distant={...near,customerCode:'S990002',lat:37.59};
  const request={address:'경기도 화성시 합성로 2'};
  const scenarios=[
    [request,{lat:37.201,lng:127}],
    [{...request,customer:'동선외'},{lat:37.201,lng:127}],
    [request,{lat:37.207,lng:127}],
    [request,null]
  ];
  for(const history of [[completed],[]]){
    const snapshot=[near,distant].map(row=>({...row,lastDeliveryDate:history.length?row.lastDeliveryDate:'',history}));
    f.setup(history,{complete:!!history.length},snapshot);
    f.assign([{...assigned,weekdays:{Mon:'101'}},{...assigned,customerCode:distant.customerCode,baseVehicle:'122'}]);
    for(const radius of [30,40,50]){
      f.setNewAreaRadius(radius);
      const rows=scenarios.map(([row,point])=>f.judgeNewAreaPoint(row,point));
      assert.deepEqual(rows.map(row=>row.decision),['O','X','X','검토']);
      assert.deepEqual(rows.map(row=>row.nearestDistanceMeters??null),[111,111,778,null]);
      assert.equal(rows[2].reason,'배송동선 맞지않음');
      assert.equal(MapPeriodUi.areaDispatchVehicles(rows[0],radius).length,radius===50?2:1);
    }
  }
});
test('nearest registered store comes from the fixed registry even when a period row is closer',()=>{
  const f=fixture();
  f.setup([near],{},[{...near,customerCode:'S990002',customerName:'배송 이력 없는 매장',lat:37.2015,lastDeliveryDate:''},
    {...near,customerCode:'S990003',customerName:'배송 전용',lat:37.2016,deliveryOnly:true}]);
  const row=f.judgeNewAreaPoint({address:'경기도 화성시 합성로 2'},{lat:37.2016,lng:127});
  assert.equal(row.nearestStore,'배송 이력 없는 매장');
  assert.equal(row.nearestStoreCode,'S990002');assert.equal(row.nearestDistanceMeters,11);
});
test('verified dispatch days stay with their weekday vehicle and exclude Sunday',()=>{
  const f=fixture();
  f.setup([],{},[near]);
  f.assign([{...assigned,weekdays:{Tue:'122',Sun:'202'}}]);
  const row=f.judgeNewAreaPoint({address:near.address},{lat:near.lat,lng:near.lng});
  assert.equal(row.decision,'O');
  assert.deepEqual(Array.from(row.nearestDispatch,item=>[item.vehicle,MapPeriodUi.areaDispatchDays(item)]),
    [['101','미확인'],['122','화']]);
  const cells=MapPeriodUi.areaExportRows([row])[0];
  assert.equal(cells[6],'101호 · 122호');
  assert.match(cells[12],/101호 .*미확인/);
  assert.equal(cells[13],'101호 미확인 · 122호 화');
  assert.equal(cells[14],'배차표 기준일 2026-09-24 · 최신 배정 미확인');
  f.assign([{...assigned,baseVehicleState:'CONFLICT'}]);
  const unknown=f.judgeNewAreaPoint({address:near.address},{lat:near.lat,lng:near.lng});
  assert.equal(unknown.decision,'O');assert.equal(unknown.dispatchVehicles.length,0);
  f.assign([{...assigned,baseVehicle:'',baseVehicleState:'UNASSIGNED'}]);
  assert.equal(f.judgeNewAreaPoint({address:near.address},{lat:near.lat,lng:near.lng}).nearestDispatchLabel,'미배정');
});
test('dispatch source day uses Korea time and missing provenance stays unconfirmed',()=>{
  assert.equal(MapPeriodUi.areaDispatchReference({dispatchCheckedAt:'2026-11-10T16:00:00Z',dispatchStale:false}),
    '배차표 기준일 2026-11-11 · 배정 자료 확인');
  assert.equal(MapPeriodUi.areaDispatchReference({}), '배차표 기준일 미확인 · 최신 배정 미확인');
});
test('search rebuilds for a new registration and drops a moved store’s prior address aliases',async()=>{
  const f=fixture();
  const oldAlias='경기도 화성시 합성동 111';
  const old={...near,jibunAddress:oldAlias};
  const moved={...near,address:'경기도 화성시 이동로 6',jibunAddress:oldAlias,lat:null,lng:null,
    addressChanged:true,resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'};
  const added={...near,customerCode:'S990002',customerName:'합성 추가 매장',address:'경기도 화성시 추가로 9',lat:37.201};
  f.setup([old]);
  assert.equal(f.rankSearchRows(oldAlias)[0].customerCode,old.customerCode);
  assert.equal(f.rankSearchRows(added.address).length,0);
  f.setup([old],{},[moved,added]); // A period row can still contain the old address and GPS.
  assert.equal(f.rankSearchRows(oldAlias).length,0);
  assert.equal(f.rankSearchRows(old.address).length,0);
  assert.equal(f.rankSearchRows(moved.address)[0].address,moved.address);
  assert.equal(f.rankSearchRows(added.address)[0].customerCode,added.customerCode);
  const row=f.judgeNewAreaPoint({address:'경기도 화성시 문의로 9'},{lat:near.lat,lng:near.lng});
  assert.equal(row.nearestStoreCode,added.customerCode);
  assert.equal(row.nearestDistanceMeters,111);
  assert.equal((await f.judgeNewAreaRow({address:oldAlias})).lookupStatus,'DEFERRED');
});
test('customer code, stored address and existing manual coordinate input require zero lookup calls',async()=>{
  const f=fixture();f.setup([near]);
  assert.equal((await f.judgeNewAreaRow({address:near.customerCode,customer:''})).nearestStoreCode,near.customerCode);
  assert.equal((await f.judgeNewAreaRow({address:near.address,customer:''})).nearestStoreCode,near.customerCode);
  f.manual({label:'대구광역시 동구 합성로 2',lat:35.9,lng:128.65});
  assert.equal((await f.judgeNewAreaRow({address:'대구광역시 동구 합성로 2'})).coordinateSource,'MANUAL_WAYPOINT');
  const unknown=await f.judgeNewAreaRow({address:'서울특별시 영등포구 합성로 2'});assert.equal(unknown.reason,'주소 확인 필요');assert.equal(unknown.lookupError,undefined);
  assert.equal(f.externalCalls(),0);
});
test('confirmed manual pin projection is reused without pin writes',async()=>{
  const f=fixture();f.setup([{...near,lat:null,lng:null}]);f.window.MapManualPins={apply(row){row.lat=near.lat;row.lng=near.lng;row.coordinateStatus='CONFIRMED';row.coordinateSource='MANUAL_PIN';}};
  assert.equal((await f.judgeNewAreaRow({address:near.customerCode})).nearestStoreCode,near.customerCode);assert.equal(f.externalCalls(),0);
});
test('TSV multiline preserves X/Y order and separates invalid addresses and row errors',async()=>{
  const f=fixture();f.setup([near]);f.node('#newAreaBatchInput').value=`${near.customerCode}\t"합성 고객\n상세주소"\n서울특별시 영등포구 합성로 2\t합성 고객2\n잘못된 입력\t오류\t추가열`;
  await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  const rows=f.state.newAreaResults;assert.equal(rows.length,3);assert.equal(rows[0].originalCustomer,'합성 고객\n상세주소');assert.equal(rows[1].reason,'주소 확인 필요');assert.equal(rows[2].reason,'입력 열 확인 필요');
  assert.equal(f.node('#exportNewAreaCsv').disabled,false);assert.match(f.node('#newAreaBatchResults').innerHTML,/30km 내 참고 배차호차/);
  const output=globalThis.MapPeriodUi.areaExportRows(rows,'2026-11-02');assert.equal(output[0][0],near.customerCode);assert.equal(output[0][2],'O');assert.equal(output[0][1],'합성 고객\n상세주소');
  assert.equal(MapPeriodUi.areaExportHeadings.at(-1),'판정 근거');assert.match(output[0].at(-1),/500m 이내/);
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
test('Stage never requests completed-delivery records and retries only missing addresses',async()=>{
  const origin='https://freshon-admin-stage-preview-template.onrender.com', generation='a'.repeat(64);
  const requests=[];
  const f=fixture({location:{origin,href:origin},fetch:async(url,{body})=>{
    assert.equal(url,'/api/map-phase2b/private/stage-address-evidence');
    const {rows}=JSON.parse(body);requests.push(rows);
    return Response.json({generation,data:rows.map(([query])=>query===near.customerCode||requests.length>1
      ?{status:'STORED',point:{lat:near.lat,lng:near.lng}}:{status:'OFFICIAL_ADDRESS_UNAVAILABLE'})});
  }});
  f.setup([],{},[near]);f.generation(generation);
  f.node('#newAreaBatchInput').value=near.customerCode+'\n경기도 오산시 합성로 100';
  const run=retry=>f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults',retry);
  await run(false);
  assert.deepEqual(Array.from(f.state.newAreaResults,row=>row.lookupStatus),['SUCCESS','FAILED']);
  const verified=f.state.newAreaResults[0];assert.equal(verified.decision,'O');assert.equal(verified.nearestDispatchLabel,'미확인');
  await run(true);
  assert.deepEqual(requests.map(rows=>rows.length),[2,1]);
  assert.deepEqual(Array.from(f.state.newAreaResults,row=>row.lookupStatus),['SUCCESS','SUCCESS']);
  assert.equal(f.state.newAreaResults[0],verified);
});
test('waiting for the dispatch master leaves the verdict and successful location available',async()=>{
  const f=fixture();f.setup([near]);
  let resolve;
  const waiting=f.waitForAssignment(new Promise(done=>{resolve=done;}));
  f.node('#newAreaBatchInput').value=near.customerCode;
  await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  const before=f.state.newAreaResults[0];
  assert.equal(before.decision,'O');assert.equal(before.nearestDispatchLabel,'미확인');
  resolve([{...assigned,weekdays:{Mon:'101'}}]);
  await waiting;await Promise.resolve();
  const after=f.state.newAreaResults[0];
  assert.equal(after.decision,before.decision);assert.equal(after.evidence,before.evidence);
  assert.equal(after.nearestDistanceMeters,before.nearestDistanceMeters);
  assert.equal(after.nearestDispatch[0].weekdays.join(''),'월');
  assert.equal(f.node('#retryNewAreaBatch').disabled,true);
});
test('cancel pending batch then rerun keeps input and suppresses stale completion',async()=>{
  const f=fixture();f.setup([near]);f.node('#newAreaBatchInput').value=near.customerCode;
  let finish;f.setJudge(row=>new Promise(resolve=>{finish=()=>resolve({...row,decision:'검토',nearby:[]});}));
  const pending=f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');f.clearNewAreaBatch(false);finish();await pending;
  assert.equal(f.state.newAreaResults.length,0);assert.equal(f.node('#newAreaBatchInput').value,near.customerCode);
  f.setJudge(async row=>({...row,decision:'검토',nearby:[]}));await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');assert.equal(f.state.newAreaResults.length,1);
});
