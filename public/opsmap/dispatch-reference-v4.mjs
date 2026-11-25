import {money} from './dispatch-reference.mjs?v=20261126-v4';

const digest = /^[a-f0-9]{64}$/;
const customerCode = /^[A-Z]\d{1,20}$/;
const collator = new Intl.Collator('ko-KR', {numeric:true});
const format = new Intl.NumberFormat('ko-KR');
const clock = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', dateStyle:'short', timeStyle:'short'});
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const validCount = value => Number.isSafeInteger(value)&&value>=0;
const count = (value,suffix) => validCount(value)?format.format(value)+suffix:'미확인';
const label = vehicle => /^(?:용|척)?\d+$/.test(vehicle)?vehicle+'호':vehicle;
const vehicleKey = value => typeof value==='string' && value.trim()===value && Boolean(value) && value.length<=24 && value!=='미배정';
const normalize = value => String(value??'').normalize('NFKC').toLowerCase();
const overlapVehicleKey = vehicle => vehicle.replace(/^(용|척)\s+(?=\d+$)/,'$1');

export function dispatchOverlapVehicles(model) {
  const routes=new Map();
  for(const route of model?.vehicles.values()??[]) {
    if(!route.wmsConfirmed)continue;
    const key=overlapVehicleKey(route.vehicle);
    routes.set(key,routes.has(key)?null:route);
  }
  return routes;
}

function candidateSummary(value) {
  if (!/^\d{5}$/.test(value?.postalCode??'')||typeof value.postalCode!=='string'||
      !Array.isArray(value.routes)||value.routes.length<2||value.routes.length!==value.routeCount||
      !validCount(value.storeCount)) return null;
  const seen=new Set();
  for (const route of value.routes) {
    if(!vehicleKey(route?.vehicle)||seen.has(route.vehicle)||!validCount(route.storeCount)||!route.storeCount) return null;
    seen.add(route.vehicle);
  }
  if(value.routes.reduce((sum,route)=>sum+route.storeCount,0)!==value.storeCount) return null;
  return {postalCode:value.postalCode,routeCount:value.routeCount,storeCount:value.storeCount,routes:value.routes};
}

function validEnvelope(value) {
  return value?.contract==='opsmap-dispatch-overlaps-v1'&&value.state==='VERIFIED'&&value.center==='osan'&&
    [value.version,value.registryVersion,value.fixedVersion].every(version=>typeof version==='string'&&digest.test(version));
}

export function dispatchOverlapOverview(value) {
  if(!validEnvelope(value)||!Array.isArray(value.candidates)) throw Error('DISPATCH_OVERLAPS_UNVERIFIED');
  const candidates=value.candidates.map(candidateSummary);
  if(candidates.some(candidate=>!candidate)||new Set(candidates.map(candidate=>candidate.postalCode)).size!==candidates.length) {
    throw Error('DISPATCH_OVERLAPS_UNVERIFIED');
  }
  candidates.sort((a,b)=>b.routeCount-a.routeCount||b.storeCount-a.storeCount||a.postalCode.localeCompare(b.postalCode));
  return {version:value.version,registryVersion:value.registryVersion,fixedVersion:value.fixedVersion,candidates};
}

export function dispatchOverlapDetail(value,overview,expected) {
  if(!validEnvelope(value)||['version','registryVersion','fixedVersion'].some(key=>value[key]!==overview[key])) {
    throw Error('DISPATCH_OVERLAPS_UNVERIFIED');
  }
  const candidate=candidateSummary(value.candidate);
  const expectedCounts=new Map(expected.routes.map(route=>[route.vehicle,route.storeCount]));
  if(!candidate||candidate.postalCode!==expected.postalCode||candidate.storeCount!==expected.storeCount||
      candidate.routeCount!==expected.routeCount||
      candidate.routes.some(route=>expectedCounts.get(route.vehicle)!==route.storeCount)||
      !Array.isArray(value.candidate.stores)||value.candidate.stores.length!==candidate.storeCount) {
    throw Error('DISPATCH_OVERLAPS_UNVERIFIED');
  }
  const seen=new Set(),counts=new Map();
  const stores=value.candidate.stores.map(row=>{
    if(typeof row?.customerCode!=='string'||!customerCode.test(row.customerCode)||seen.has(row.customerCode)||
        !expectedCounts.has(row.vehicle)) throw Error('DISPATCH_OVERLAPS_UNVERIFIED');
    seen.add(row.customerCode);
    counts.set(row.vehicle,(counts.get(row.vehicle)||0)+1);
    const point=row.coordinateVerified===true&&Number.isFinite(row.lat)&&row.lat>=33&&row.lat<=39.5&&
      Number.isFinite(row.lng)&&row.lng>=124&&row.lng<=132?{lat:row.lat,lng:row.lng}:null;
    return {customerCode:row.customerCode,name:typeof row.customerName==='string'&&row.customerName||row.customerCode,
      vehicle:row.vehicle,point};
  });
  if(candidate.routes.some(route=>counts.get(route.vehicle)!==route.storeCount)) throw Error('DISPATCH_OVERLAPS_UNVERIFIED');
  return {...candidate,stores};
}

export function dispatchDailyRoster(model) {
  const result=[];
  for (const route of model?.vehicles.values()??[]) {
    if(!route.wmsConfirmed||route.vehicle==='미배정')continue;
    const areas=new Map();
    for(const {deliveryArea} of route.stops) if(deliveryArea) areas.set(deliveryArea,(areas.get(deliveryArea)||0)+1);
    const area=[...areas].sort((a,b)=>b[1]-a[1]||collator.compare(a[0],b[0]))[0]?.[0]??null;
    result.push({...route,area});
  }
  return result;
}

export function mountDispatchV4({left,right,readOverlaps,selectRoute,selectCandidate}) {
  const roster=document.createElement('section');
  roster.className='dispatch-v4-roster';
  roster.hidden=true;
  roster.innerHTML='<label>호차 검색<input type="search" autocomplete="off" placeholder="호차 번호 또는 배송지역"></label>'+
    '<p class="dispatch-v4-source" role="status"></p>'+
    '<div class="dispatch-v4-table-head" aria-label="호차 정렬"><button type="button" data-sort="vehicle">호차</button>'+
    '<button type="button" data-sort="area" title="확인된 배송 매장에서 가장 많이 나타난 지역">주 배송지역</button>'+
    '<button type="button" data-sort="waypointCount">착수</button><button type="button" data-sort="amount">매출</button></div>'+
    '<div class="dispatch-v4-table" aria-label="오산 WMS 전체 확정 호차"></div><p class="dispatch-v4-unassigned"></p>';
  left.prepend(roster);
  const panel=document.createElement('section');
  panel.className='dispatch-v4-overlaps';
  panel.hidden=true;
  panel.innerHTML='<h2>우편번호 겹침 · 조정 후보</h2><p class="dispatch-v4-overlap-status" role="status"></p>'+
    '<div class="dispatch-v4-candidates" aria-label="우편번호 후보"></div>';
  right.before(panel);
  const search=roster.querySelector('input'), source=roster.querySelector('.dispatch-v4-source');
  const table=roster.querySelector('.dispatch-v4-table'), unassigned=roster.querySelector('.dispatch-v4-unassigned');
  const candidates=panel.querySelector('.dispatch-v4-candidates'), summary=panel.querySelector('.dispatch-v4-overlap-status');
  let active=false, model=null, rosterRows=[], overview=null, current=null;
  let sort='vehicle',descending=false, selectedVehicle='', summaryRequest=null, detailRequest=null, overviewState='loading';

  function renderRoster() {
    const keywords=normalize(search.value).trim().split(/\s+/).filter(Boolean);
    const dispatchRoutes=dispatchOverlapVehicles(model);
    const selectedRoutes=new Set((current?.state==='error'?[]:current?.candidate.routes||[])
      .map(route=>dispatchRoutes.get(route.vehicle)?.vehicle));
    const rows=rosterRows.filter(row=>keywords.every(term=>normalize(label(row.vehicle)+' '+(row.area||'')).includes(term)));
    rows.sort((a,b)=>{
      const x=a[sort],y=b[sort];
      if(x===null||y===null) return Number(x===null)-Number(y===null)||collator.compare(a.vehicle,b.vehicle);
      return (typeof x==='number'?x-y:collator.compare(x,y))*(descending?-1:1)||collator.compare(a.vehicle,b.vehicle);
    });
    const focus=table.contains(document.activeElement)?document.activeElement.dataset.dispatchV4Route:null;
    table.innerHTML=rows.length?rows.map(row=>'<button type="button" class="dispatch-v4-route" data-dispatch-v4-route="'+
      escape(row.vehicle)+'" aria-pressed="'+String(selectedVehicle===row.vehicle||selectedRoutes.has(row.vehicle))+'">'+
      '<strong>'+escape(label(row.vehicle))+'</strong><span title="'+escape(row.area??'미확인')+'">'+escape(row.area??'미확인')+
      '</span><span>'+count(row.waypointCount,'착')+'</span><b>'+money(row.amount)+'</b></button>').join(''):
      '<p class="dispatch-empty">'+(rosterRows.length?'검색 결과가 없습니다.':model?.amountsVerified?'확정 호차가 없습니다.':'WMS 호차 미확인')+'</p>';
    if(focus) [...table.querySelectorAll('button')].find(item=>item.dataset.dispatchV4Route===focus)?.focus({preventScroll:true});
    const checked=model?.amountObservedAt;
    source.textContent=model?.date?(model.date+' 배송 · WMS '+(Number.isFinite(Date.parse(checked))?clock.format(new Date(checked))+' KST':'확인 시각 미확인')):'';
    const pending=model?.vehicles.get('미배정');
    unassigned.textContent=pending?'미배정 · 배송 '+count(pending.deliveryCount,'건')+' · '+money(pending.amount):
      validCount(model?.unassigned)&&model.unassigned>0?'미배정 · 배송 '+count(model.unassigned,'건'):'';
    for(const button of roster.querySelectorAll('[data-sort]')){
      const selected=button.dataset.sort===sort;
      button.setAttribute('aria-pressed',String(selected));
      button.dataset.direction=selected?(descending?'desc':'asc'):'';
    }
  }

  function details(candidate) {
    if(current.state==='loading')return '<p class="dispatch-empty">선택 권역의 매장을 확인하고 있습니다.</p>';
    if(current.state==='error')return '<p class="dispatch-empty">권역 상세 미확인</p><button type="button" data-overlap-retry>후보 다시 조회</button>';
    const completeWms=Boolean(model?.amountsVerified&&model.sameWmsExport&&model.sourceTotals);
    const dispatchRoutes=dispatchOverlapVehicles(model);
    return '<ul class="dispatch-v4-overlap-routes">'+candidate.routes.map(({vehicle,storeCount})=>{
      const route=dispatchRoutes.get(vehicle);
      const dispatch=route?'착수 '+count(route.waypointCount,'착')+' · '+money(route.amount):
        completeWms&&!dispatchRoutes.has(vehicle)?'미출차':'WMS 미확인';
      return '<li><strong>'+escape(label(vehicle))+'</strong><span>등록 '+count(storeCount,'곳')+
        '</span><small>'+escape(dispatch)+'</small></li>';
    }).join('')+'</ul>';
  }

  function renderCandidates(focusCode) {
    summary.textContent=overviewState==='loading'?'등록 권역 조회 중':overviewState==='error'?'등록 권역 자료 미확인':
      overview?.candidates.length?count(overview.candidates.length,'건'):'확인된 우편번호 겹침이 없습니다.';
    if(overviewState==='error') {
      candidates.innerHTML='<button type="button" data-overlap-retry>후보 다시 조회</button>';
      return;
    }
    candidates.innerHTML=(overview?.candidates??[]).map(candidate=>{
      const code=candidate.postalCode, pressed=current?.candidate.postalCode===code;
      return '<div class="dispatch-v4-overlap-row"><button type="button" data-dispatch-v4-postal="'+code+'" aria-expanded="'+
        String(pressed)+'"><strong>'+code+'</strong><span>호차 '+count(candidate.routeCount,'대')+' · 등록 '+
        count(candidate.storeCount,'곳')+'</span></button>'+(pressed?details(candidate):'')+'</div>';
    }).join('');
    if(focusCode) candidates.querySelector('[data-dispatch-v4-postal="'+focusCode+'"]')?.focus({preventScroll:true});
  }

  function clearCandidate(notify=false) {
    const code=current?.candidate.postalCode;
    detailRequest?.abort(); detailRequest=null; current=null;
    if(!code)return;
    renderCandidates(notify?code:undefined);
    renderRoster();
    if(notify)selectCandidate(null);
  }

  async function loadOverview() {
    summaryRequest?.abort(); overview=null; overviewState='loading'; renderCandidates();
    const controller=summaryRequest=new AbortController();
    try {
      const value=await readOverlaps({signal:controller.signal});
      if(!active||controller.signal.aborted)return;
      overview=dispatchOverlapOverview(value); overviewState='ready';
    } catch {
      if(!active||controller.signal.aborted)return;
      overviewState='error';
    }
    renderCandidates();
  }

  async function chooseCandidate(code) {
    if(current?.candidate.postalCode===code) {clearCandidate(true);return;}
    const candidate=overview?.candidates.find(item=>item.postalCode===code);
    if(!candidate)return;
    if(current)clearCandidate(true);
    selectedVehicle='';
    current={candidate,state:'loading'};
    renderCandidates(code);renderRoster();
    const controller=detailRequest=new AbortController();
    try {
      const stable=overview;
      const value=await readOverlaps({postalCode:code,version:stable.version,signal:controller.signal});
      if(!active||controller.signal.aborted||stable!==overview)return;
      const detail=dispatchOverlapDetail(value,stable,candidate);
      current={candidate,detail,state:'ready'};
      selectCandidate(detail);
    } catch {
      if(!active||controller.signal.aborted)return;
      current={candidate,state:'error'};
      renderRoster();
    }
    renderCandidates(code);
  }

  search.oninput=renderRoster;
  roster.addEventListener('click',event=>{
    const header=event.target.closest('[data-sort]');
    if(header) {
      const key=header.dataset.sort;
      descending=sort===key?!descending:key==='amount'||key==='waypointCount';
      sort=key;
      renderRoster();
    }
    const row=event.target.closest('[data-dispatch-v4-route]');
    if(!row)return;
    clearCandidate();
    selectRoute(row.dataset.dispatchV4Route);
  });
  candidates.addEventListener('click',event=>{
    if(event.target.closest('[data-overlap-retry]')) {
      clearCandidate(true); void loadOverview();return;
    }
    const code=event.target.closest('[data-dispatch-v4-postal]')?.dataset.dispatchV4Postal;
    if(code)void chooseCandidate(code);
  });
  return {
    open(){
      if(active)return;
      active=true;roster.hidden=panel.hidden=false;renderRoster();void loadOverview();
    },
    close(){
      active=false;roster.hidden=panel.hidden=true;summaryRequest?.abort();summaryRequest=null;
      clearCandidate();overview=null;model=null;rosterRows=[];
      search.value='';selectedVehicle='';sort='vehicle';descending=false;
      table.replaceChildren();candidates.replaceChildren();source.textContent=summary.textContent=unassigned.textContent='';
    },
    setDay(next){
      if(!next){clearCandidate();selectedVehicle='';search.value='';}
      model=next;rosterRows=dispatchDailyRoster(model);
      if(active){renderRoster();renderCandidates();}
    },
    currentCandidate:()=>current?.detail??null,
    clearCandidate,
    setVehicle(vehicle){selectedVehicle=vehicle;if(active)renderRoster();},
  };
}
