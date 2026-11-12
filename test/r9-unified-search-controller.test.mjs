import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Controller boundaries only. All customers/addresses are synthetic and no network runs.
const publicRoot=process.env.OPSMAP_QA_PUBLIC_ROOT || fileURLToPath(new URL('../public/opsmap/',import.meta.url));
const source=fs.readFileSync(path.join(publicRoot,'map-phase2b-runtime.js'),'utf8').replaceAll('\r\n','\n');
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
const controllerSource=['normalizeSearchText','normalizeSearchAddress','searchTokens','rankSearchRow','getSearchIndex','currentSearchStore','currentStageSearchCustomers','rankSearchRows','normalizeApiStore','storeSearchAddresses','newAreaRegistryRows',
 'closeUnifiedSearchResults','invalidateUnifiedSearch','clearUnifiedSearch','selectUnifiedSearchStore','applyUnifiedSearchCoordinateGuard',
 'renderResults','unifiedAddressQuery','stageAddressHashMatches','findStoredSearchRows','afterSearchPaint','startSearchTrace','search','searchPeriod'].map(declaration).join('\n');
function fixture({rows=[],remote=async()=>({data:[],meta:{}}),manual,stageAddress}={}){
 const nodes=new Map(),selected=[],fallback=[],queries=[],requests=new Map();let resets=0,tempClears=0;
 const node=key=>{if(!nodes.has(key))nodes.set(key,{dataset:{},value:'',hidden:true,html:'',replaceChildren(){this.html='';this.buttons=[];},setAttribute(k,v){this[k]=v;},dispatchEvent(){},get innerHTML(){return this.html;},set innerHTML(v){this.html=v;this.buttons=[...v.matchAll(/data-result="(\d+)"/g)].map(m=>({dataset:{result:m[1]}}));}});return nodes.get(key);};
 const context={console,AbortController,Event,setTimeout,clearTimeout,Number,Map,Set,performance,requestAnimationFrame:fn=>fn(),
  state:{mode:'BASE_60D',selected:null,searchRequestId:0,selectedDate:'2026-11-02',centerFilter:'osan',selectedVehicles:['101','122'],currentRows:rows},
  periodBasis:'vehicle',periodRows:rows,latestSnapshotRows:rows,allStores:rows,
 coordinateByCode:new Map(rows.map(row=>[row.customerCode,row])),generalRegistryRows:new Map(),storeByVehicleAndCode:new Map(),storesByCode:new Map(rows.map(row=>[row.customerCode,row])),baseVehicles:new Map(),baseVehicleStatus:'LOADING',baseVehicleMeta:null,requestControllers:requests,
  unifiedSearchController:null,unifiedSelectionActive:false,unifiedResetting:false,
  searchIndex:null,searchFlight:null,stageAddressHashIndex:null,searchInputAt:null,searchSequence:0,snapshotMeta:null,customerRegistry:null,
  stageAddressBatchEnabled:()=>!!stageAddress,NewAreaRequests:{stageAddress,temporaryPoint:()=>null,addressQuery:()=>'',addressQueries:()=>[],message:error=>error.code},Phase2bUi:{},
  $:node,$$:selector=>selector==='[data-result]'?node('#results').buttons||[]:[],
  naturalCompare:(a,b)=>String(a||'').localeCompare(String(b||''),'ko',{numeric:true}),normalizeVehicle:v=>String(v||''),numberOrNull:v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null,
  window:{MapManualPins:{apply:row=>manual?.(row)}},
  esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  setSearchState:text=>{context.lastStatus=text;},resetMapOverview:()=>{resets++;},clearSelection:()=>{context.state.selected=null;},
  cancelAddressLookup(){},clearSearchTemporaryPin(){tempClears++;},
  selectStore:row=>{context.state.selected=row;selected.push(row);},
  loadBaseVehicles:async()=>{},refreshSelectedDriverContact(){},
  fetchJson:async(url,options)=>{queries.push({url,options});return remote(decodeURIComponent(options.headers['x-map-customer-query']));},
  isSilentRequestError:e=>e?.silent||e?.name==='AbortError',
  searchExternalAddress:async(text,options)=>fallback.push({text,options})
 };
 vm.createContext(context);vm.runInContext(controllerSource,context);
 const searchPeriod=context.searchPeriod;
 context.searchPeriod=(query,trace=context.startSearchTrace())=>searchPeriod(query,trace);
 return {context,node,selected,fallback,queries,get resets(){return resets;},get tempClears(){return tempClears;}};
}
const store=(customerCode,customerName,address,more={})=>({customerCode,customerName,address,lat:37.5,lng:127.1,vehicle:'101',lastDeliveryDate:'2026-11-02',...more});

test('map idle keeps an out-of-filter selected customer in the address queue',()=>{
 const registration=source.split('\n').find(line=>line.includes("listen('idle',")&&line.includes('deferMapAddressWork'));
 assert(registration);
 const selected=store('S990100','합성 선택점','',{vehicle:'223',lat:null,lng:null}),visible=store('S990101','합성 필터점','',{vehicle:'101'});
 let idle,queued;const frames=[];
 const c={dateReady:true,markerFrame:null,addressScheduleFrame:null,state:{mode:'BASE_60D',map:{},selected,currentRows:[visible]},document:{hidden:false,body:{dataset:{mapStaffState:'authenticated'}}},window:{},listen:(_name,callback)=>{idle=callback;},requestAnimationFrame:callback=>frames.push(callback),renderStops:()=>{},scheduleVisibleAddressRows:rows=>{queued=rows;}};
 vm.runInNewContext(declaration('scheduleMapAddressWork')+declaration('deferMapAddressWork')+registration,c);idle();
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
 assert.equal(c.rankSearchRows('서울특별시 종로구 합성로 14').length,0);
});

test('local names and preserved addresses avoid the live Customer reader',async()=>{
 const row=store('S990201','합성 로컬 매장','');
 const f=fixture({rows:[row],stageAddress:async()=>({status:'STORED',customerCodes:[row.customerCode]})});
 await f.context.searchPeriod(row.customerName);
 await f.context.searchPeriod('서울 합성구 보호로 5');
 assert.deepEqual(f.selected.map(result=>result.customerCode),[row.customerCode,row.customerCode]);
 assert.equal(f.queries.length,0);
});

test('a sealed Stage address uses the generation-bound index without rebuilding the name index',async()=>{
 const row=store('S990202','합성 보존 매장',''),generation='a'.repeat(64);
 const f=fixture({rows:[row],stageAddress:async(_query,value)=>{
   assert.equal(value,generation);
   return {status:'STORED',customerCodes:[row.customerCode]};
 }});
 f.context.snapshotMeta={sourceGeneration:generation};
 await f.context.searchPeriod('서울 합성구 보호로 6');
 assert.equal(f.selected[0]?.customerCode,row.customerCode);
 assert.equal(f.context.searchIndex,null);
 assert.equal(f.queries.length,0);
});

test('expired Stage evidence is surfaced instead of falling through to live or external search',async()=>{
 const f=fixture({stageAddress:async()=>{throw Object.assign(Error('STAGE_BATCH_GENERATION_CHANGED'),{status:409,code:'STAGE_BATCH_GENERATION_CHANGED'});}});
 await f.context.searchPeriod('서울 합성구 보호로 6');
 assert.equal(f.context.lastStatus,'STAGE_BATCH_GENERATION_CHANGED');
 assert.equal(f.queries.length,0);assert.equal(f.fallback.length,0);
});

test('an exact sealed address hash uses authorized in-memory rows while changes fall back to the server',async()=>{
 const hash='b'.repeat(64),row=store('S990203','합성 해시 매장','',{originalAddressHash:hash});
 let requests=0;
 const f=fixture({rows:[row],stageAddress:async()=>{requests++;return {status:'STORED',customerCodes:[row.customerCode]};}});
 f.context.snapshotMeta={sourceGeneration:'a'.repeat(64)};
 f.context.window.MapCustomerRegistry={addressHash:async()=>hash};
 await f.context.searchPeriod('서울 합성구 보호로 7');
 assert.equal(f.selected[0]?.customerCode,row.customerCode);
 assert.equal(requests,0);
 f.context.storesByCode.set(row.customerCode,{...row,currentAddressHash:'c'.repeat(64)});
 await f.context.searchPeriod('서울 합성구 보호로 7');
 assert.equal(requests,1);
 assert.equal(f.selected.length,1,'the prior address response cannot select the changed customer');
 assert.match(f.context.lastStatus,/주소가 변경/);
});

test('exact customer selects existing manual overlay without a remote lookup or source mutation',async()=>{
 const row=store('S990001','합성 수동점','서울 합성구 시험로 1'),before=JSON.stringify(row);
 const f=fixture({rows:[row],manual:r=>{if(r.customerCode==='S990001'){r.lat=37.6;r.lng=127.2;r.coordinateSource='MANUAL_PIN';}}});
 await f.context.searchPeriod('s990001');
 assert.equal(f.queries.length,0);assert.equal(f.selected.length,1);assert.equal(f.selected[0].lat,37.6);assert.equal(f.selected[0].coordinateSource,'MANUAL_PIN');assert.equal(JSON.stringify(row),before);assert.equal(f.context.state.currentRows.length,1);assert.equal(f.node('#results').hidden,true);
});

test('unlocated existing customer opens existing detail with no invented location',async()=>{
 const f=fixture({rows:[store('B990002','합성 미확인점','서울 시험구 미확인로 2',{lat:null,lng:null})]});
 await f.context.searchPeriod('B990002');assert.equal(f.selected[0].lat,null);assert.equal(f.selected[0].lng,null);assert.match(f.context.lastStatus,/좌표 미확인/);assert.equal(f.fallback.length,0);
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

test('private address match is accepted when the public result omits its address',async()=>{
 const row=store('S990007','합성 비공개주소점','');
 const f=fixture({rows:[row],remote:async()=>({data:[{customerCode:row.customerCode,customerName:row.customerName}],meta:{matchedBy:'ADDRESS'}})});
 await f.context.searchPeriod('서울 합성구 비공개로 7');assert.equal(f.selected[0].customerCode,row.customerCode);assert.equal(f.selected[0].lat,row.lat);assert.equal(f.fallback.length,0);assert.equal(f.queries[0].options.ttl,0);
});

test('Customer failure cannot declare a new customer and does not disable an independently approved address lookup',async()=>{
 const f=fixture({remote:async()=>{throw Object.assign(Error('SOURCE_UNAVAILABLE'),{status:503});}});
 await f.context.searchPeriod('서울 합성구 미등록로 8');assert.equal(f.selected.length,0);assert.equal(f.fallback.length,1);assert.equal(f.fallback[0].options.lookupAllowed,true);assert.equal(f.fallback[0].options.customerMatchState,'UNCONFIRMED');
});

test('verified empty lookup and unverified empty lookup preserve distinct customer states',async()=>{
 for(const verified of [false,true]){const f=fixture({remote:async()=>({data:[],meta:{customerMatchVerified:verified}})});await f.context.searchPeriod('서울 합성구 새주소로 9');assert.equal(f.fallback[0].options.lookupAllowed,true);assert.equal(f.fallback[0].options.customerMatchState,verified?'NOT_IN_MASTER':'UNCONFIRMED');}
});

test('unknown exact customer code cannot become an address pin or a prefix-code match',async()=>{
 const f=fixture({remote:async()=>({data:[store('S9900100','합성 다른코드','서울 시험로 10')]})});await f.context.searchPeriod('S990010');assert.equal(f.selected.length,0);assert.equal(f.fallback.length,0);assert.match(f.context.lastStatus,/고객코드/);
});

test('a late prior search cannot overwrite the newer selection',async()=>{
 let release;const f=fixture({remote:async q=>q==='옛검색'?new Promise(r=>release=r):({data:[store('S990012','합성 최신검색','서울 시험로 12')]})});
 const old=f.context.searchPeriod('옛검색');const oldSignal=f.context.unifiedSearchController.signal;await new Promise(setImmediate);assert.equal(typeof release,'function');await f.context.searchPeriod('최신검색');assert.equal(oldSignal.aborted,true);release({data:[store('S990011','합성 옛검색','서울 시험로 11')]});await old;assert.deepEqual(f.selected.map(r=>r.customerCode),['S990012']);
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

test('clear search closes the detail without resetting the selected center or vehicles',()=>{
 const f=fixture();f.node('#query').value='기존 입력';f.node('#results').innerHTML='<button data-result="0">기존후보</button>';f.context.clearUnifiedSearch();assert.equal(f.node('#query').value,'');assert.equal(f.node('#results').hidden,true);assert.equal(f.node('#results').html,'');assert.equal(f.resets,0);assert.equal(f.tempClears,1);assert.equal(f.context.state.centerFilter,'osan');assert.deepEqual(f.context.state.selectedVehicles,['101','122']);
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
