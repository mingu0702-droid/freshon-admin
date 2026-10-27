import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../public/map-phase2b-runtime.js',import.meta.url),'utf8');
const start=source.indexOf("  let driverMasterDate=''");
const end=source.indexOf("  window.addEventListener('pagehide'",start);
assert.ok(start>=0&&end>start,'Shipped driver-assignment controller found');
const DAY='2026-10-23',OTHER_DAY='2026-10-24',TODAY='2026-10-28';
const verified=(extra={})=>({customerCode:'S1001',baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleStale:false,...extra});
const master=(names={101:'현재 담당기사'})=>({vehicles:Object.entries(names).map(([vehicle,driverName])=>({vehicle,driverName,effectiveDate:'2026-10-01'}))});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture({read,mode='BASE_60D',row=verified()}={}){
  const nodes=new Map(),reads=[],aborts=[];
  for(const selector of ['#vehicle','#mobileVehicle','#operationVehicle'])nodes.set(selector,{options:[{value:'',textContent:'전체 호차'},{value:'101',textContent:'101호'},{value:'102',textContent:'102호'}]});
  for(const selector of ['#detailDriverLabel','#detailDriver'])nodes.set(selector,{textContent:'',title:'',dataset:{}});
  const context={state:{mode,selectedDate:DAY,selected:row},driverByVehicle:new Map(),
    requestControllers:new Map([['driver-master',{controller:{abort:reason=>aborts.push(reason)}}]]),
    localDate:()=>TODAY,normalizeVehicle:value=>String(value||'').trim().replace(/호(?:차)?$/,''),vehicleLabel:value=>`${value}호`,
    $:selector=>nodes.get(selector),fetchJson:(url,options)=>{reads.push({url,options});return read?read(url,reads.length):Promise.resolve(master());}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context,{filename:'shipped-driver-master.js'});
  return {context,nodes,reads,aborts,text:()=>nodes.get('#detailDriver').textContent};
}

test('general-map assignment uses the verified base vehicle and today, never the historical delivery driver',async()=>{
  const f=fixture({row:verified({vehicle:'102',driverName:'과거 배송기사',lastDeliveryDate:DAY}),read:()=>Promise.resolve(master({101:'기준호차 담당기사',102:'다른 호차 기사'}))});
  await f.context.refreshDriverMaster();
  assert.equal(new URL(f.reads[0].url,'http://local').searchParams.get('date'),TODAY);
  assert.equal(f.nodes.get('#detailDriverLabel').textContent,'담당 기사');
  assert.match(f.text(),/기준호차 담당기사/);assert.match(f.text(),/2026-10-28 기준/);assert.doesNotMatch(f.text(),/과거 배송|다른 호차/);
  assert.match(f.nodes.get('#detailDriver').title,/2026-10-01 적용/);
  f.context.state.selected.baseVehicle='102';await f.context.refreshDriverMaster();
  assert.match(f.text(),/다른 호차 기사/);assert.equal(f.reads.length,1,'same master read is reused after a base-vehicle update');
});

test('unverified, missing, conflicted or unassigned base vehicles cannot borrow a historical or other-vehicle driver',async()=>{
  const f=fixture();await f.context.refreshDriverMaster();
  for(const patch of [{baseVehicleState:'UNKNOWN'},{baseVehicleState:'UNASSIGNED'},{baseVehicleState:'CONFLICT'},{baseVehicle:''},{baseVehicleVersion:''},{baseVehicleSource:'PUBLISHED_ONLY'}]){
    const detail=f.context.storeDriverDetail(verified({vehicle:'101',driverName:'과거 기사',...patch}));
    assert.match(detail.text,/담당 기사 정보 없음/);assert.doesNotMatch(detail.text,/현재 담당|과거 기사/);assert.equal(detail.source,'');
  }
});

test('a stale verified base vehicle is explicitly marked as a previous assignment',async()=>{
  const f=fixture({row:verified({baseVehicleStale:true})});await f.context.refreshDriverMaster();
  assert.match(f.text(),/현재 담당기사/);assert.match(f.text(),/이전 기준호차/);
});

test('daily mode requests the selected date and prioritizes its assignment record over the contact master',async()=>{
  const f=fixture({mode:'DATE_ROUTE',row:{customerCode:'S1001',vehicle:'101',driverName:'당일 배차기사'}});
  await f.context.refreshDriverMaster();
  assert.equal(new URL(f.reads[0].url,'http://local').searchParams.get('date'),DAY);
  assert.equal(f.text(),'당일 배차기사');assert.equal(f.nodes.get('#detailDriver').dataset.source,'ASSIGNMENT');
  f.context.state.selected.driverName='';await f.context.refreshDriverMaster();
  assert.match(f.text(),/현재 담당기사 · 2026-10-23 기준/);assert.equal(f.reads.length,1);
});

test('loading, a successful missing entry and request failure remain distinct without an invented driver',async()=>{
  const pending=deferred(),f=fixture({read:()=>pending.promise});
  const loading=f.context.refreshDriverMaster();assert.equal(f.text(),'담당 기사 불러오는 중…');
  pending.resolve({vehicles:[]});await loading;assert.equal(f.text(),'담당 기사 정보 없음');
  const failed=fixture({read:()=>Promise.reject(Error('upstream unavailable'))});await failed.context.refreshDriverMaster();
  assert.equal(failed.text(),'담당 기사 조회 실패');assert.equal(failed.context.driverByVehicle.size,0);
  await failed.context.refreshDriverMaster();assert.equal(failed.reads.length,1,'a failed read is not repeatedly requested on every map render');
});

test('A-to-B-to-A date changes reject the first A response and preserve the new pending request',async()=>{
  const queue=[deferred(),deferred(),deferred()],f=fixture({mode:'DATE_ROUTE',row:{vehicle:'101'},read:(_,number)=>queue[number-1].promise}),c=f.context;
  const first=c.refreshDriverMaster();c.state.selectedDate=OTHER_DAY;const second=c.refreshDriverMaster();c.state.selectedDate=DAY;const third=c.refreshDriverMaster();
  queue[0].resolve(master({101:'오래된 A'}));await first;await c.refreshDriverMaster();
  assert.equal(f.reads.length,3,'an old finally block must not clear the newer pending request');assert.doesNotMatch(f.text(),/오래된 A/);
  queue[2].resolve(master({101:'최신 A'}));await third;
  queue[1].resolve(master({101:'늦은 B'}));await second;
  assert.match(f.text(),/최신 A/);assert.doesNotMatch(f.text(),/늦은 B|오래된 A/);
});

test('a mode change invalidates an older failure and refreshes the general map at the current reference date',async()=>{
  const old=deferred(),current=deferred(),f=fixture({mode:'DATE_ROUTE',row:{vehicle:'101'},read:(_,number)=>number===1?old.promise:current.promise}),c=f.context;
  const first=c.refreshDriverMaster();c.resetDriverMaster();c.state.mode='BASE_60D';c.state.selected=verified();const second=c.refreshDriverMaster();
  old.reject(Error('old selected-day request failed'));await first;await c.refreshDriverMaster();
  assert.equal(f.reads.length,2);assert.equal(f.text(),'담당 기사 불러오는 중…');assert.equal(f.aborts.length,1);
  current.resolve(master({101:'현재 기준 기사'}));await second;
  assert.match(f.text(),/현재 기준 기사 · 2026-10-28 기준/);assert.doesNotMatch(f.text(),/조회 실패/);
});

test('logout invalidation prevents an in-flight read from repopulating staff names',async()=>{
  const pending=deferred(),f=fixture({read:()=>pending.promise}),c=f.context;
  const loading=c.refreshDriverMaster();c.resetDriverMaster();c.state.selected=null;
  pending.resolve(master({101:'늦게 도착한 기사'}));await loading;
  assert.equal(c.driverByVehicle.size,0);assert.doesNotMatch(f.text(),/늦게 도착한 기사/);
});

test('future-effective contact rows are not assigned before their effective date',async()=>{
  const f=fixture({mode:'DATE_ROUTE',row:{vehicle:'101'},read:()=>Promise.resolve({vehicles:[{vehicle:'101',driverName:'미래 기사',effectiveDate:'2026-10-24'}]})});
  await f.context.refreshDriverMaster();assert.equal(f.text(),'담당 기사 정보 없음');assert.equal(f.context.driverByVehicle.size,0);
});

test('a pending response updates only the store currently selected in the detail card',async()=>{
  const pending=deferred(),f=fixture({read:()=>pending.promise}),c=f.context;
  const loading=c.refreshDriverMaster();c.state.selected=verified({customerCode:'S1002',baseVehicle:'102'});
  pending.resolve(master({101:'이전 선택 기사',102:'현재 선택 기사'}));await loading;
  assert.match(f.text(),/현재 선택 기사/);assert.doesNotMatch(f.text(),/이전 선택 기사/);
});
