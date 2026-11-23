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
const areaRequests=fs.readFileSync(new URL('../public/opsmap/new-area-requests.js',import.meta.url),'utf8');
const exposed=runtime.slice(0,runtime.indexOf('\n  initVehicles();'))+`
window.qa={state,runNewArea,clearNewAreaBatch,judgeNewAreaRow,judgeNewAreaPoint,lookupInteractiveLocation,
setGeneration(value){snapshotMeta={...snapshotMeta,sourceGeneration:value};},
setup(saved){state.rangeStart='2026-09-01';state.rangeEnd='2026-11-02';dateReady=false;
  periodRows=[];periodMeta={complete:false};latestSnapshotRows=saved;allStores=saved;
  for(const row of saved){storesByCode.set(row.customerCode,row);coordinateByCode.set(row.customerCode,row);if(row.vehicle)baseVehicles.set(row.customerCode,{baseVehicle:row.vehicle});}},
saved:()=>latestSnapshotRows};})();`;
const saved={customerCode:'S990001',customerName:'합성 저장매장',address:'경기도 화성시 합성로 1',lat:37.2,lng:127,vehicle:'101'};
function fixture({rows=[],stageBatch,verifiedStage=false,customer=()=>({data:[],meta:{complete:true}}),lookup=(query,callback)=>callback([{address_name:query,x:'127',y:'37.2'}],'OK')}={}){
  const nodes=new Map(),headers=[],queries=[],batches=[],listeners=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,batchDomNode());return nodes.get(id);};
  const window={addEventListener(event,fn){listeners.set(event,[...(listeners.get(event)||[]),fn]);},VEHICLE_AREA_DATA:{vehicles:[]},ManualWaypoints:globalThis.ManualWaypoints,
    KAKAO_MAP_CONFIG:{allowExternalAddressLookup:true},kakaoGeocoder:{serverProxy:true,addressSearch(query,callback,options){queries.push(query);lookup(query,callback,options);}}};
  if(stageBatch)window.location={origin:'https://freshon-admin-stage-preview-template.onrender.com'};
  const fetch=async(url,options)=>{
    if(stageBatch&&url==='/api/map-phase2b/private/stage-address-evidence'){
      assert.equal(options.method,'POST');
      const body=JSON.parse(options.body);
      batches.push(body);
      const {status=200,payload}=stageBatch(body);
      return {ok:status===200,status,headers:{get(){return null;}},json:async()=>payload};
    }
    assert.equal(url,'/api/map-phase2b/private/customer-search');
    assert.equal(options.method,undefined);
    const query=decodeURIComponent(options.headers['x-map-customer-query']);headers.push(query);
    const payload=await customer(query);
    return {ok:payload.ok!==false,status:payload.ok===false?503:200,headers:{get(){return null;}},json:async()=>payload};
  };
  const context=vm.createContext({window,document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},createElement:batchDomTemplate,body:{dataset:{}}},
    MapPeriodUi:globalThis.MapPeriodUi,Phase2bUi:globalThis.Phase2bUi,NewAreaRequests:globalThis.NewAreaRequests,
    location:{href:'https://example.invalid/opsmap/'},fetch,Map,Set,URL,URLSearchParams,AbortController,AbortSignal,Date,Intl,Number,performance,setTimeout,clearTimeout,innerWidth:1440});
  let staff={authenticated:true,expiresAt:Date.now()+600_000,idleExpiresAt:Date.now()+60_000};
  if(verifiedStage){
    window.MapStaffEntry={session:()=>staff};
    window.Phase2bUi=globalThis.Phase2bUi;
    vm.runInContext(areaRequests,context);
    context.NewAreaRequests=window.NewAreaRequests;
  }
  vm.runInContext(exposed,context);window.qa.setup(rows);
  if(verifiedStage)window.qa.setGeneration('a'.repeat(64));
  const run=input=>{node('#newAreaBatchInput').value=input;return window.qa.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');};
  return {...window.qa,window,node,run,headers,queries,batches,logout(){
    staff={authenticated:false};for(const fn of listeners.get('map-staff-signed-out')||[])fn();
  }};
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
    assert.equal(query(input),globalThis.Phase2bUi.addressVariants(input)[0]);
  }
  assert.equal(query('합성건물 고객정보만'), '');
  assert.equal(query('합성건물 (경기 안성시 일죽면 서동대로 7184)'), '');
});

test('paste and address normalization preserve original cells, unit text and exact building identity',()=>{
  const raw='  서울동대문구 합성로40번길7 （법정동, 합성건물） 101동 803호  ';
  const row=globalThis.NewAreaRequests.parseAreaInput(raw+'\t"상호"')[0];
  assert.deepEqual([row.originalAddress,row.originalCustomer,row.originalInput],[raw,'상호',raw+'\t"상호"']);
  assert.deepEqual([row.inputKind,row.lookupAddress,row.detailAddress,row.addressAnnotations],
    ['ROAD','서울 동대문구 합성로40번길 7','101동 803호',['(법정동, 합성건물)']]);
  assert.deepEqual(globalThis.Phase2bUi.addressVariants(raw,{equivalents:true}),
    ['서울 동대문구 합성로40번길 7','서울특별시 동대문구 합성로40번길 7']);
  assert.deepEqual(queryChoices(raw),['서울 동대문구 합성로40번길 7']);
  assert.equal(query('경기 성남시 분당구 합성동34 − 4번지'),'경기 성남시 분당구 합성동 34-4');
  assert.equal(query('경기 성남시 분당구 합성동 34 -'),'');
  assert.equal(globalThis.Phase2bUi.addressMatches('서울 동대문구 합성로 80','서울특별시 동대문구 합성로 80'),true);
  assert.equal(globalThis.Phase2bUi.addressMatches('서울 동대문구 합성로 80','서울특별시 동대문구 새합성로 80'),false);
  assert.equal(globalThis.Phase2bUi.addressMatches('서울 동대문구 합성로 80','서울특별시 동대문구 합성로 80-1'),false);
  assert.equal(globalThis.Phase2bUi.addressMatches('경기 성남시 분당구 합성동 산34-4','경기도 성남시 분당구 합성동 산 34-4번지'),true);
  const rows=globalThis.NewAreaRequests.parseAreaInput('ｓ１２３４\t업체\n'+raw+'\t업체\t기타');
  assert.deepEqual(rows.map(row=>row.inputKind),['CUSTOMER_CODE','AMBIGUOUS']);
  assert.deepEqual(globalThis.NewAreaRequests.batchAddressQueries(rows),{inputs:[['S1234']],indexes:[0,-1]});
});

test('the protected batch can match historical district names without adding external provider queries',()=>{
  for(const [address,primary,alias] of [
    ['인천 검단구 합성로40번길 7 (원당동)','인천 검단구 합성로40번길 7','인천광역시 서구 합성로40번길 7'],
    ['전남광주통합특별시 목포시 합성로 21','전남광주통합특별시 목포시 합성로 21','전라남도 목포시 합성로 21'],
    ['전남광주통합특별시 고흥군 고흥읍 합성길 21','전남광주통합특별시 고흥군 고흥읍 합성길 21','전라남도 고흥군 고흥읍 합성길 21']
  ]){
    assert.deepEqual(queryChoices(address),[primary]);
    assert.deepEqual(globalThis.NewAreaRequests.batchAddressQueries([{address}]),{inputs:[[primary,alias]],indexes:[0]});
  }
});

test('balanced address annotations and floor text stay out of the lookup identity',()=>{
  const inputs=[
    ['경기 고양시 일산서구 강선로 30 (주엽동, 강선마을15단지아파트)','경기 고양시 일산서구 강선로 30'],
    ['서울 중구 장충단로 72 (장충동2가, 한국자유총연맹) 1층','서울 중구 장충단로 72'],
    ['서울 중구 (장충동2가, 한국자유총연맹) 장충단로72 (본관(별관)) 1층','서울 중구 장충단로 72'],
    ['서울 중구 장충단로 [본관] 72（한국자유총연맹） 별관','서울 중구 장충단로 72'],
    ['경기 양주시 남면 황방리386 [건물] 1층','경기 양주시 남면 황방리 386'],
    ['서울 중구 장충동2가 산3-2 (건물명) 3층','서울 중구 장충동2가 산3-2']
  ];
  for(const [input,expected] of inputs){
    assert.equal(query(input),expected);
    assert.equal(globalThis.Phase2bUi.addressLookupText(input),expected);
  }
  assert.equal(query('서울 중구 (장충동2가) 141'), '');
  assert.equal(query('서울 중구 장충단로 72 (별관'), '');
  assert.equal(query('서울 중구 장충단로 72 서울 종로구 새문안로 1'), '');
  assert.equal(globalThis.Phase2bUi.addressMatches('서울 중구 장충단로 72','부산 중구 장충단로 72'),false);
  assert.equal(globalThis.Phase2bUi.addressMatches('서울 중구 장충동2가 산3-2','서울 중구 장충동2가 3-2'),false);
});

test('46 Stage rows use one protected batch and preserve cells when the batch or source is incomplete',async()=>{
  const lines=Array.from({length:46},(_,index)=>{
    const address=index===45?'원문 주소 미확인':`경기도 화성시 합성로 ${index%24+1} (합성동, 본관) ${index+1}층`;
    return {address,customer:`검증용 ${index+1}`};
  });
  for(const status of [200,400,409,503]){
    const stageBatch=({generation,rows})=>({status,payload:status===200?{generation,data:rows.map((_,index)=>index<12
      ?{status:'STORED',point:{lat:37.2,lng:127,coordinateSource:'STAGE_PRESERVED_COORDINATE'}}
      :{status:'ADDRESS_NOT_MATCHED'})}:{error:'STAGE_BATCH_UNAVAILABLE'}});
    const f=fixture({rows:[saved],stageBatch});
    await f.run(lines.map(({address,customer})=>address+'\t'+customer).join('\n'));
    assert.equal(f.batches.length,1);
    assert.equal(f.batches[0].rows.length,24);
    assert.equal(f.headers.length+f.queries.length,0);
    assert.equal(f.state.newAreaResults.length,46);
    f.state.newAreaResults.forEach((row,index)=>assert.deepEqual([row.originalAddress,row.originalCustomer],
      [lines[index].address,lines[index].customer]));
    assert.equal(f.state.newAreaResults.filter(row=>row.lookupStatus==='SUCCESS').length,status===200?24:0);
    if(status!==200)assert.equal(f.state.newAreaResults[0].lookupHttpStatus,status);
  }
});

test('Stage keeps one request for new rows and never reuses held results, revoked staff or another generation',async()=>{
  let status=200;
  const f=fixture({rows:[saved],verifiedStage:true,stageBatch:({generation,rows})=>status===200
    ?{payload:{generation,data:rows.map(([address])=>address.endsWith(' 99')?{status:'ADDRESS_NOT_MATCHED'}:
      {status:'STORED',point:{lat:37.2,lng:127,coordinateSource:'STAGE_PRESERVED_COORDINATE'}})}}
    :{status,payload:{error:'STAGE_BATCH_GENERATION_CHANGED'}}});
  const addresses=Array.from({length:46},(_,index)=>`경기도 화성시 합성로 ${index+1} (본관) 2층`);
  const paste=values=>f.run(values.map((address,index)=>address+'\t'+index).join('\n'));
  await paste(addresses);
  assert.deepEqual(f.batches.map(call=>call.rows.length),[46]);
  const before=JSON.stringify(f.state.newAreaResults.map(row=>[row.originalAddress,row.lat,row.lng,row.decision]));
  await paste(addresses);
  assert.deepEqual(f.batches.map(call=>call.rows.length),[46]);
  assert.equal(JSON.stringify(f.state.newAreaResults.map(row=>[row.originalAddress,row.lat,row.lng,row.decision])),before);
  const mixed=[...addresses.slice(0,-1),'경기도 화성시 합성로 99 (별관)'];
  await paste(mixed);
  await paste(mixed);
  assert.deepEqual(f.batches.map(call=>call.rows.length),[46,1,1]);
  assert.equal(f.state.newAreaResults.at(-1).lookupStatus,'DEFERRED');
  status=409;
  await paste(mixed);
  assert(f.state.newAreaResults.every(row=>row.lookupStatus==='FAILED'));
  status=200;
  f.setGeneration('b'.repeat(64));
  await paste(addresses);
  assert.equal(f.batches.at(-1).rows.length,46);
  f.logout();
  status=401;
  await paste(addresses);
  assert.equal(f.batches.at(-1).rows.length,46);
  assert(f.state.newAreaResults.every(row=>row.lookupState==='LOOKUP_BLOCKED'));
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
    assert.equal(row.nearestStoreCode,saved.customerCode);assert.equal(row.nearestDispatch.length,0);
    assert.equal(row.eligibilityBasis,'FIXED_REGISTRY_500M');assert.equal(row.nearestDispatchLabel,'미확인');
    assert.equal(f.queries[i],`경기도 화성시 합성로 ${i+100}`);assert.equal(f.headers[i],f.queries[i]);
  }
  const exported=globalThis.MapPeriodUi.areaExportRows(f.state.newAreaResults,'2026-11-03');
  assert.deepEqual(Array.from(exported,row=>Array.from(row).slice(0,2)),cells.map(({x,y})=>[x,y]));
  assert.match(f.node('#newAreaBatchStatus').textContent,/처리 60 · 위치 확인 60 .*후보·입력 검토 0 · 자료 범위 밖 0 · 권한·한도 0 · 조회 실패 0/);
  assert.match(f.node('#newAreaBatchResults').innerHTML,/가장 가까운 등록 매장\(직선거리\)/);
  assert.doesNotMatch(f.node('#newAreaBatchResults').innerHTML,/참고 배차호차/);
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
  assert.equal(f.queries.length,4);assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 2 .*후보·입력 검토 1 · 자료 범위 밖 1 · 권한·한도 0 · 조회 실패 1/);
});

for(const code of ['KAKAO_HTTP_REJECTED','GEOCODE_DAILY_LIMIT'])test(`${code} stops subsequent REST calls but finishes every row and reuses saved coordinates`,async()=>{
  const f=fixture({rows:[saved],lookup:(_query,callback)=>callback([],'ERROR',{code,status:code==='GEOCODE_DAILY_LIMIT'?429:502})});
  await f.run('경기도 화성시 합성로 2\t합성1\n경기도 화성시 합성로 3\t합성2\n경기도 화성시 합성로 1\t합성3');
  assert.equal(f.state.newAreaResults.length,3);assert.equal(f.queries.length,1);assert.equal(f.state.newAreaResults[2].lookupStatus,'SUCCESS');
  if(code==='GEOCODE_DAILY_LIMIT'){
    assert.equal(f.state.newAreaResults[0].lookupStatus,'LIMIT');assert.equal(f.state.newAreaResults[1].lookupStatus,'LIMIT');
    assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 1 .*자료 범위 밖 0 · 권한·한도 2 · 조회 실패 0/);
  }else{
    assert.equal(f.state.newAreaResults[0].lookupStatus,'FAILED');assert.equal(f.state.newAreaResults[1].lookupStatus,'DEFERRED');
    assert.match(f.node('#newAreaBatchStatus').textContent,/위치 확인 1 .*자료 범위 밖 1 · 권한·한도 0 · 조회 실패 1/);
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
  assert.match(f.node('#newAreaBatchStatus').textContent,/처리 60 · 위치 확인 60 .*후보·입력 검토 0 · 자료 범위 밖 0 · 권한·한도 0 · 조회 실패 0/);
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
