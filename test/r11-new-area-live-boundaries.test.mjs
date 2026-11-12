import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/opsmap/map-period-ui.js';
import '../public/opsmap/phase2b-ui-helpers.js';
import '../public/opsmap/manual-waypoints.js';
import '../public/opsmap/new-area-requests.js';
import {batchDomNode,batchDomTemplate} from './fixtures/new-area-dom.mjs';

// Synthetic data and mocked transports only. No browser, API, source or coordinate writes.
const runtime=fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8');
const exposed=runtime.slice(0,runtime.indexOf('\n  initVehicles();'))+`
window.qa={state,runNewArea,clearNewAreaBatch,judgeNewAreaRow,judgeNewAreaPoint,lookupInteractiveLocation,
setup(saved){state.rangeStart='2026-09-01';state.rangeEnd='2026-11-02';dateReady=false;
  periodRows=[];periodMeta={complete:false};latestSnapshotRows=saved;allStores=saved;
  for(const row of saved){storesByCode.set(row.customerCode,row);coordinateByCode.set(row.customerCode,row);if(row.vehicle)baseVehicles.set(row.customerCode,{baseVehicle:row.vehicle});}},
saved:()=>latestSnapshotRows};})();`;
const saved={customerCode:'S990001',customerName:'합성 저장매장',address:'경기도 화성시 합성로 1',lat:37.2,lng:127,vehicle:'101'};
function fixture({rows=[],customer=()=>({data:[],meta:{complete:true}}),lookup=(query,callback)=>callback([{address_name:query,x:'127',y:'37.2'}],'OK')}={}){
  const nodes=new Map(),headers=[],queries=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,batchDomNode());return nodes.get(id);};
  const window={addEventListener(){},VEHICLE_AREA_DATA:{vehicles:[]},ManualWaypoints:globalThis.ManualWaypoints,
    KAKAO_MAP_CONFIG:{allowExternalAddressLookup:true},kakaoGeocoder:{serverProxy:true,addressSearch(query,callback,options){queries.push(query);lookup(query,callback,options);}}};
  const fetch=async(url,options)=>{
    assert.equal(url,'/api/map-phase2b/private/customer-search');
    assert.equal(options.method,undefined);
    const query=decodeURIComponent(options.headers['x-map-customer-query']);headers.push(query);
    const payload=await customer(query);
    return {ok:payload.ok!==false,status:payload.ok===false?503:200,headers:{get(){return null;}},json:async()=>payload};
  };
  const context=vm.createContext({window,document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},createElement:batchDomTemplate,body:{dataset:{}}},
    MapPeriodUi:globalThis.MapPeriodUi,Phase2bUi:globalThis.Phase2bUi,NewAreaRequests:globalThis.NewAreaRequests,
    location:{href:'https://example.invalid/opsmap/'},fetch,Map,Set,URL,URLSearchParams,AbortController,AbortSignal,Date,Intl,Number,performance,setTimeout,clearTimeout,innerWidth:1440});
  vm.runInContext(exposed,context);window.qa.setup(rows);
  const run=input=>{node('#newAreaBatchInput').value=input;return window.qa.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');};
  return {...window.qa,window,node,run,headers,queries};
}
const query=address=>globalThis.NewAreaRequests.addressQuery(address,globalThis.Phase2bUi.addressVariants);
const queryChoices=address=>globalThis.NewAreaRequests.addressQueries(address,globalThis.Phase2bUi.addressVariants);
const tsvCell=value=>'"'+value.replace(/"/g,'""')+'"';

test('basic query reuses existing variants, keeps road/lot numbers and scopes official aliases',()=>{
  const cases=[
    ['경기도 화성시 합성로12-3 (합성동, 합성상가)','경기도 화성시 합성로 12-3'],
    ['인천광역시 제물포구 합성로 21 (송림동, 합성빌딩)','인천광역시 동구 합성로 21'],
    ['인천광역시 제물포구 합성로 21 (다른동)','인천광역시 제물포구 합성로 21'],
    ['인천광역시 영종구 운남동 21-3','인천광역시 중구 운남동 21-3'],
    ['인천광역시 검단구 당하동 21-3','인천광역시 서구 당하동 21-3'],
    ['인천광역시 검단구 합성로 21 (다른동)','인천광역시 검단구 합성로 21'],
    ['경기도 화성시 만세구 합성로 21','경기도 화성시 합성로 21'],
    ['경기도 화성시 병점구 합성로 21','경기도 화성시 합성로 21'],
    ['전남광주통합특별시 순천시 합성로 21','전라남도 순천시 합성로 21'],
    ['전남광주통합특별시 광양시 합성로 21','전라남도 광양시 합성로 21'],
    ['전남광주통합특별시 강진군 합성로 21','전라남도 강진군 합성로 21'],
    ['전남광주통합특별시 북구 합성로 21 (용봉동)','광주광역시 북구 합성로 21'],
    ['부산광역시 북구 합성로 21 (용봉동)','부산광역시 북구 합성로 21'],
    ['전남광주통합특별시 북구 합성로 21 (다른동)','전남광주통합특별시 북구 합성로 21'],
    ['경기도 화성시 합성동 산 21-3 [합성건물]','경기도 화성시 합성동 산 21-3'],
    ['부산 영도구 동삼로 56 (동삼동, 한나타워)','부산 영도구 동삼로 56'],
    ['경기 안성시 일죽면 서동대로 7184 （월정리, 광장휴게소）','경기 안성시 일죽면 서동대로 7184'],
    ['경기 양주시 남면 황방리 386 (합성 건물(별관))','경기 양주시 남면 황방리 386']
  ];
  for(const [input,expected] of cases){
    assert.equal(queryChoices(input).at(-1),expected,input);assert.ok(queryChoices(input).length<=2);
    assert.equal(query(input),globalThis.Phase2bUi.addressVariants(input.normalize('NFKC').replace(/(동|읍|면|리|대로|로|길)(\d+(?:-\d+)?)(?=\s|\(|\[|$)/g,'$1 $2')).at(-1));
  }
  assert.equal(query('합성건물 고객정보만'), '');
  assert.equal(query('합성건물 (경기 안성시 일죽면 서동대로 7184)'), '');
});

test('60 independent X/Y rows retain CRLF, tabs, quotes, phones and units with no Y transmission',async()=>{
  const f=fixture({rows:[saved]});const original=JSON.stringify(f.saved());
  const cells=Array.from({length:60},(_,i)=>({x:`  경기도 화성시 합성로 ${i+100} (합성동, 합성상가)  `,y:`합성고객${i}\r\n010-0000-0000\t${i+1}층 "${i+1}호"`}));
  await f.run(cells.map(({x,y})=>tsvCell(x)+'\t'+tsvCell(y)).join('\r\n'));
  assert.equal(f.state.newAreaResults.length,60);assert.equal(f.queries.length,60);assert.equal(f.headers.length,60);
  for(const [i,row] of f.state.newAreaResults.entries()){
    assert.equal(row.originalAddress,cells[i].x);assert.equal(row.originalCustomer,cells[i].y);
    assert.equal(row.address,cells[i].x.trim());assert.equal(row.customer,cells[i].y);assert.equal(row.decision,'O');
    assert.equal(row.lookupStatus,'SUCCESS');assert.equal(row.nearestDistanceMeters,0);
    assert.equal(row.nearestStoreCode,saved.customerCode);assert.equal(row.dispatchVehicles.length,0);
    assert.equal(row.eligibilityBasis,'FIXED_REGISTRY_500M');assert.equal(row.nearestDispatchLabel,'미확인');
    assert.equal(f.queries[i],`경기도 화성시 합성로 ${i+100}`);assert.equal(f.headers[i],f.queries[i]);
  }
  const exported=globalThis.MapPeriodUi.areaExportRows(f.state.newAreaResults,'2026-11-03');
  assert.deepEqual(Array.from(exported,row=>Array.from(row).slice(0,2)),cells.map(({x,y})=>[x,y]));
  assert.match(f.node('#newAreaBatchStatus').textContent,/완료 60 · 위치 확인 60 · 보류 0 · 실패 0 · 한도대기 0/);
  assert.match(f.node('#newAreaBatchResults').innerHTML,/가장 가까운 등록 매장\(직선거리\)/);
  assert.match(f.node('#newAreaBatchResults').innerHTML,/참고 배차호차 · 확인된 호차 없음/);
  assert.equal(JSON.stringify(f.saved()),original,'REST coordinates never mutate the saved snapshot');
});

test('same normalized query is reused only within its run; all original rows and Y values remain distinct',async()=>{
  const f=fixture({lookup:(query,callback)=>query.includes('만세구')?callback([],'ZERO_RESULT'):callback([{address_name:query,x:'127',y:'37.2'}],'OK')});
  const input='경기도 화성시 만세구 합성로 12 (합성동)\t합성 고객1\n경기도 화성시 합성로12 (합성상가)\t합성 고객2';
  await f.run(input);assert.equal(f.queries.length,2);assert.equal(f.headers.length,2);
  assert.deepEqual(new Set(f.queries),new Set(['경기도 화성시 만세구 합성로 12','경기도 화성시 합성로 12']));
  assert.equal(f.state.newAreaResults.length,2);assert.notEqual(f.state.newAreaResults[0].originalCustomer,f.state.newAreaResults[1].originalCustomer);
  await f.run(input);assert.equal(f.queries.length,4);assert.equal(f.headers.length,4,'no cross-run coordinate response cache');
});

test('modern exact response wins; only explicit ZERO_RESULT permits the one official alias',async()=>{
  const input='인천광역시 제물포구 합성로 12 (송림동, 합성상가)\t합성 고객 010-0000-0000';
  const modern='인천광역시 제물포구 합성로 12',alias='인천광역시 동구 합성로 12';
  const current=fixture();await current.run(input);
  assert.deepEqual(current.queries,[modern]);assert.equal(current.state.newAreaResults[0].resolvedAddress,modern);
  const legacy=fixture({lookup:(query,callback)=>query===modern?callback([],'ZERO_RESULT'):callback([{address_name:alias,x:'127',y:'37.2'}],'OK')});
  await legacy.run(input);assert.deepEqual(legacy.queries,[modern,alias]);assert.equal(legacy.state.newAreaResults[0].resolvedAddress,alias);
  assert.equal(legacy.state.newAreaResults[0].originalAddress,'인천광역시 제물포구 합성로 12 (송림동, 합성상가)');
  assert.equal(legacy.state.newAreaResults[0].originalCustomer,'합성 고객 010-0000-0000');
  const empty=fixture({lookup:(_query,callback)=>callback([],'ZERO_RESULT')});await empty.run(input);
  assert.deepEqual(empty.queries,[modern,alias]);assert.equal(empty.state.newAreaResults[0].lookupStatus,'DEFERRED');
});

test('alias is never retried after failure, limit, ambiguity, nonexact rows, invalid coordinates or empty OK',async()=>{
  const input='경기도 화성시 만세구 합성로 12 (합성동)\t합성 고객';
  const modern='경기도 화성시 만세구 합성로 12';
  const outcomes=[
    (_query,callback)=>callback([],'ERROR',{code:'GEOCODE_DAILY_LIMIT',status:429}),
    (_query,callback)=>callback([],'ERROR',{code:'KAKAO_HTTP_REJECTED',status:502}),
    (_query,callback)=>callback([],'ERROR',{code:'GEOCODE_QUERY_INVALID',status:400}),
    (query,callback)=>callback([{address_name:query,x:'127',y:'37.2'},{address_name:query,x:'127.1',y:'37.3'}],'OK'),
    (_query,callback)=>callback([{address_name:'경기도 화성시 합성로 120',x:'127',y:'37.2'}],'OK'),
    (query,callback)=>callback([{address_name:query,x:'120',y:'10'}],'OK'),
    (_query,callback)=>callback([],'OK'),
    ()=>{throw Error('SYNTHETIC_FAILURE');}
  ];
  for(const lookup of outcomes){const f=fixture({lookup});await f.run(input);assert.deepEqual(f.queries,[modern]);assert.equal(f.state.newAreaResults.length,1);}
});

test('modern or official old customer metadata reuses saved coordinates without a provider call',async()=>{
  const input='경기도 화성시 만세구 합성로 12\t합성 고객';
  for(const supported of ['경기도 화성시 만세구 합성로 12','경기도 화성시 합성로 12']){
    const f=fixture({customer:query=>({data:query===supported?[{...saved,matchedBy:'ADDRESS'}]:[],meta:{complete:true}})});
    await f.run(input);assert.equal(f.queries.length,0);assert.equal(f.state.newAreaResults[0].lookupStatus,'SUCCESS');
    assert.equal(f.headers.length,supported.includes('만세구')?1:2);
  }
});

test('authenticated address match reuses existing manual coordinates with redacted public addresses',async()=>{
  const f=fixture({rows:[{...saved,address:'',lat:null,lng:null}],customer:()=>({data:[{customerCode:saved.customerCode,matchedBy:'ADDRESS'}],meta:{complete:true}})});
  f.window.MapManualPins={apply(row){if(row.customerCode===saved.customerCode){row.lat=saved.lat;row.lng=saved.lng;row.coordinateStatus='CONFIRMED';row.coordinateSource='MANUAL_PIN';}}};
  await f.run('경기도 화성시 합성로 99 (합성동)\t합성 고객 연락처 010-0000-0000');
  assert.equal(f.state.newAreaResults[0].coordinateSource,'MANUAL_PIN');assert.equal(f.state.newAreaResults[0].customerCode,saved.customerCode);
  assert.equal(f.queries.length,0);assert.deepEqual(f.headers,['경기도 화성시 합성로 99']);
});

test('existing conflicted match and multiple customer matches are deferred without REST replacement',async()=>{
  const f=fixture({customer:q=>({data:q.endsWith(' 1')?[{...saved,coordinateStatus:'CONFLICT',matchedBy:'ADDRESS'}]:[{...saved,matchedBy:'ADDRESS'},{...saved,customerCode:'S990002',matchedBy:'ADDRESS'}],meta:{complete:true}})});
  await f.run('경기도 화성시 합성로 1\t합성1\n경기도 화성시 합성로 2\t합성2');
  assert.equal(f.state.newAreaResults[0].reason,'기존 고객 좌표 확인 필요');assert.equal(f.state.newAreaResults[1].reason,'주소 복수 후보');assert.equal(f.queries.length,0);
});

test('zero result, ambiguous response and individual query failure do not stop later success or saved reuse',async()=>{
  const f=fixture({rows:[saved],lookup:(query,callback)=>{
    if(query.endsWith(' 2'))return callback([],'ZERO_RESULT');
    if(query.endsWith(' 3'))return callback([{address_name:query,x:'127',y:'37.2'},{address_name:query,x:'127.1',y:'37.2'}],'OK');
    if(query.endsWith(' 4'))return callback([],'ERROR',{code:'GEOCODE_QUERY_INVALID',status:400});
    callback([{address_name:query,x:'127',y:'37.2'}],'OK');
  }});
  await f.run([2,3,4,5,1].map(i=>`경기도 화성시 합성로 ${i}\t합성${i}`).join('\n'));
  assert.equal(f.state.newAreaResults.length,5);assert.equal(f.state.newAreaResults[0].reason,'주소 확인 필요');assert.equal(f.state.newAreaResults[1].reason,'주소 복수 후보');
  assert.equal(f.state.newAreaResults[2].lookupStatus,'FAILED');assert.equal(f.state.newAreaResults[3].lookupStatus,'SUCCESS');assert.equal(f.state.newAreaResults[4].lookupStatus,'SUCCESS');
  assert.equal(f.queries.length,4);assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 2 · 보류 2 · 실패 1 · 한도대기 0/);
});

for(const code of ['KAKAO_HTTP_REJECTED','GEOCODE_DAILY_LIMIT'])test(`${code} stops subsequent REST calls but finishes every row and reuses saved coordinates`,async()=>{
  const f=fixture({rows:[saved],lookup:(_query,callback)=>callback([],'ERROR',{code,status:code==='GEOCODE_DAILY_LIMIT'?429:502})});
  await f.run('경기도 화성시 합성로 2\t합성1\n경기도 화성시 합성로 3\t합성2\n경기도 화성시 합성로 1\t합성3');
  assert.equal(f.state.newAreaResults.length,3);assert.equal(f.queries.length,1);assert.equal(f.state.newAreaResults[2].lookupStatus,'SUCCESS');
  if(code==='GEOCODE_DAILY_LIMIT'){
    assert.equal(f.state.newAreaResults[0].lookupStatus,'LIMIT');assert.equal(f.state.newAreaResults[1].lookupStatus,'LIMIT');
    assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 1 · 보류 0 · 실패 0 · 한도대기 2/);
  }else{
    assert.equal(f.state.newAreaResults[0].lookupStatus,'FAILED');assert.equal(f.state.newAreaResults[1].lookupStatus,'DEFERRED');
    assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 1 · 보류 1 · 실패 1 · 한도대기 0/);
  }
});

test('customer lookup failure affects only its row and never prevents a later saved match',async()=>{
  const f=fixture({rows:[saved],customer:()=>({ok:false,error:'CUSTOMER_SEARCH_UNAVAILABLE'})});
  await f.run('경기도 화성시 합성로 2\t합성1\n경기도 화성시 합성로 1\t합성2');
  assert.equal(f.state.newAreaResults[0].lookupStatus,'FAILED');assert.equal(f.state.newAreaResults[1].lookupStatus,'SUCCESS');assert.equal(f.queries.length,0);
});

test('cancellation aborts lookup; a late callback cannot overwrite a later run',async()=>{
  let finish;const f=fixture({lookup:(query,callback)=>{finish=()=>callback([{address_name:query,x:'127',y:'37.2'}],'OK');}});
  const pending=f.run('경기도 화성시 합성로 2\t합성1');
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  const oldFinish=finish;f.clearNewAreaBatch(false);await pending;
  f.window.kakaoGeocoder.addressSearch=(query,callback)=>callback([{address_name:query,x:'127.1',y:'37.3'}],'OK');
  await f.run('경기도 화성시 합성로 3\t합성2');oldFinish();
  assert.equal(f.state.newAreaResults.length,1);assert.equal(f.state.newAreaResults[0].originalCustomer,'합성2');assert.equal(f.state.newAreaResults[0].lat,37.3);
});

test('proxy preserves safe quota status and shares an in-flight request across cancelled and active callers',async()=>{
  const source=fs.readFileSync(new URL('../public/opsmap/kakao-maps-adapter.js',import.meta.url),'utf8');
  let options,release,calls=0;const window={KAKAO_MAP_CONFIG:{allowExternalAddressLookup:true}};
  const gate=new Promise(resolve=>release=resolve);
  const context=vm.createContext({window,fetch:async(_url,value)=>{calls++;options=value;await gate;return {ok:false,status:429,json:async()=>({ok:false,error:'GEOCODE_DAILY_LIMIT'})};}});
  vm.runInContext(source,context);const geocoder=window.KakaoMapsAdapter.geocoder();const controller=new AbortController();
  const query='경기도 화성시 합성로 1';
  const cancelled=assert.rejects(globalThis.NewAreaRequests.lookup(geocoder,query,{signal:controller.signal}),error=>error.name==='AbortError');
  const active=assert.rejects(globalThis.NewAreaRequests.lookup(geocoder,query),error=>error.code==='GEOCODE_DAILY_LIMIT'&&error.status===429);
  controller.abort();release();await Promise.all([cancelled,active]);
  assert.equal(calls,1);assert.equal(options.body,JSON.stringify({query}));
  assert.equal(geocoder.blockedReason,'GEOCODE_DAILY_LIMIT');assert.equal(window.KAKAO_MAP_CONFIG.allowExternalAddressLookup,false);
});


test('anonymous temporary points never enter manual-pin projection and complete all 60 rows',async()=>{
  const f=fixture();let manualCalls=0;
  f.window.MapManualPins={apply(row){manualCalls++;if(!/^[A-Z]\d+$/.test(row.customerCode||''))throw TypeError('SYNTHETIC_ANONYMOUS_MANUAL_PROJECTION');}};
  for(const code of [undefined,null,'','invalid']){
    const row=f.judgeNewAreaPoint({address:'경기도 화성시 합성로 90'},{customerCode:code,lat:37.2,lng:127});
    assert.equal(row.lookupStatus,'SUCCESS');
  }
  await f.run(Array.from({length:60},(_,i)=>`경기도 화성시 합성로 ${i+100}\t합성고객${i}`).join('\n'));
  assert.equal(f.state.newAreaResults.length,60);assert.equal(f.queries.length,60);
  assert.ok(f.state.newAreaResults.every(row=>row.lookupStatus==='SUCCESS'&&!row.lookupError));
  assert.match(f.node('#newAreaBatchStatus').textContent,/완료 60 · 위치 확인 60 · 보류 0 · 실패 0 · 한도대기 0/);
  assert.equal(manualCalls,0,'anonymous points must bypass the customer-only manual projection');
});

test('only valid customer codes enter manual-pin projection and still reuse confirmed manual coordinates',async()=>{
  const f=fixture({rows:[{...saved,lat:null,lng:null}]});const calls=[];
  f.window.MapManualPins={apply(row){
    if(!/^[A-Z]\d+$/.test(row.customerCode||''))throw TypeError('SYNTHETIC_ANONYMOUS_MANUAL_PROJECTION');
    calls.push(row.customerCode);row.lat=saved.lat;row.lng=saved.lng;row.coordinateStatus='CONFIRMED';row.coordinateSource='MANUAL_PIN';
  }};
  await f.run(`${saved.customerCode}\t합성 수동좌표 고객`);
  assert.ok(calls.length>0);assert.ok(calls.every(code=>code===saved.customerCode));
  assert.equal(f.state.newAreaResults.length,1);assert.equal(f.state.newAreaResults[0].lookupStatus,'SUCCESS');
  assert.equal(f.state.newAreaResults[0].coordinateSource,'MANUAL_PIN');assert.equal(f.state.newAreaResults[0].lat,saved.lat);
  assert.equal(f.queries.length,0);assert.equal(f.headers.length,0);
});


test('normalized saved address and separately stored lot address prevent provider replacement',async()=>{
 const existing={...saved,roadAddress:saved.address,jibunAddress:'경기도 화성시 합성동 11-2',lat:null,lng:null,coordinateStatus:'MISSING'};
 const f=fixture({rows:[existing]});
 for(const address of ['경기 화성시 합성로1 (합성빌딩)','경기 화성시 합성동11-2']){
  const result=await f.judgeNewAreaRow({address,customer:'원본 고객'});
  assert.equal(result.customerCode,existing.customerCode);
  assert.equal(result.reason,'기존 고객 좌표 확인 필요');
 }
 assert.equal(f.headers.length,0);
 assert.equal(f.queries.length,0);
});

test('interactive address uncertainty and region-prefixed place names require selection',async()=>{
 const f=fixture({lookup:(query,callback,{mode})=>{
  assert.equal(mode,query==='서울역'?'place':'address');
  callback([{address_name:'서울 종로구 합성로 14',place_name:mode==='place'?'합성역':undefined,x:'127.01',y:'37.51'}],
   'OK',{resolution:{kind:mode==='place'?'KEYWORD':'ADDRESS_OR_COORDINATE_MISMATCH'}});
 }});
 f.window.KAKAO_MAP_CONFIG.allowExternalPlaceLookup=true;
 for(const [text,kind] of [['서울역','KAKAO_PLACE_TEMPORARY'],['서울 종로구 합성로 41','KAKAO_ADDRESS_TEMPORARY']]){
  const result=await f.lookupInteractiveLocation(text);
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].coordinateSource,kind);
 }
 f.window.KAKAO_MAP_CONFIG.allowExternalPlaceLookup=false;
 assert.equal(await f.lookupInteractiveLocation('서울역'),null);
 assert.equal(f.queries.length,2);
});


test('interactive search and new-area batch locate official building evidence while paid provider is off',async()=>{
 const f=fixture({lookup:(_query,callback,{mode})=>{
   assert.equal(mode,'official');
   callback([{x:'127.01',y:'37.51'}],'OK',{resolution:{kind:'EXACT'}});
 }});
 f.window.KAKAO_MAP_CONFIG.allowExternalAddressLookup=false;
 f.window.KAKAO_MAP_CONFIG.allowIndependentAddressLookup=true;
 const address='서울 종로구 합성로 41';
 const interactive=await f.lookupInteractiveLocation(address);
 assert.equal(interactive.coordinateSource,'OFFICIAL_PUBLIC_BUILDING');
 assert.equal(interactive.coordinateAccuracy,'BUILDING');
 const batch=await f.judgeNewAreaRow({address,customer:'원본 고객'});
 assert.equal(batch.lookupStatus,'SUCCESS');
 assert.equal(batch.coordinateSource,'OFFICIAL_PUBLIC_BUILDING');
 assert.equal(batch.coordinateAccuracy,'BUILDING');
 assert.equal(f.queries.length,2);
});

test('customer lookup failure allows only the approved official evidence, even with an external provider configured',async()=>{
 const f=fixture({lookup:(text,callback,{mode})=>{
   assert.equal(mode,'official');
   if(text.includes('41'))callback([{x:'127.01',y:'37.51'}],'OK',{resolution:{kind:'EXACT'}});
   else callback([],'ZERO_RESULT');
 }});
 Object.assign(f.window.KAKAO_MAP_CONFIG,{allowIndependentAddressLookup:true,allowExternalPlaceLookup:true});
 const options={allowExternal:false};
 assert.equal((await f.lookupInteractiveLocation('서울 종로구 합성로 41',undefined,options)).coordinateSource,'OFFICIAL_PUBLIC_BUILDING');
 assert.equal(await f.lookupInteractiveLocation('서울 종로구 합성로 42',undefined,options),null);
 assert.equal(await f.lookupInteractiveLocation('서울역',undefined,options),null);
 assert.equal(f.queries.length,2);
});
