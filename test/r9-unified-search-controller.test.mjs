import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Controller boundaries only. All customers/addresses are synthetic and no network runs.
const publicRoot=process.env.OPSMAP_QA_PUBLIC_ROOT || fileURLToPath(new URL('../public/opsmap/',import.meta.url));
const source=fs.readFileSync(path.join(publicRoot,'map-phase2b-runtime.js'),'utf8').replaceAll('\r\n','\n');
const addressHelpers=['phase2b-ui-helpers.js','new-area-requests.js'].map(file=>fs.readFileSync(path.join(publicRoot,file),'utf8'));
function declaration(name){
 const match=new RegExp('^  (?:async )?function '+name+'\\(','m').exec(source);
 assert(match,'required controller function: '+name);
 const start=match.index,lineEnd=source.indexOf('\n',start);
 if(source.slice(start,lineEnd).trim().endsWith('}'))return source.slice(start,lineEnd)+'\n';
 const end=source.indexOf('\n  }\n',lineEnd);
 assert(end>=lineEnd,'required controller function end: '+name);
 return source.slice(start,end+5)+'\n';
}
// Pick only A-owned declarations: B's interleaved temporary-pin functions remain
// interface stubs here and are exercised by the independent full-browser QA.
const controllerSource=['normalizeSearchText','normalizeSearchAddress','prepareSearchQuery','searchRowKeys','unifiedLocalSearchRows','rankSearchRow','rankSearchRows','normalizeApiStore',
 'closeUnifiedSearchResults','invalidateUnifiedSearch','clearUnifiedSearch','selectUnifiedSearchStore','applyUnifiedSearchCoordinateGuard',
 'renderResults','unifiedAddressQuery','search','searchPeriod'].map(declaration).join('\n');
function fixture({rows=[],remote=async()=>({data:[],meta:{}}),manual}={}){
 const nodes=new Map(),selected=[],fallback=[],queries=[],requests=new Map();let resets=0,tempClears=0;
 const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',hidden:true,html:'',replaceChildren(){this.html='';this.buttons=[];},setAttribute(k,v){this[k]=v;},dispatchEvent(){},get innerHTML(){return this.html;},set innerHTML(v){this.html=v;this.buttons=[...v.matchAll(/data-result="(\d+)"/g)].map(m=>({dataset:{result:m[1]}}));}});return nodes.get(key);};
 const context={console,AbortController,Event,setTimeout,clearTimeout,Number,Map,Set,
  state:{mode:'BASE_60D',selected:null,searchRequestId:0,selectedDate:'2026-11-02',currentRows:rows},
  periodBasis:'vehicle',periodRows:rows,latestSnapshotRows:rows,allStores:rows,
  coordinateByCode:new Map(rows.map(row=>[row.customerCode,row])),storeByVehicleAndCode:new Map(),storesByCode:new Map(rows.map(row=>[row.customerCode,row])),baseVehicles:new Map(),requestControllers:requests,
  unifiedSearchController:null,unifiedSelectionActive:false,unifiedResetting:false,unifiedSearchIndex:null,unifiedSearchKeys:new WeakMap(),
  $:node,$$:selector=>selector==='[data-result]'?node('#results').buttons||[]:[],
  naturalCompare:(a,b)=>String(a||'').localeCompare(String(b||''),'ko',{numeric:true}),normalizeVehicle:v=>String(v||''),numberOrNull:v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null,
  window:{MapManualPins:{apply:row=>manual?.(row)}},
  esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  setSearchState:text=>{context.lastStatus=text;},resetMapOverview:()=>{resets++;},
  cancelAddressLookup(){},clearSearchTemporaryPin(){tempClears++;},
  selectStore:row=>{context.state.selected=row;selected.push(row);},
  loadBaseVehicles:async()=>{},refreshSelectedDriverContact(){},
  fetchJson:async(url,options)=>{queries.push({url,options});return remote(decodeURIComponent(options.headers['x-map-customer-query']));},
  isSilentRequestError:e=>e?.silent||e?.name==='AbortError',
  searchExternalAddress:async(text,options)=>fallback.push({text,options})
 };
 vm.createContext(context);
 for(const helper of addressHelpers)vm.runInContext(helper,context);
 context.Phase2bUi=context.window.Phase2bUi;
 context.NewAreaRequests=context.window.NewAreaRequests;
 vm.runInContext(controllerSource,context);
 return {context,node,selected,fallback,queries,get resets(){return resets;},get tempClears(){return tempClears;}};
}
const store=(customerCode,customerName,address,more={})=>({customerCode,customerName,address,lat:37.5,lng:127.1,vehicle:'101',lastDeliveryDate:'2026-11-02',...more});

test('map idle keeps an out-of-filter selected customer in the address queue',()=>{
 const registration=source.split('\n').find(line=>line.includes("listen('idle',")&&line.includes('deferMapAddressWork'));
 assert(registration);
 const selected=store('S990100','합성 선택점','',{vehicle:'223',lat:null,lng:null});
 const visible=store('S990101','합성 필터점','',{vehicle:'101',lat:null,lng:null});
 const frames=[];
 let idle,queued;
 const c={dateReady:true,markerFrame:null,addressScheduleFrame:null,customerRegistry:null,window:{},
  document:{hidden:false,body:{dataset:{mapStaffState:'authenticated'}}},
  state:{map:{},mode:'BASE_60D',selected,currentRows:[visible]},listen:(name,callback)=>{idle=callback;},
  requestAnimationFrame:callback=>frames.push(callback),renderStops:()=>{},liveAddressLocations:{schedule:rows=>{queued=rows;}}};
 const functions=['scheduleVisibleAddressRows','scheduleMapAddressWork','deferMapAddressWork'].map(declaration).join('\n');
 vm.runInNewContext(functions+'\n'+registration,c);
 idle();
 while(frames.length)frames.shift()();
 assert.equal(queued[0],selected);assert(queued.includes(visible));
});

test('search address normalization preserves building numbers and province aliases',()=>{
 const {context:c}=fixture();
 assert.equal(c.normalizeSearchAddress('서울특별시 강남구 합성로 14 (합성동)'),c.normalizeSearchAddress('서울 강남구 합성로14'));
 assert.equal(c.normalizeSearchAddress('전북특별자치도 군산시 시험길 5-6'),c.normalizeSearchAddress('전북 군산시 시험길5-6'));
 assert.notEqual(c.normalizeSearchAddress('서울 합성로 5-6'),c.normalizeSearchAddress('서울 합성로 56'));
});
test('existing local addresses cannot confuse building 14 with 140 or 14-1',()=>{
 const rows=[store('S990001','합성 다른건물','서울 종로구 합성로 140'),store('S990002','합성 다른번지','서울 종로구 합성로 14-1')],{context:c}=fixture({rows});
 assert.equal(c.rankSearchRows(rows,'서울특별시 종로구 합성로 14').length,0);
});

test('exact customer selects existing manual overlay without a remote lookup or source mutation',async()=>{
 const row=store('S990001','합성 수동점','서울 합성구 시험로 1'),before=JSON.stringify(row);
 const f=fixture({rows:[row],manual:r=>{if(r.customerCode==='S990001'){r.lat=37.6;r.lng=127.2;r.coordinateSource='MANUAL_PIN';}}});
 await f.context.searchPeriod('s990001');
 assert.equal(f.queries.length,0);assert.equal(f.selected.length,1);assert.equal(f.selected[0].lat,37.6);assert.equal(f.selected[0].coordinateSource,'MANUAL_PIN');assert.equal(JSON.stringify(row),before);assert.equal(f.context.state.currentRows.length,1);assert.equal(f.node('#results').hidden,true);
});

test('unlocated existing customer opens existing detail with no invented location',async()=>{
 const f=fixture({rows:[store('B990002','합성 미확인점','서울 시험구 미확인로 2',{lat:null,lng:null})]});
 await f.context.searchPeriod('B990002');assert.equal(f.selected[0].lat,null);assert.equal(f.selected[0].lng,null);assert.match(f.context.lastStatus,/위치 확인 필요/);assert.equal(f.fallback.length,0);
});

test('duplicate names expose one candidate per customer and close after choosing',async()=>{
 const rows=[store('S990003','합성 같은점','서울 합성구 시험로 3'),store('S990004','합성 같은점','서울 합성구 시험로 4')];
 const f=fixture({rows,remote:async()=>({data:[rows[0],rows[0],rows[1]]})});await f.context.searchPeriod('합성 같은점');
 assert.equal(f.selected.length,0);assert.equal(f.node('#results').buttons.length,2);f.node('#results').buttons[1].onclick();assert.equal(f.selected[0].customerCode,'S990004');assert.equal(f.node('#results').hidden,true);assert.equal(f.node('#results').html,'');
});

test('same-building customers retain separate codes and detail addresses',async()=>{
 const rows=[store('S990005','합성 입점A','서울특별시 합성구 테스트로 5',{detailAddress:'1층'}),store('S990006','합성 입점B','서울특별시 합성구 테스트로 5',{detailAddress:'2층'})];
 const f=fixture({rows});await f.context.searchPeriod('서울 합성구 테스트로5');assert.equal(f.node('#results').buttons.length,2);f.node('#results').buttons[0].onclick();assert.equal(f.selected[0].customerCode,'S990005');assert.equal(f.selected[0].detailAddress,'1층');assert.equal(f.context.state.currentRows.length,2);
});

test('one already loaded address can be selected before a stalled Customer lookup',async()=>{
 const row=store('S990018','합성 즉시 주소점','서울 종로구 합성로 18');
 let release;
 const f=fixture({rows:[row],remote:()=>new Promise(resolve=>{release=resolve;})});
 const pending=f.context.searchPeriod('서울특별시 종로구 합성로18');
 assert.equal(f.node('#results').buttons.length,1);
 assert.match(f.context.lastStatus,/저장된 매장 1건/);
 f.node('#results').buttons[0].onclick();
 assert.equal(f.selected[0].customerCode,row.customerCode);
 release({data:[store('S990019','합성 지연점',row.address)],meta:{}});
 await pending;
 assert.deepEqual(f.selected.map(x=>x.customerCode),[row.customerCode]);
 assert.equal(f.fallback.length,0);
});

test('the loaded address catalogue prefers current rows and refreshes after source replacement',async()=>{
 const old=store('S990020','합성 주소 이전점','서울 종로구 합성로 20');
 const next={...old,address:'서울 중구 합성로 30',lat:null,lng:null,addressChanged:true,coordinateStatus:'CONFLICT'};
 const f=fixture({rows:[old]});
 const c=f.context;
 await c.searchPeriod(old.address);
 assert.equal(f.selected.length,1);
 c.allStores=[next];c.storesByCode.set(old.customerCode,next);
 await c.searchPeriod(old.address);
 assert.equal(f.selected.length,1);
 await c.searchPeriod(next.address);
 assert.equal(f.selected.length,2);
 assert.equal(f.selected[1].address,next.address);
 assert.equal(f.selected[1].lat,null);
});

test('private address match is accepted when the public result omits its address',async()=>{
 const row=store('S990007','합성 비공개주소점','');
 const f=fixture({rows:[row],remote:async()=>({data:[{customerCode:row.customerCode,customerName:row.customerName}],meta:{matchedBy:'ADDRESS'}})});
 await f.context.searchPeriod('서울 합성구 비공개로 7');assert.equal(f.selected[0].customerCode,row.customerCode);assert.equal(f.selected[0].lat,row.lat);assert.equal(f.fallback.length,0);assert.equal(f.queries[0].options.ttl,0);
});

test('Customer failure cannot declare a new customer or invoke external lookup',async()=>{
 const f=fixture({remote:async()=>{throw Object.assign(Error('SOURCE_UNAVAILABLE'),{status:503});}});
 await f.context.searchPeriod('서울 합성구 미등록로 8');assert.equal(f.selected.length,0);assert.equal(f.fallback.length,1);assert.equal(f.fallback[0].options.lookupAllowed,false);assert.equal(f.fallback[0].options.customerMatchState,'UNCONFIRMED');
});

test('verified empty lookup and unverified empty lookup preserve distinct customer states',async()=>{
 for(const verified of [false,true]){const f=fixture({remote:async()=>({data:[],meta:{customerMatchVerified:verified}})});await f.context.searchPeriod('서울 합성구 새주소로 9');assert.equal(f.fallback[0].options.lookupAllowed,true);assert.equal(f.fallback[0].options.customerMatchState,verified?'NOT_IN_MASTER':'UNCONFIRMED');}
});

test('an apartment name without a building or lot number stays in store search',async()=>{
 const f=fixture();
 for(const text of ['합성아파트','서울 합성구 합성아파트']){
  await f.context.searchPeriod(text);
  assert.match(f.context.lastStatus,/도로명과 건물번호 또는 동·리와 지번/);
 }
 assert.equal(f.queries.length,2);
 assert.equal(f.fallback.length,0);
 await f.context.searchPeriod('합성리 산 123-4');
 assert.equal(f.fallback[0].text,'합성리 산 123-4');
});

test('exact address search waits for the existing permission check and ignores stale results',async()=>{
 const {context:c}=fixture();
 const point={lat:37.5,lng:127.1},finished=[];
 let release;
 Object.assign(c,{addressController:null,geocodeAddress:async()=>point,finishAddress:value=>finished.push(value),
  waitForSearchMapPoint:()=>assert.fail('pending permission became a map fallback')});
 c.state.map={};
 c.state.addressRequestId=0;
 c.window.KakaoMapsAdapter={refreshAddressLookup:()=>new Promise(resolve=>{
  release=()=>{c.window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:true};resolve();};
 })};
 vm.runInContext(declaration('searchExternalAddress'),c);

 const stale=c.searchExternalAddress('서울 합성구 시험로 10');
 assert.equal(c.lastStatus,'주소검색 연결 확인 중');
 c.state.searchRequestId++;
 release();
 await stale;
 assert.equal(finished.length,0);

 c.window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};
 const current=c.searchExternalAddress('서울 합성구 시험로 11');
 release();
 await current;
 assert.deepEqual(finished,[point]);
});

test('unknown exact customer code cannot become an address pin or a prefix-code match',async()=>{
 const f=fixture({remote:async()=>({data:[store('S9900100','합성 다른코드','서울 시험로 10')]})});await f.context.searchPeriod('S990010');assert.equal(f.selected.length,0);assert.equal(f.fallback.length,0);assert.match(f.context.lastStatus,/고객코드/);
});

test('a late prior search cannot overwrite the newer selection',async()=>{
 let release;const f=fixture({remote:async q=>q==='옛검색'?new Promise(r=>release=r):({data:[store('S990012','합성 최신검색','서울 시험로 12')]})});
 const old=f.context.searchPeriod('옛검색');const oldSignal=f.context.unifiedSearchController.signal;await f.context.searchPeriod('최신검색');assert.equal(oldSignal.aborted,true);release({data:[store('S990011','합성 옛검색','서울 시험로 11')]});await old;assert.deepEqual(f.selected.map(r=>r.customerCode),['S990012']);
});

test('address-change conflict never reuses the previous customer location',async()=>{
 const local=store('S990013','합성 주소변경점','');
 const f=fixture({rows:[local],remote:async()=>({data:[{customerCode:local.customerCode,customerName:local.customerName,addressChanged:true,coordinateStatus:'CONFLICT',lat:null,lng:null}]})});
 await f.context.searchPeriod('서울 합성구 변경주소로 13');assert.equal(f.selected[0].lat,null);assert.equal(f.selected[0].lng,null);assert.equal(local.lat,37.5);
});

test('a previously loaded manual projection cannot reapply after a verified address conflict',async()=>{
 const f=fixture({remote:async()=>({data:[store('S990016','합성 수동주소변경점','',{coordinateStatus:'CONFLICT'})]}),manual:r=>{r.lat=37.6;r.lng=127.2;r.coordinateSource='MANUAL_PIN';r.coordinateStatus='CONFIRMED';delete r.resolutionStatus;}});
 await f.context.searchPeriod('S990016');const row=f.selected[0];assert.equal(row.lat,null);
 f.context.window.MapManualPins.apply(row);assert.equal(row.lat,37.6);
 f.context.applyUnifiedSearchCoordinateGuard(row);assert.equal(row.lat,null);assert.equal(row.lng,null);assert.equal(row.resolutionStatus,'ADDRESS_CHANGED_REVIEW_REQUIRED');
});

test('zero and swapped coordinates are never selected as valid points',async()=>{
 for(const [lat,lng] of [[0,0],[127,37.5]]){const f=fixture({remote:async()=>({data:[store('S990014','합성 잘못된점','',{lat,lng})]})});await f.context.searchPeriod('S990014');assert.equal(f.selected[0].lat,null);assert.equal(f.selected[0].lng,null);}
});

test('optional master enrichment does not delay existing customer selection',async()=>{
 const f=fixture({rows:[store('S990015','합성 즉시선택','서울 시험로 15')]});f.context.loadBaseVehicles=()=>new Promise(()=>{});await f.context.searchPeriod('S990015');assert.equal(f.selected.length,1);
});

test('selecting a customer with a loaded base vehicle does not refetch the bulk master',async()=>{
 const row=store('S990022','합성 호차 확인점','서울 시험로 22'),f=fixture({rows:[row]});
 f.context.baseVehicles.set(row.customerCode,{baseVehicle:'101'});
 f.context.loadBaseVehicles=()=>assert.fail('loaded master should not be fetched on selection');
 await f.context.searchPeriod(row.customerCode);
 assert.equal(f.selected[0].customerCode,row.customerCode);
 assert.equal(f.selected[0].vehicle,'101');
});

test('clear search removes only search state and invokes the existing overview reset',()=>{
 const f=fixture();f.node('#query').value='기존 입력';f.node('#results').innerHTML='<button data-result="0">기존후보</button>';f.context.clearUnifiedSearch();assert.equal(f.node('#query').value,'');assert.equal(f.node('#results').hidden,true);assert.equal(f.node('#results').html,'');assert.equal(f.resets,1);assert.equal(f.tempClears,1);
});


test('manual projection refresh preserves an already verified search address conflict',()=>{
 const f=fixture({manual:r=>{r.lat=37.6;r.lng=127.2;r.coordinateStatus='CONFIRMED';delete r.resolutionStatus;}});
 Object.assign(f.context,{indexedRows:null,pointIndex:null,liveAddressLocations:null,refreshCoordinateEvidence(){},cancelManualRoadRoute(){},loadBaseMap:async()=>{}});
 f.context.window.dispatchEvent=()=>{};
 f.context.state.selected={customerCode:'S990017',searchAddressConflict:true,lat:null,lng:null};
 const start=source.indexOf('refreshManualCoordinates(){'),end=source.indexOf('},',start)+1;
 vm.runInContext('({'+source.slice(start,end)+'}).refreshManualCoordinates()',f.context);
 assert.equal(f.context.state.selected.lat,null);assert.equal(f.context.state.selected.lng,null);assert.equal(f.context.state.selected.resolutionStatus,'ADDRESS_CHANGED_REVIEW_REQUIRED');
});
