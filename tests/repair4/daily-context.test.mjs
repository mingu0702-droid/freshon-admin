import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../public/map-phase2b-runtime.js',import.meta.url),'utf8');
// Execute the shipped functions, with only map/DOM/network boundaries replaced.
// The assertions below exercise transitions and promises, not source spelling.
function extractFunction(name){
  const match=new RegExp('^  (?:async )?function '+name+'\\(', 'm').exec(source);
  if(!match)throw Error('Runtime function missing: '+name);
  const start=match.index,lineEnd=source.indexOf('\n',start),firstLine=source.slice(start,lineEnd).trim();
  if(firstLine.endsWith('}'))return firstLine;
  const end=source.indexOf('\n  }',lineEnd);
  if(end<0)throw Error('Runtime function boundary missing: '+name);
  return source.slice(start,end+4);
}
const functions=['switchMode','selectLatestRoute','changeSelectedDate','replaceStoreSnapshot','normalizeStore','numberOrNull','normalizeVehicle','matchesDatedDriver','isDailyDataReady','filteredDateStores','dedupeRouteStops','loadBaseMap'];
const navigationLine=source.split('\n').find(line=>/^\s*navigationStores:\(\)=>/.test(line));
if(!navigationLine)throw Error('Runtime navigation bridge missing');
const navigationSource=navigationLine.trim().replace(/,$/,'');
const DAY='2026-10-23',NEW_DAY='2026-10-24',TODAY='2026-10-28';
const record=(customerCode,date=DAY,vehicle='101')=>({customerCode,customerName:'매장 '+customerCode,deliveryDate:date,lastDeliveryDate:date,vehicle,lat:37.5,lng:127,history:[{deliveryDate:date,vehicle,count:1}]});
const response=(date=DAY,rows=[record('S1',date)],extra={})=>({data:rows,meta:{complete:true,date,...extra}});
const codes=rows=>Array.from(rows,row=>row.customerCode);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(options={}){
  const nodes=new Map(),events=[],reads=[],renders=[],uiCalls=[],errors=[];
  const getNode=selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',innerHTML:'',value:'',title:'',hidden:false,open:false,replaceChildren(){this.innerHTML='';},setAttribute(){}});return nodes.get(selector);};
  const general=[record('S_GENERAL','2026-10-10','199')];
  const adapter={cancel(){},closePeriod(){},
    readPeriodStatus:options.status||(()=>Promise.resolve({ready:false,reviewOnly:true,availableReviewDate:DAY})),
    readDate:date=>{reads.push(date);return (options.readDate||((date)=>Promise.resolve(response(date))))(date);}
  };
  const context={
    state:{mode:'BASE_60D',selectedVehicles:[],centerFilter:'',driverKey:'',selectedDate:'',latestDate:'',routeDate:'',currentRows:general.slice(),routeRows:[],selected:null,map:null,areaOn:false,searchRequestId:0,addressRequestId:0,detailRequestId:0,todayRequestId:0,routeRequestId:0,rangeStart:'',rangeEnd:''},
    dateReady:true,datedSourceDate:'',dailyMeta:null,generalMap:true,generalAllStores:true,
    initialRequestId:0,initialTimer:null,periodRequestId:0,periodTimer:null,dateRequestId:0,
    periodBasis:'vehicle',periodVehicleScope:'all',selectedDriverKeys:[],modeViewInitialized:false,
    modeViews:{BASE_60D:{vehicles:[],scope:'all',areaOn:false,centerFilter:''},DATE_ROUTE:{vehicles:[],scope:'all',areaOn:false,centerFilter:''}},
    operationStops:[],allStores:general.slice(),latestSnapshotRows:general.slice(),snapshotMeta:null,
    periodRows:[],periodMeta:null,datedDriverEvidence:null,modelStatus:null,baseVehicleStatus:'UNKNOWN',baseVehicleMeta:null,snapshotReadState:'ready',
    storeByVehicleAndCode:new Map(),storesByCode:new Map(),baseVehicles:new Map(),SOURCE:{vehicles:[]},
    hybridUi:adapter,hybridUiReady:Promise.resolve(adapter),
    window:{MAP_ROLLING_DATE_INDEX_ENABLED:options.rolling!==false,LOCAL_REVIEW_CONFIG:{date:options.reviewDate??DAY},dispatchEvent:event=>events.push(event)},
    CustomEvent:class{constructor(type,{detail}={}){this.type=type;this.detail=detail;}},Event:class{constructor(type){this.type=type;}},
    $:getNode,clearTimeout,localDate:()=>TODAY,vehicleColor:()=> '#2563eb',vehicleLabel:v=>String(v||''),
    closeClusterPanel(){uiCalls.push('closeCluster');},cancelManualRoadRoute(){},clearSelection(){context.state.selected=null;},cancelAddressLookup(){},cancelNewAreaWork(){},resetRoadRoute(){},
    requestMapFit(){context.state.fitRequested=true;},refreshVehicleUi(){},syncBoundaryButtons(){},activateSheet(){},syncModeUi(){},updateDateRange(){},clearNewAreaBatch(){},
    clearMap(){uiCalls.push('clearMap');},renderRunList(){uiCalls.push('renderRunList');},updateOperationMetrics(){},ensureDateVehicles(){},
    resetDriverMaster(){},refreshDriverMaster:async()=>{},loadOperationStatus:async()=>{},syncDateHeading(){},renderPeriodStoreList(){},setPeriodViewState(){},hasDatedDriverFilter:()=>false,
    selectedVehicles:()=>context.state.selectedVehicles,setSelectedVehicles:value=>{context.state.selectedVehicles=Array.from(value);},primarySelectedVehicle:()=>context.state.selectedVehicles.length===1?context.state.selectedVehicles[0]:'',
    filteredPeriodStores:()=>context.allStores,renderStops:rows=>{context.state.currentRows=rows;renders.push(codes(rows));},
    isSilentRequestError:error=>{errors.push(error);return error?.name==='AbortError';},
    fetchJson:options.fetchJson||(()=>{throw Error('Unexpected network request');}),
  };
  vm.createContext(context);
  vm.runInContext(functions.map(extractFunction).join('\n')+'\nthis.bridge={'+navigationSource+'};',context,{filename:'map-phase2b-runtime-functions.js'});
  return {context,nodes,events,reads,renders,uiCalls,adapter,errors};
}

test('switching to daily mode immediately excludes still-resident general-map rows',()=>{
  const f=fixture(),c=f.context;
  c.switchMode('DATE_ROUTE');
  assert.equal(c.dateReady,false);assert.equal(c.datedSourceDate,'');
  assert.deepEqual(codes(c.state.currentRows),[]);
  assert.deepEqual(codes(c.filteredDateStores(c.allStores)),[]);
  assert.deepEqual(codes(c.bridge.navigationStores()),[]);
  assert.deepEqual(codes(c.allStores),['S_GENERAL'],'resident storage is not mistaken for ready daily data');
});

test('an exact explicitly marked review day loads only that day without promoting range completeness',async()=>{
  const status=deferred(),f=fixture({status:()=>status.promise,readDate:date=>Promise.resolve(response(date,[record('S_REVIEW',date)],{reviewOnly:true,coverageComplete:false,businessCoverageVerified:false}))}),c=f.context;
  const pending=c.selectLatestRoute();
  assert.equal(c.dateReady,false);assert.deepEqual(codes(c.bridge.navigationStores()),[]);
  status.resolve({ready:false,completionVerified:false,reviewOnly:true,availableReviewDate:DAY});await pending;
  assert.deepEqual(f.reads,[DAY]);assert.equal(c.state.selectedDate,DAY);assert.equal(c.isDailyDataReady(),true,f.errors.map(e=>e.stack).join('\n'));
  assert.deepEqual(codes(c.allStores),['S_REVIEW']);assert.deepEqual(codes(c.state.currentRows),['S_REVIEW']);
  assert.equal(c.dailyMeta.reviewOnly,true);assert.equal(c.dailyMeta.coverageComplete,false);assert.equal(c.dailyMeta.businessCoverageVerified,false);
});

test('unready status cannot use an implicit, mismatched or unmarked review day',async()=>{
  for(const status of [{ready:false,availableReviewDate:DAY},{ready:false,reviewOnly:false,availableReviewDate:DAY},{ready:false,reviewOnly:true,availableReviewDate:NEW_DAY},{ready:false,reviewOnly:true}]){
    const f=fixture({status:()=>Promise.resolve(status)});await f.context.selectLatestRoute();
    assert.deepEqual(f.reads,[]);assert.equal(f.context.dateReady,false);assert.deepEqual(codes(f.context.bridge.navigationStores()),[]);
    assert.match(f.nodes.get('#freshnessState').textContent,/불러오지 못했습니다/);
  }
});

test('a ready published status chooses its completed-through day',async()=>{
  const f=fixture({status:()=>Promise.resolve({ready:true,completedThrough:NEW_DAY})});
  await f.context.selectLatestRoute();
  assert.deepEqual(f.reads,[NEW_DAY]);assert.equal(f.context.datedSourceDate,NEW_DAY);
});

test('invalid calendar days, malformed inputs and future dates never issue a read',async()=>{
  const f=fixture();
  for(const date of ['2026-02-30','2026-00-10','2026-13-01','2026-10-29','2026-1-01','','2026-10-23T00:00:00Z'])await f.context.changeSelectedDate(date);
  assert.deepEqual(f.reads,[]);assert.equal(f.context.state.mode,'BASE_60D');assert.deepEqual(codes(f.context.allStores),['S_GENERAL']);
});

test('a response for another date or an incomplete response cannot make daily data ready',async()=>{
  for(const result of [response(NEW_DAY),response(DAY,[record('S1')],{complete:false})]){
    const f=fixture({readDate:()=>Promise.resolve(result)});await f.context.changeSelectedDate(DAY);
    assert.equal(f.context.isDailyDataReady(),false);assert.equal(f.context.datedSourceDate,'');
    assert.deepEqual(codes(f.context.state.currentRows),[]);assert.deepEqual(codes(f.context.bridge.navigationStores()),[]);
  }
});

test('a failed refresh clears previously successful daily availability',async()=>{
  let fail=false;const f=fixture({readDate:date=>fail?Promise.reject(Error('source failed')):Promise.resolve(response(date))});
  await f.context.changeSelectedDate(DAY);assert.equal(f.context.isDailyDataReady(),true);
  fail=true;await f.context.changeSelectedDate(DAY);
  assert.equal(f.context.dateReady,false);assert.equal(f.context.datedSourceDate,'');
  assert.deepEqual(codes(f.context.state.currentRows),[]);assert.deepEqual(codes(f.context.bridge.navigationStores()),[]);
});

test('an older date response cannot overwrite a newer completed selection',async()=>{
  const a=deferred(),b=deferred(),f=fixture({readDate:date=>date===DAY?a.promise:b.promise}),c=f.context;
  const first=c.changeSelectedDate(DAY);await nextTurn();
  const second=c.changeSelectedDate(NEW_DAY);await nextTurn();
  b.resolve(response(NEW_DAY,[record('S_NEW',NEW_DAY)]));await second;
  a.resolve(response(DAY,[record('S_OLD',DAY)]));await first;
  assert.equal(c.state.selectedDate,NEW_DAY);assert.equal(c.datedSourceDate,NEW_DAY);
  assert.deepEqual(codes(c.allStores),['S_NEW']);assert.deepEqual(codes(c.bridge.navigationStores()),['S_NEW']);
});

test('an older request failure cannot clear a newer ready date',async()=>{
  const a=deferred(),f=fixture({readDate:date=>date===DAY?a.promise:Promise.resolve(response(date,[record('S_NEW',date)]))}),c=f.context;
  const first=c.changeSelectedDate(DAY);await nextTurn();
  await c.changeSelectedDate(NEW_DAY);a.reject(Error('old source failed'));await first;
  assert.equal(c.isDailyDataReady(),true);assert.deepEqual(codes(c.state.currentRows),['S_NEW']);
});

test('an older latest-date lookup cannot replace a user-selected date',async()=>{
  const status=deferred(),f=fixture({status:()=>status.promise}),c=f.context;
  const latest=c.selectLatestRoute();await nextTurn();
  await c.changeSelectedDate(NEW_DAY);
  status.resolve({ready:false,reviewOnly:true,availableReviewDate:DAY});await latest;
  assert.deepEqual(f.reads,[NEW_DAY]);assert.equal(c.state.selectedDate,NEW_DAY);assert.equal(c.isDailyDataReady(),true);
});

test('navigation may choose another vehicle on the same ready day while map filters remain scoped',async()=>{
  const f=fixture({readDate:date=>Promise.resolve(response(date,[record('S101',date,'101'),record('S102',date,'102')]))}),c=f.context;
  await c.changeSelectedDate(DAY,{vehicles:['101'],centerFilter:'',scope:'selected'});
  assert.deepEqual(codes(c.filteredDateStores(c.allStores)),['S101']);
  assert.deepEqual(codes(c.state.currentRows),['S101']);
  assert.deepEqual(codes(c.bridge.navigationStores()),['S101','S102']);
  c.dateReady=false;assert.deepEqual(codes(c.bridge.navigationStores()),[]);
});

test('daily readiness requires ready flag, daily mode and exact nonempty date ownership',()=>{
  const c=fixture().context;c.state.mode='DATE_ROUTE';c.state.selectedDate=DAY;c.datedSourceDate=DAY;c.dateReady=true;
  assert.equal(c.isDailyDataReady(),true);
  for(const patch of [{dateReady:false},{datedSourceDate:''},{datedSourceDate:NEW_DAY}]){
    const previous={dateReady:c.dateReady,datedSourceDate:c.datedSourceDate};Object.assign(c,patch);assert.equal(Boolean(c.isDailyDataReady()),false);Object.assign(c,previous);
  }
  c.state.mode='BASE_60D';assert.equal(c.isDailyDataReady(),false);
});

test('daily replacement does not merge unmatched general snapshot customers into the day',async()=>{
  const f=fixture({readDate:date=>Promise.resolve(response(date,[record('S_ONLY_DAY',date)]))});
  f.context.latestSnapshotRows.push(record('S_GENERAL_2','2026-10-01'));
  await f.context.changeSelectedDate(DAY);
  assert.deepEqual(codes(f.context.allStores),['S_ONLY_DAY']);assert.deepEqual(codes(f.context.state.currentRows),['S_ONLY_DAY']);
});

test('rows explicitly stamped for another date are not accepted under a matching response envelope',async()=>{
  const f=fixture({readDate:()=>Promise.resolve(response(DAY,[record('S_WRONG_DAY',NEW_DAY)]))});
  await f.context.changeSelectedDate(DAY);
  assert.equal(f.context.isDailyDataReady(),false,'matching envelope must not relabel a contradictory source day');
  assert.deepEqual(codes(f.context.bridge.navigationStores()),[]);
});
