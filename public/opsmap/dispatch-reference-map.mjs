import {compareDispatchRoutes,createDispatchReference,detailText,discoverDispatchRoutes,distance,money,simulateDispatchTransfer} from './dispatch-reference.mjs?v=20261126-wms-official-round';
import {summarizeDispatchPeriod} from './dispatch-reference-period.mjs?v=20261124-period-proof';
import {dispatchOverlapVehicles,dispatchVehicleColor,mountDispatchV4} from './dispatch-reference-v4.mjs?v=20261127-postal-focus';

const meters = km => Number.isFinite(km) ? new Intl.NumberFormat('ko-KR').format(Math.round(km*1000))+'m' : '미확인';
const sourceClock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const sourceTime=value=>Number.isFinite(Date.parse(value))?sourceClock.format(new Date(value))+' KST':'미확인';

export function nearestDispatchStop(stop, target) {
  if (!stop?.point || !target) return null;
  let nearest = null;
  for (const other of target.stops) {
    if (!other.point || stop.customerCode===other.customerCode) continue;
    const km=distance(stop.point,other.point);
    if (!nearest || km<nearest.km) nearest={stop:other,km};
  }
  return nearest;
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const color = {primary:'#1767d4', secondary:'#dc6714', overlap:'#008f85', overview:'#1767d4'};

export function mountDispatchReference({workspace, sidebar, bridge, readDay, readPeriod, readOutline, readOverlaps, screenReview}) {
  const controls = document.createElement('details');
  controls.className='dispatch-controls';
  controls.id='dispatchReference';
  controls.hidden=true;
  controls.setAttribute('aria-label','오산 배차 참고 조건');
  controls.innerHTML=`<summary>오산 배차 조건</summary>
    <form class="dispatch-date">
      <label class="dispatch-mode">조회 방식<select name="mode"><option value="day">날짜별 배차</option><option value="period">기간별 분석</option></select></label>
      <label><span data-date-label>배송일</span><input name="date" type="date" required></label><button type="submit">조회</button>
      <label class="dispatch-period-field" hidden>분석기간<select name="days"><option value="7">7일</option><option value="30">30일</option><option value="60">60일</option><option value="90">90일</option></select></label>
      <label class="dispatch-period-basis" hidden>지역 집계 기준<select name="periodBasis"><option value="dispatch">확정 배차</option><option value="completed">배송완료 확인</option></select></label>
    </form>
    <p class="dispatch-status" role="status"></p>
    <div class="dispatch-choices" hidden>
      <label>오산 호차 검색<input name="vehicleSearch" type="search" autocomplete="off" placeholder="호차 번호"></label>
      <label class="dispatch-primary">첫 번째 호차<select name="primary"></select></label>
      <label class="dispatch-secondary">두 번째 호차<select name="secondary"></select></label>
      <label class="dispatch-period-vehicles" hidden>분석 호차<select name="vehicles" multiple size="5" aria-describedby="dispatchSelectedVehicles"></select>
        <small id="dispatchSelectedVehicles"></small></label>
      <details class="dispatch-fleet">
        <summary>다른 호차 탐색</summary>
        <label>탐색 기준<select name="fleetScope"><option value="related">공통 또는 인접</option><option value="postal">공통 우편번호</option>
          <option value="nearby">직선거리 500m 이내</option><option value="all">전체 호차</option></select></label>
        <p class="dispatch-fleet-summary"></p>
        <div class="dispatch-fleet-list"></div>
      </details>
      <label>우편번호 검색<input name="postcodeSearch" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="우편번호 숫자"></label>
      <label>우편번호·중첩 지역<select name="postcode"></select></label>
      <p class="dispatch-coverage"></p>
      <div class="dispatch-legend"><span><i></i> 500m 이내 이관 검토</span><span><i></i> 공통 우편번호 경계</span></div>
      <div class="dispatch-stores"></div>
    </div>`;
  sidebar.append(controls);

  const details = document.createElement('details');
  details.className='dispatch-details';
  details.hidden=true;
  details.innerHTML='<summary>매장 및 금액 비교</summary><section class="dispatch-detail-body" aria-label="매장 및 WMS 금액 비교"></section>';
  workspace.append(details);
  const $ = selector => controls.querySelector(selector);
  const form=$('form'), {date,mode,days,periodBasis}=form.elements, vehicles=$('[name=vehicles]'), postcodeSearch=$('[name=postcodeSearch]'),
    primary=$('[name=primary]'), secondary=$('[name=secondary]'),
    postcode=$('[name=postcode]'), choices=$('.dispatch-choices'), status=$('.dispatch-status'), coverage=$('.dispatch-coverage'),
    stores=$('.dispatch-stores'), detail=details.querySelector('section');
  const vehicleSearch=$('[name=vehicleSearch]'), fleet=$('.dispatch-fleet'), fleetScope=$('[name=fleetScope]'),
    fleetSummary=$('.dispatch-fleet-summary'), fleetList=$('.dispatch-fleet-list');
  const mapNode=workspace.querySelector('#map');
  const mapReset=workspace.querySelector('#mapReset');
  const board=readOverlaps&&mountDispatchV4({left:choices,right:detail,readOverlaps,selectRoute:chooseBoardRoute,selectCandidate:applyBoardOverlap});
  const mapLegend=board?document.createElement('aside'):null;
  if(mapLegend){
    mapLegend.hidden=true;
    mapLegend.className='dispatch-v4-map-legend';
    mapLegend.setAttribute('aria-label','배차 지도 범례');
    mapLegend.innerHTML='<strong></strong><span data-overlap-key="inside">해당 우편번호 배송</span>'+
      '<span data-overlap-key="outside">다른 우편번호 배송</span><span data-overlap-key="registered">기준호차 등록 위치</span>'+
      '<span data-overlap-key="unknown" hidden>우편번호 미확인 배송</span>';
    mapNode.parentElement.append(mapLegend);
  }
  const compareControl=document.createElement('label');
  compareControl.className='dispatch-v4-compare';
  compareControl.hidden=true;
  compareControl.innerHTML='가상 이관 상대 호차<select aria-label="가상 이관 상대 호차"></select>';
  const compareSelect=compareControl.querySelector('select');
  detail.before(compareControl);
  compareSelect.onchange=()=>{
    populateDayVehicles(primary.value,compareSelect.value);
    updateRoutes();
  };
  const observer=new ResizeObserver(queueMarkers);
  let active=false, model, routes, comparisons, selection, selectedPostcodes=[], markerRows=[], request, outlineRequest, frame;
  let deliveryRows=[], boardPostal=null, lastBoardFit=null;
  let period, analysis, chosenArea, choicesPostcodes=[];
  let dayVehicles=[], periodVehicles=[], focusedAnchor=null, discoveries=[];
  let repeatedCustomers=new Map();
  const additionalVehicles=new Set();
  let markerMap, markers=new Map(), polygons=[], polygonBounds=new Map();
  let transferKeys=new Set();
  let savedView=null,reviewLine=null,reviewLineKey=null;
  const isOpen=()=>active&&!controls.hidden;
  const comparisonMode=()=>Boolean(screenReview&&mode.value==='day');
  const boardMode=()=>Boolean(board&&mode.value==='day');
  const dayNow=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const tomorrow=day=>new Date(Date.parse(day)+86400_000).toISOString().slice(0,10);
  function updateDateLimit(periodMode) {
    const today=dayNow();
    date.max=periodMode?today:tomorrow(today);
    return today;
  }
  if(screenReview) {
    const anchor=primary.closest('label'), search=vehicleSearch.closest('label');
    anchor.firstChild.textContent='비교 기준 호차';
    choices.prepend(anchor,search);
    screenReview.attach({choices,detail});
  }
  const map=()=>bridge.state.map;
  const sdk=()=>window.kakao?.maps;

  function syncComparisonLayout() {
    document.body.toggleAttribute('data-dispatch-v4',isOpen()&&boardMode());
    if(isOpen()&&boardMode())board.open();else board?.close();
    if (!screenReview) return;
    const visible=active&&comparisonMode();
    if (visible===(document.body.dataset.dispatchReview==='compare')) return;
    vehicleSearch.closest('label').firstChild.textContent=visible?'배송 매장 검색':'오산 호차 검색';
    vehicleSearch.placeholder=visible?'매장명·고객코드·우편번호·호차':'호차 번호';
    if (visible) {
      document.body.dataset.dispatchReview='compare';
      screenReview.open();
    } else {
      delete document.body.dataset.dispatchReview;
      screenReview.close();
    }
  }

  function clearMarkers() {
    for (const {overlay} of markers.values()) overlay.setMap(null);
    markers.clear();
  }

  function clearOutlines() {
    outlineRequest?.abort();
    outlineRequest=null;
    for (const entry of polygons) entry.polygon.setMap(null);
    polygons=[];
    polygonBounds.clear();
  }

  function renderMarkers() {
    frame=null;
    if (!isOpen() || !map() || !sdk()) return;
    const current=map(), level=current.getLevel();
    const project=current.getProjection();
    if (!project || !mapNode) return;
    const points=window.MapViewPolicy.stableClusters(markerRows, row=>project.containerPointFromCoords(
      new (sdk().LatLng)(row.lat,row.lng)), level, '', {width:mapNode.clientWidth,height:mapNode.clientHeight},
      {mode:'DATE_ROUTE',grouping:level<=5?'locations':'territory',maxMarkers:180,
        ...(comparisonMode()?{sourceVersion:'dispatch-deliveries'}:{})});
    const next=new Map();
    for (const row of points) {
      const members=row.clusterRows||[row];
      const selected=members.some(member=>member.dispatchKey===selection?.dispatchKey);
      const key=row.clusterKey || row.dispatchKey;
      const existing=markers.get(key);
      const rendering=existing || makeMarker(row,members);
      rendering.button.classList.toggle('selected',selected);
      if (comparisonMode()) rendering.button.toggleAttribute('data-transfer-draft',
        members.some(member=>transferKeys.has(member.dispatchKey)));
      rendering.button.setAttribute('aria-pressed',String(selected));
      rendering.overlay.setZIndex?.(selected?62:50);
      if (!existing) rendering.overlay.setMap(current);
      next.set(key,rendering);
    }
    for (const [key,{overlay}] of markers) if (!next.has(key)) overlay.setMap(null);
    markers=next;
  }

  function makeMarker(row,members) {
    const isGroup=members.length>1;
    const mixed=isGroup&&!members.every(member=>member.vehicle===members[0].vehicle);
    const role=members[0].dispatchRole==='overview'?'overview':mixed?'overlap':members[0].dispatchRole;
    const groupedRoutes=boardMode()&&isGroup&&role==='overview'&&row.clusterKind!=='location'
      ?new Set(members.map(member=>member.vehicle)).size:null;
    const text=isGroup?String(groupedRoutes??members.length):row.vehicle;
    const title=isGroup?(groupedRoutes!==null?groupedRoutes+'대 호차 · 확대':members.length+(period?'개 배송 지역':'개 배송 매장')):
      (row.dispatchRole==='registered'?'기준 ':'')+row.vehicle+'호 · '+row.customerName+
      (row.customerCode?' · '+row.customerCode:'');
    const button=bridge.dispatchReferencePin(row,{color:role==='overlap'?color.overlap:members[0].routeColor||color[role],label:text,title,
      pick:()=>{
        if (!isGroup) return activateItem(row);
        if (row.clusterKind!=='location') {
          fit(members.map(member=>member.point));
          if (role!=='overview'&&map().getLevel()>5) map().setLevel(5);
        } else {
          controls.open=true;
          if(boardMode()) {
            details.open=true;
            details.toggleAttribute('data-v4-detail',true);
            detail.innerHTML='<h3>같은 위치 매장</h3>'+members.map((member,index)=>
              '<button type="button" data-v4-member="'+index+'">'+escape(member.customerName||member.name)+' · '+
              escape(member.vehicle)+'</button>').join('');
            detail.querySelectorAll('[data-v4-member]').forEach(button=>{
              button.onclick=()=>selectStop(members[Number(button.dataset.v4Member)],{focus:true});
            });
            detail.querySelector('button')?.focus({preventScroll:true});
          } else if(comparisonMode()) screenReview.showSharedLocation(members);
          else {
            renderStoreList(members);
            stores.querySelector('button')?.focus({preventScroll:true});
          }
        }
      }});
    button.dataset.dispatchRole=role;
    if(members.some(member=>member.dispatchOverlap==='inside'))button.dataset.dispatchOverlap='inside';
    else if(members.some(member=>member.dispatchOverlap==='outside'))button.dataset.dispatchOverlap='outside';
    else if(members.some(member=>member.dispatchOverlap==='registered'))button.dataset.dispatchOverlap='registered';
    else if(members.some(member=>member.dispatchOverlap==='unknown'))button.dataset.dispatchOverlap='unknown';
    if(comparisonMode())button.dataset.dispatchMembers=String(members.length);
    if (members.some(member=>member.dispatchCandidate)) button.dataset.dispatchCandidate='';
    if (!isGroup&&row.customerCode) button.dataset.dispatchCustomer=row.customerCode;
    if (!isGroup&&row.dispatchArea) button.dataset.dispatchArea=row.dispatchArea;
    const overlay=new (sdk().CustomOverlay)({position:new (sdk().LatLng)(row.lat,row.lng),content:button,
      xAnchor:.5,yAnchor:1,zIndex:50,clickable:true});
    return {button,overlay};
  }

  function queueMarkers() {
    if (frame===undefined || frame===null) frame=requestAnimationFrame(renderMarkers);
  }

  function fit(points) {
    const valid=points.filter(Boolean);
    if (!map() || !sdk() || !valid.length) return;
    bridge.setDispatchReferenceMapFit?.(true);
    const {LatLng,LatLngBounds}=sdk();
    if (valid.every(point=>point.lat===valid[0].lat&&point.lng===valid[0].lng)) {
      map().setLevel(Math.min(map().getLevel(),4));
      map().setCenter(new LatLng(valid[0].lat,valid[0].lng));
    } else {
      const bounds=new LatLngBounds();
      for (const {lat,lng} of valid) bounds.extend(new LatLng(lat,lng));
      map().setBounds(bounds,64,60,64,60);
    }
    queueMarkers();
  }
  function fitBoardPostal() {
    const current=map();
    if (!current || !sdk() || !boardPostal) return;
    const outline=polygonBounds.get(boardPostal);
    let bounds=Array.isArray(outline) && outline.length===4 && outline.every(Number.isFinite) ? outline : null;
    // A verified boundary sets the extent. Before it arrives, use only stores in this postcode.
    if (!bounds) {
      for (const row of markerRows) {
        if (!row.point || (row.dispatchOverlap!=='inside' && row.dispatchOverlap!=='registered')) continue;
        const {lat,lng}=row.point;
        bounds=bounds ? [Math.min(bounds[0],lng),Math.min(bounds[1],lat),
          Math.max(bounds[2],lng),Math.max(bounds[3],lat)] : [lng,lat,lng,lat];
      }
    }
    if (!bounds) return;
    const key=bounds.join('|');
    if (lastBoardFit?.map===current && lastBoardFit.key===key) return;
    lastBoardFit={map:current,key};
    const [west,south,east,north]=bounds;
    fit([{lat:south,lng:west},{lat:north,lng:east}]);
  }

  const fitRoutes=()=>boardPostal?fitBoardPostal():fit(markerRows.map(row=>row.point));

  function addOutlines() {
    if (!isOpen() || !map() || !sdk() || outlineRequest || !selectedPostcodes.length) return;
    const codes=selectedPostcodes;
    const controller=outlineRequest=new AbortController();
    const {LatLng,Polygon}=sdk();
    void (async ()=>{
      let count=0;
      for (const code of codes) {
        try {
          const boundary=await readOutline(code,{signal:controller.signal});
          if (controller.signal.aborted) return;
          if (!boundary?.rings?.length) continue;
          const path=boundary.rings.map(ring=>ring.map(([lng,lat])=>new LatLng(lat,lng)));
          const polygon=new Polygon({path,strokeWeight:2,strokeColor:color.overlap,strokeOpacity:.82,
            fillColor:color.overlap,fillOpacity:!postcode.value||postcode.value===code? .24 : .05,zIndex:12});
          polygon.setMap(map());
          polygons.push({code,polygon});
          polygonBounds.set(code,boundary.box);
          if (boardPostal===code) fitBoardPostal();
          else if (period&&postcode.value===code&&!markerRows.some(row=>row.postalCode===code&&row.point)) {
            const [west,south,east,north]=boundary.box;
            fit([{lat:south,lng:west},{lat:north,lng:east}]);
          }
          count++;
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      coverage.textContent=codes.length ? (period?'지도 경계 ':'공통 우편번호 '+codes.length+'곳 · 경계 ')+count+'곳'+
        (count<codes.length?' · 일부 경계 미확인':'') : '';
    })().finally(()=>{if(outlineRequest===controller)outlineRequest=null;});
  }

  function wireMap() {
    const current=map();
    if (!current || !sdk() || current===markerMap) return;
    if (markerMap) sdk().event.removeListener(markerMap,'idle',queueMarkers);
    markerMap=current;
    sdk().event.addListener(markerMap,'idle',queueMarkers);
    queueMarkers();
    addOutlines();
    fitRoutes();
  }

  function selectStop(row,{focus=false}={}) {
    if (row.dispatchSide==='extra'&&primary.value) {
      secondary.value=row.vehicle;
      if (!secondary.value) {
        populateDayVehicles(primary.value,row.vehicle);
      }
      updateRoutes();
      row=markerRows.find(item=>item.dispatchKey===row.dispatchKey)||row;
    }
    selection=row;
    document.body.classList.remove('dispatch-standard-detail-open');
    document.body.classList.add('dispatch-inspection');
    const nativeStore=!screenReview&&bridge.selectDispatchReferenceStore(row.customerCode,row.point);
    details.open=true;
    renderDetail();
    if (!nativeStore) detail.querySelector('.dispatch-native-detail')?.remove();
    requestAnimationFrame(()=>{
      if (!isOpen() || selection!==row || !row.point || !map() || !sdk()) return;
      const view=mapNode.getBoundingClientRect(), projection=map().getProjection();
      const point=new (sdk().LatLng)(row.point.lat,row.point.lng);
      if(focus){
        if(map().getLevel()>5)map().setLevel(5);
        map().panTo(point);
        return;
      }
      const pixel=projection.containerPointFromCoords(point);
      if(pixel.x>=45&&pixel.x<=view.width-45&&pixel.y>=54&&pixel.y<=view.height-32) return;
      map().panTo(point);
    });
    queueMarkers();
  }

  function selectFromMap(event) {
    if (!isOpen()||period) return;
    const code=event.detail?.customerCode;
    if (code===selection?.customerCode) return;
    const row=markerRows.find(item=>item.customerCode===code);
    if (row?.dispatchSide==='extra'&&primary.value) return selectStop(row);
    selection=row||null;
    document.body.classList.toggle('dispatch-inspection',Boolean(selection));
    document.body.classList.remove('dispatch-standard-detail-open');
    if (selection) details.open=true;
    renderDetail();
    queueMarkers();
  }

  function selectedRouteTotals(route) {
    if (!route) return '';
    const summary=route.detailSummary;
    return '<div class="dispatch-total"><strong>'+escape(route.vehicle)+'호</strong><b>'+(route.amount===null?'금액 미확인':money(route.amount))+
      '</b><small>'+escape(route.storeCount===null?'배송 매장 수 미확인':route.storeCount+'곳')+
      ' · '+escape(detailText(summary))+'</small></div>';
  }

  function gapMessage(source,target,moved) {
    const before=Math.abs(source.amount-target.amount), after=Math.abs(moved.sourceAmount-moved.targetAmount);
    return '<p class="dispatch-gap'+(after>before?' worsening':'')+'">호차 금액 격차 '+money(before)+' → '+money(after)+
      (after>before?' · 격차 증가':after<before?' · 격차 감소':' · 격차 동일')+'</p>';
  }

  const lookupKey=value=>value.normalize('NFKC').toLowerCase().replace(/\s|호차|호$/g,'');
  const matchesVehicle=vehicle=>lookupKey(vehicle).includes(lookupKey(vehicleSearch.value));

  function populateDayVehicles(anchor=primary.value,comparison=secondary.value) {
    for (const [select,selected] of [[primary,anchor],[secondary,comparison]]) {
      select.replaceChildren(new Option('호차 선택',''));
      for (const route of dayVehicles) {
        if (!screenReview&&!matchesVehicle(route.vehicle)&&route.vehicle!==selected) continue;
        select.add(new Option(route.vehicle+'호 · '+(route.storeCount===null?'매장 수 미확인':route.storeCount+'곳'),route.vehicle));
      }
      if (dayVehicles.some(route=>route.vehicle===selected)) select.value=selected;
    }
    if(boardMode()){
      compareSelect.replaceChildren(...[...secondary.options].filter(option=>option.value!==primary.value||!option.value)
        .map(option=>new Option(option.text,option.value,false,option.value===secondary.value)));
    }
  }

  function populatePeriodVehicles(selected) {
    const chosen=selected||new Set([...vehicles.selectedOptions].map(option=>option.value));
    vehicles.replaceChildren(...periodVehicles.filter(vehicle=>chosen.has(vehicle)||matchesVehicle(vehicle))
      .map(vehicle=>new Option(vehicle+'호',vehicle,false,chosen.has(vehicle))));
  }

  function renderFleet() {
    fleetList.replaceChildren();
    const anchor=primary.value;
    if (!anchor) {
      screenReview?.updateNearby([], {hasAnchor:false});
      fleetSummary.textContent='비교의 기준이 될 첫 번째 호차를 선택하세요.';
      return;
    }
    if (anchor!==focusedAnchor) {
      discoveries=discoverDispatchRoutes(model,anchor);
      focusedAnchor=anchor;
    }
    const within=item=>item.minimumKm!==null&&item.minimumKm<=.5;
    const postal=item=>item.sharedPostalCodes.length>0;
    if (screenReview) {
      screenReview.updateNearby(discoveries.filter(item=>postal(item)||within(item)), {hasAnchor:true});
      return;
    }
    const scope=fleetScope.value;
    const results=discoveries.filter(item=>matchesVehicle(item.source.vehicle)&&
      (scope==='all'||scope!=='nearby'&&postal(item)||scope!=='postal'&&within(item)));
    fleetSummary.textContent='비교 대상 '+discoveries.length+'대 · 공통 우편번호 '+discoveries.filter(postal).length+
      '대 · 500m 이내 '+discoveries.filter(within).length+'대 · 표시 결과 '+results.length+'대';
    for (const item of results) {
      const {source,sharedPostalCodes,sharedAreaCounts,sharedCustomers,minimumKm}=item;
      const vehicle=source.vehicle;
      const card=document.createElement('div');
      card.className='dispatch-fleet-result';
      const label=document.createElement('label');
      const checkbox=document.createElement('input');
      checkbox.type='checkbox';
      checkbox.checked=additionalVehicles.has(vehicle)||secondary.value===vehicle;
      checkbox.setAttribute('aria-label',vehicle+'호 지도에 추가');
      checkbox.onchange=()=>{
        if (checkbox.checked) additionalVehicles.add(vehicle);
        else {
          additionalVehicles.delete(vehicle);
          if (secondary.value===vehicle) secondary.value='';
        }
        updateRoutes();
      };
      label.append(checkbox,document.createTextNode(vehicle+'호'));
      const button=document.createElement('button');
      button.type='button';
      button.textContent='비교';
      button.setAttribute('aria-label',vehicle+'호 비교 및 확대');
      button.onclick=()=>{
        if (!Array.from(secondary.options).some(option=>option.value===vehicle)) populateDayVehicles(anchor,vehicle);
        secondary.value=vehicle;
        updateRoutes({focusMatch:true});
      };
      const shared=document.createElement('small');
      const counts=sharedAreaCounts.reduce(([a,b],area)=>[a+area.target,b+area.source],[0,0]);
      shared.textContent='공통 우편번호 '+sharedPostalCodes.length+'곳 · 양쪽 매장 '+counts[0]+'/'+counts[1]+'곳'+
        (sharedCustomers?' · 동일 고객 '+sharedCustomers+'곳':'');
      const measure=document.createElement('small');
      measure.textContent='최근접 '+meters(minimumKm)+' · '+(source.amount===null?'WMS 금액 미확인':money(source.amount));
      card.append(label,button,shared,measure);
      fleetList.append(card);
    }
  }

  function sharedAreaDetail() {
    const pair=comparisons?.secondary;
    if (!pair) return '';
    const {sharedAreaCounts,sharedCustomers,minimumKm}=pair;
    return '<details class="dispatch-overlap-detail"><summary>공통 우편번호 '+sharedAreaCounts.length+'곳</summary>'+
      '<p>동일 고객코드 '+sharedCustomers+'곳 · 최근접 직선거리 '+meters(minimumKm)+'</p>'+
      '<ul>'+sharedAreaCounts.map(area=>'<li>'+escape(area.code)+' · '+escape(pair.target.vehicle)+'호 '+area.target+
        '곳 / '+escape(pair.source.vehicle)+'호 '+area.source+'곳</li>').join('')+'</ul></details>';
  }

  function dailyProvenance() {
    const today=dayNow();
    const dateKind=model.date>today?'내일 확정 배차':model.date===today?'당일':'과거';
    const scope=model.routeSource==='WMS_CONFIRMED_DISPATCH_FRESHON_JSON'?
      'FreshOn 확정배차 조회 범위 · 오산 전체 운행호차 완전성 미확인':model.routeSource==='WMS_CONFIRMED_DISPATCH_EXPORT'?
      'WMS 내보내기 범위 · 오산 전체 운행호차 완전성 미확인':model.routeVerified?
        '확정 배차 원장 범위':'확정 배차 완전성 미확인';
    const amounts=model.amountsVerified?'WMS 배송일 '+model.amountDate+' · 자료 확인 '+sourceTime(model.amountObservedAt):'해당 배송일 WMS 금액 미확인';
    const sourceTotals=model.sourceTotals;
    const headline=sourceTotals
      ?'<p>WMS 원장 합계 <strong>'+money(sourceTotals.amount)+'</strong> · 배송 <strong>'+
        sourceTotals.deliveryCount.toLocaleString('ko-KR')+'건</strong></p>':'';
    return '<section class="dispatch-provenance"><strong>배송일 '+escape(model.date)+' · '+dateKind+'</strong>'+
      '<p>'+escape(scope)+'</p><p>'+escape(amounts)+'</p>'+headline+
      (model.date>today?'<p>배송완료 내역은 배송일 이후 확인할 수 있습니다.</p>':'')+'</section>';
  }

  function repeatedCustomerWarning() {
    if (!repeatedCustomers.size) return '';
    const selectedTrucks=repeatedCustomers.get(selection?.customerCode);
    const lines=[...repeatedCustomers].map(([code,trucks])=>'<li>'+escape(code)+' · '+
      [...trucks].map(vehicle=>escape(vehicle)+'호').join(' / ')+'</li>');
    return '<details class="dispatch-duplicate"'+(selectedTrucks?' open':'')+'>'+
      '<summary>동일 고객코드가 복수 호차에 표시 · '+lines.length+'곳</summary>'+
      '<p>확정 배차 원장과 이관 대상 확인이 필요합니다.</p><ul>'+lines.join('')+'</ul></details>';
  }

  function activateItem(row) {
    if (!row.dispatchArea) return selectStop(row);
    postcodeSearch.value='';
    populatePostcodes(row.dispatchArea);
    if (postcode.value===row.dispatchArea) showPostcode();
  }

  function populatePostcodes(wanted=postcode.value) {
    const query=postcodeSearch.value.trim();
    const matches=choicesPostcodes.filter(({zip})=>zip.startsWith(query));
    postcode.replaceChildren(new Option(matches.length?'우편번호 전체':'일치 우편번호 없음',''));
    for (const {zip,overlapDays,overlap} of matches) postcode.add(new Option(zip+
      (overlapDays!=null?' · 중첩 '+overlapDays+'일':overlap?' · 중첩':''),zip));
    postcode.disabled=!matches.length;
    if (matches.some(({zip})=>zip===wanted)) postcode.value=wanted;
  }

  function renderPeriodDetail() {
    if (!analysis) return;
    const {verified,unavailable,completed,partialCompleted,wms,exportScoped,osanScoped,areas,neighbors}=analysis;
    const selection=[...vehicles.selectedOptions].map(option=>option.value);
    const area=areas.find(entry=>entry.zip===chosenArea);
    const list=(items,show)=>items.length?'<ul>'+items.map(show).join('')+'</ul>':'<p class="dispatch-empty">확인 자료 없음</p>';
    const interval='<p>'+escape(period.start)+' ~ '+escape(period.end)+' · '+period.days+'일</p>'+
      '<p>배차 <strong>확정 '+verified.length+'일</strong> · 미확인 '+unavailable.length+'일</p>'+
      '<p>WMS 확인 범위 '+exportScoped.length+'일 · 오산 원장 검증 '+osanScoped.length+'일</p>'+
      '<p>배송완료 상태 확인 '+completed.length+'일'+(partialCompleted.length?' · 일부 확인 '+partialCompleted.length+'일':'')+
      ' · 미확인 '+(period.days-completed.length-partialCompleted.length)+'일</p>'+
      '<p>WMS 금액 확인 '+wms.length+'일 · 미확인 '+(period.days-wms.length)+'일</p>';
    const evidence=unavailable.length?'<details><summary>미확인 날짜 '+unavailable.length+'일</summary><p>'+
      escape(unavailable.join(' · '))+'</p></details>':'';
    const areaInfo=area?'<section><h3>우편번호 '+escape(area.zip)+'</h3><p>동일 날짜 복수 호차 배송 '+area.overlapDays+'일</p>'+
      list([...area.members.values()],member=>'<li>'+escape(member.vehicle)+'호 · '+member.days+'일 · 매장 누적 '+member.stops+'건</li>')+'</section>':'';
    const nearby='<details><summary>500m 이내 다른 호차 · '+neighbors.length+'쌍</summary>'+list(neighbors,pair=>
      '<li>'+escape(pair.a)+'호 / '+escape(pair.b)+'호 · '+pair.days+'일 · 최단 '+pair.meters+'m</li>')+'</details>';
    const totals=selection.flatMap(vehicle=>{
      const group=analysis.vehicles.get(vehicle);
      if (!group) return [];
      const {first,last,trend}=group;
      const added=last?.zips.filter(zip=>!first.zips.includes(zip))||[], removed=first?.zips.filter(zip=>!last.zips.includes(zip))||[];
      const changes=!first?'선택 기준 배송지역 자료 미확인':first.date===last.date?'비교 가능한 확정일 1일':
        escape(first.date)+' → '+escape(last.date)+' · 새 우편번호 '+added.length+'곳 · 빠진 우편번호 '+removed.length+'곳';
      return '<details><summary>'+escape(vehicle)+'호 · '+(group.days?group.days+'일 · 매장 누적 '+group.stops+'건':'배송지역 자료 미확인')+'</summary>'+
        '<p>'+changes+'</p>'+(added.length?'<p>추가 '+escape(added.join(', '))+'</p>':'')+
        (removed.length?'<p>제외 '+escape(removed.join(', '))+'</p>':'')+
        (group.unknown?'<p>우편번호 미확인 '+group.unknown+'건</p>':'')+
        '<h4>일별 확인된 WMS 금액</h4>'+list(trend,([day,amount])=>'<li>'+escape(day)+' · '+money(amount)+'</li>')+'</details>';
    }).join('');
    const basis=periodBasis.value==='completed'?'배송완료 확인':'확정 배차';
    detail.innerHTML='<h3>오산 기간별 배송 분석</h3>'+interval+evidence+'<p>지도 집계 · '+basis+'</p>'+areaInfo+nearby+totals;
  }

  const periodColors=['#1767d4','#dc6714','#157a57','#aa3556','#6552a3','#117991'];
  function updatePeriod() {
    const chosen=new Set([...vehicles.selectedOptions].map(option=>option.value));
    $('#dispatchSelectedVehicles').textContent=[...chosen].map(vehicle=>vehicle+'호').join(' · ')||'Ctrl+클릭으로 복수 선택';
    const truckColors=new Map([...chosen].map((vehicle,index)=>
      [vehicle,periodColors[index]||'hsl('+Math.round(index*137.508%360)+' 58% 38%)']));
    analysis=summarizeDispatchPeriod(period,chosen,periodBasis.value);
    chosenArea=null;
    choicesPostcodes=analysis.areas;
    markerRows=analysis.areas.flatMap(({zip,members})=>[...members.values()].flatMap(member=>{
      const {vehicle,days,point}=member;
      const position=point?{lat:point[0],lng:point[1]}:null;
      return [{customerCode:'',name:zip+' · '+days+'일',customerName:zip+' · '+days+'일',vehicle,point:position,
        lat:position?.lat,lng:position?.lng,postalCode:zip,dispatchArea:zip,
        dispatchKey:vehicle+'|'+zip,dispatchRole:'primary',routeColor:truckColors.get(vehicle)}];
    }));
    const overlap=analysis.areas.filter(area=>area.overlapDays);
    selectedPostcodes=overlap.slice(0,8).map(({zip})=>zip);
    postcodeSearch.value='';
    populatePostcodes('');
    clearMarkers();
    clearOutlines();
    renderStoreList();
    renderPeriodDetail();
    coverage.textContent=!chosen.size?'호차를 선택하세요.':'중첩 '+overlap.length+'곳'+(overlap.length>8?' · 상위 8개 경계 표시':'');
    addOutlines();
    queueMarkers();
    fit(markerRows.map(row=>row.point));
  }

  function showReviewDistance(candidate) {
    const left=candidate?.point,right=candidate?.nearest?.point;
    const current=map(),maps=sdk();
    const key=left&&right&&Number.isFinite(candidate.km)&&candidate.km<=.5?
      [left.lat,left.lng,right.lat,right.lng].join('|'):null;
    if(key===reviewLineKey)return;
    reviewLine?.setMap(null);
    reviewLine=null;
    reviewLineKey=null;
    if(!key||!current||!maps?.Polyline)return;
    reviewLineKey=key;
    reviewLine=new maps.Polyline({path:[new maps.LatLng(left.lat,left.lng),new maps.LatLng(right.lat,right.lng)],
      strokeWeight:4,strokeColor:'#7847a6',strokeOpacity:.9,strokeStyle:'shortdash',zIndex:28});
    reviewLine.setMap(current);
  }

  function renderDetail() {
    const showBoardDetails=Boolean(routes?.primary||selection);
    details.toggleAttribute('data-v4-detail',boardMode()&&showBoardDetails);
    compareControl.hidden=!boardMode()||!routes?.primary;
    if(boardMode()&&selection?.dispatchRole==='registered') {
      detail.innerHTML='<h3>'+escape(selection.name)+'</h3><p>'+escape(selection.customerCode)+' · '+escape(selection.postalCode)+
        '</p><p>현재 기준호차 '+escape(selection.vehicle)+'호</p>';
      return;
    }
    if (period) return renderPeriodDetail();
    if (comparisonMode()) return screenReview.update({
      model:period?null:model,routes,deliveryRows,zip:model?postcode.value:'',selection,showDistance:showReviewDistance,
      ...(boardMode()?{colorVehicle:dispatchVehicleColor,compactOverview:true}:{}),
      nearest:nearestDispatchStop,
      pickStop(code,vehicle){
        const row=markerRows.find(item=>item.customerCode===code&&(!vehicle||item.vehicle===vehicle));
        if(row)selectStop(row,{focus:true});
      },
      filterStops(rows) {
        markerRows=rows;
        if(selection&&!rows.includes(selection)){
          clearDispatchSelection();
          renderDetail();
        }
        clearMarkers();
        queueMarkers();
        fitRoutes();
      },
      chooseRoute(vehicle) {
        if (!primary.value||primary.value===vehicle) return;
        populateDayVehicles(primary.value,vehicle);
        updateRoutes();
      },
      choosePostal(code) {
        postcodeSearch.value='';
        populatePostcodes(code);
        showPostcode();
      },
      highlightMoves(moves) {
        transferKeys=new Set(moves.map(move=>move.source+'|'+move.customerCode));
        queueMarkers();
      },
    });
    if (!model) {
      detail.innerHTML='<p class="dispatch-empty">배송일을 조회하면 금액과 매장을 비교할 수 있습니다.</p>';
      return;
    }
    const top=dailyProvenance()+'<div class="dispatch-totals">'+selectedRouteTotals(routes?.primary)+selectedRouteTotals(routes?.secondary)+
      '</div>'+sharedAreaDetail()+repeatedCustomerWarning();
    if (!selection) {
      detail.innerHTML=top+'<p class="dispatch-empty">지도에서 배송 매장을 선택하세요.</p>';
      return;
    }
    const source=routes[selection.dispatchSide]||model.vehicles.get(selection.vehicle), side=selection.dispatchSide==='primary'?'secondary':'primary', target=routes[side];
    const comparison=comparisons?.[selection.dispatchSide];
    const closest=nearestDispatchStop(selection,target);
    const moved=simulateDispatchTransfer(comparison,selection.customerCode);
    const routeStatus=bridge.dispatchReferenceFixedVehicle?.(selection.customerCode);
    const rows=[
      ['고객코드',selection.customerCode],['조회일 확정호차',model.routeVerified?selection.vehicle+'호':'미확인 · 관측 '+selection.vehicle+'호'],
      ['현재 기준호차',routeStatus?routeStatus+'호':'미확인'],
      ['WMS 매장 금액',source?.displayAmounts?.has(selection.customerCode)?money(source.displayAmounts.get(selection.customerCode)):'금액 미확인'],
      ['우편번호',selection.postalCode||'미확인'],
      ['상대 호차 최근접 매장',closest?closest.stop.name+' · '+closest.stop.customerCode:'미확인'],
      ['직선거리',meters(closest?.km)],['도로거리 · 이동시간','미확인'],
    ];
    detail.innerHTML=top+'<h3>'+escape(selection.name)+'</h3><dl>'+rows.map(([label,value])=>
      '<div><dt>'+escape(label)+'</dt><dd>'+escape(value)+'</dd></div>').join('')+'</dl>'+
      (target?'<div class="dispatch-simulation"><h3>'+escape(source.vehicle)+'호 → '+escape(target.vehicle)+'호 가상 이관</h3>'+
      (moved?'<p><strong>'+escape(source.vehicle)+'호</strong> '+money(source.amount)+' → <b>'+money(moved.sourceAmount)+'</b> · '+moved.sourceCount+'곳</p>'+
        '<p><strong>'+escape(target.vehicle)+'호</strong> '+money(target.amount)+' → <b>'+money(moved.targetAmount)+'</b> · '+moved.targetCount+'곳</p>'+
        gapMessage(source,target,moved):
        '<p>최근접 500m와 금액 대조가 모두 확인된 매장만 계산합니다.</p>')+
      '<p class="dispatch-review"><strong>검토 필요</strong> · 목표 매출·실제 동선·적재량·배송시간 미확인</p></div>':'')+
      (selection.point?'<button class="dispatch-native-detail" type="button">현재 매장 상세</button>':'');
    const native=detail.querySelector('.dispatch-native-detail');
    if (native) native.onclick=()=>{
      document.body.classList.add('dispatch-standard-detail-open');
      if (!bridge.selectDispatchReferenceStore(selection.customerCode,selection.point)) {
        native.textContent='현재 등록 위치와 일치 여부 미확인';
      }
    };
  }

  function renderStoreList(only) {
    const displayed=only||markerRows.filter(row=>!postcode.value||row.postalCode===postcode.value);
    stores.replaceChildren();
    if (!displayed.length) return;
    if (only) {
      const heading=document.createElement('h3');
      heading.textContent='같은 위치 · '+displayed.length+'개 매장';
      stores.append(heading);
    }
    const list=document.createElement('details');
    list.open=Boolean(only||postcode.value);
    const summary=document.createElement('summary');
    summary.textContent=period?'호차별 배송지역 '+displayed.length+'개':'배송 매장 '+displayed.length+'곳';
    list.append(summary);
    for (const row of displayed) {
      const button=document.createElement('button');
      button.type='button';
      button.textContent=row.vehicle+'호 · '+row.name+(row.customerCode?' · '+row.customerCode:'');
      if (row.customerCode) button.dataset.dispatchListCustomer=row.customerCode;
      button.onclick=()=>activateItem(row);
      list.append(button);
    }
    stores.append(list);
  }

  function clearDispatchSelection() {
    const code=selection?.customerCode;
    selection=null;
    if (code&&!screenReview) bridge.clearDispatchReferenceSelection?.(code);
    document.body.classList.remove('dispatch-inspection','dispatch-standard-detail-open');
  }

  function chooseBoardRoute(vehicle) {
    if(!model||!boardMode())return;
    populateDayVehicles(vehicle,'');
    updateRoutes();
  }

  function applyBoardOverlap(candidate) {
    if(!isOpen()||!boardMode())return;
    if(!candidate) {
      boardPostal=lastBoardFit=null;
      mapLegend.hidden=true;
      if(model)chooseBoardRoute('');
      else {markerRows=[];clearMarkers();clearOutlines();clearDispatchSelection();renderDetail();}
      return;
    }
    primary.value=secondary.value=compareSelect.value='';
    routes={primary:null,secondary:null};
    comparisons=null;
    clearDispatchSelection();
    clearMarkers();
    const code=candidate.postalCode;
    const changed=boardPostal!==code;
    if(changed){
      clearOutlines();
      boardPostal=code;
      lastBoardFit=null;
    }
    const storesWithEvidence=candidate.stores??[];
    const colors=new Map(candidate.routes.map(({vehicle})=>[vehicle,dispatchVehicleColor(vehicle)]));
    const members=new Map(storesWithEvidence.map(store=>[store.customerCode,store]));
    const mappedInside=new Set();
    const dispatchRoutes=dispatchOverlapVehicles(model);
    markerRows=[];
    for(const [vehicle,routeColor] of colors) {
      const route=dispatchRoutes.get(vehicle);
      if(!route)continue;
      for(const stop of route.stops) {
        const registered=members.get(stop.customerCode)?.point;
        const samePoint=stop.point&&registered&&stop.point.lat===registered.lat&&stop.point.lng===registered.lng;
        const area=stop.postalCode?(stop.postalCode===code?'inside':'outside'):samePoint?'inside':'unknown';
        const inside=area==='inside';
        if(inside&&stop.point)mappedInside.add(vehicle+'|'+stop.customerCode);
        markerRows.push({...stop,lat:stop.point?.lat,lng:stop.point?.lng,customerName:stop.name,vehicle:route.vehicle,
          dispatchKey:route.vehicle+'|'+stop.customerCode,
          routeColor,dispatchSide:'area',dispatchRole:'area',dispatchOverlap:area});
      }
    }
    mapLegend.querySelector('strong').textContent='우편번호 '+code;
    mapLegend.querySelector('[data-overlap-key="unknown"]').hidden=!markerRows.some(row=>row.dispatchOverlap==='unknown'&&row.point);
    mapLegend.hidden=false;
    deliveryRows=markerRows.slice();
    for(const store of storesWithEvidence) {
      const deliveryKey=store.vehicle+'|'+store.customerCode;
      if(mappedInside.has(deliveryKey))continue;
      markerRows.push({...store,customerName:store.name,postalCode:code,lat:store.point?.lat,lng:store.point?.lng,
        routeColor:colors.get(store.vehicle),dispatchKey:'registered|'+deliveryKey,dispatchRole:'registered',
        dispatchSide:'area',dispatchOverlap:'registered'});
    }
    selectedPostcodes=[code];
    choicesPostcodes=[{zip:code,overlap:true}];
    populatePostcodes(code);
    fitBoardPostal();
    if(changed)addOutlines();
    renderDetail();
    renderFleet();
    queueMarkers();
  }

  function resetDispatchArea() {
    if(model&&boardMode()) {
      board.clearCandidate();
      chooseBoardRoute('');
    } else fitRoutes();
  }

  function updateRoutes({focusMatch=false}={}) {
    if (!model) return;
    boardPostal=lastBoardFit=null;
    if(mapLegend)mapLegend.hidden=true;
    const first=model.vehicles.get(primary.value), second=model.vehicles.get(secondary.value);
    const pair=first&&second&&first!==second;
    if (second&&first===second) secondary.value='';
    routes={primary:first,secondary:pair?second:null};
    if(boardMode())board.setVehicle(first?.vehicle||'');
    controls.querySelector('summary').textContent=[first,pair?second:null].filter(Boolean)
      .map(route=>route.vehicle+'호').join(' · ') || '오산 배차 조건';
    comparisons=pair?{
      primary:compareDispatchRoutes(model,second.vehicle,first.vehicle,.5),
      secondary:compareDispatchRoutes(model,first.vehicle,second.vehicle,.5),
    }:null;
    clearDispatchSelection();
    selectedPostcodes=comparisons?.secondary.sharedPostalCodes || [];
    if (screenReview) {
      selectedPostcodes=selectedPostcodes.slice(0,8);
      vehicleSearch.value='';
    }
    markerRows=[];
    const extra=(screenReview?[]:[...additionalVehicles]).filter(vehicle=>vehicle!==first?.vehicle&&vehicle!==second?.vehicle)
      .map(vehicle=>model.vehicles.get(vehicle)).filter(Boolean);
    const mapped=(boardMode()||screenReview)&&!first?dayVehicles.map(route=>['overview',route]):
      [...Object.entries(routes),...extra.map(route=>['extra',route])];
    const extraColors=['#137f5e','#7252b6','#a83d59','#177991'];
    let extraIndex=0;
    for (const [side,route] of mapped) {
      const candidates=new Set(comparisons?.[side]?.candidates.map(stop=>stop.customerCode));
      const routeColor=boardMode()&&route?dispatchVehicleColor(route.vehicle):side==='extra'?extraColors[extraIndex++%extraColors.length]:null;
      for (const stop of route?.stops||[]) markerRows.push({...stop,lat:stop.point?.lat,lng:stop.point?.lng,
        customerName:stop.name,vehicle:route.vehicle,dispatchKey:route.vehicle+'|'+stop.customerCode,
        dispatchSide:side,dispatchRole:side,routeColor,dispatchCandidate:!screenReview&&candidates.has(stop.customerCode),
        ...(screenReview?{amount:route.displayAmounts?.get(stop.customerCode)??null}:{})});
    }
    if(screenReview)deliveryRows=markerRows;
    const byCustomer=new Map();
    for (const {customerCode,vehicle} of markerRows) {
      if (!byCustomer.has(customerCode)) byCustomer.set(customerCode,new Set());
      byCustomer.get(customerCode).add(vehicle);
    }
    repeatedCustomers=new Map([...byCustomer].filter(([,trucks])=>trucks.size>1));
    const overlaps=new Set(selectedPostcodes);
    choicesPostcodes=[...new Set(markerRows.map(row=>row.postalCode).filter(Boolean))]
      .map(zip=>({zip,overlap:overlaps.has(zip)})).sort((a,b)=>Number(b.overlap)-Number(a.overlap)||a.zip.localeCompare(b.zip));
    postcodeSearch.value='';
    populatePostcodes('');
    clearMarkers();
    clearOutlines();
    coverage.textContent=selectedPostcodes.length?'우편번호 경계 조회 중':first?'좌표 확인 '+markerRows.filter(row=>row.point).length+' / '+markerRows.length+'곳':'';
    if (!screenReview)renderStoreList();
    renderDetail();
    renderFleet();
    addOutlines();
    queueMarkers();
    const points=focusMatch&&pair?markerRows.filter(row=>row.dispatchSide!=='extra'&&overlaps.has(row.postalCode)).map(row=>row.point).filter(Boolean):[];
    if (!points.length&&focusMatch&&comparisons?.secondary.candidates.length) {
      const closest=comparisons.secondary.candidates.reduce((a,b)=>a.km<=b.km?a:b);
      points.push(closest.point,closest.nearest.point);
    }
    fit(points.length?points:markerRows.map(row=>row.point));
  }

  function showPostcode() {
    const code=postcode.value;
    if (boardPostal) { fitBoardPostal();return; }
    if (period) {
      chosenArea=code||null;
      if (code&&!selectedPostcodes.includes(code)) {
        clearOutlines();
        selectedPostcodes=[code];
        addOutlines();
      }
      renderPeriodDetail();
    }
    if(screenReview&&!period){
      const expected=code?[code]:(comparisons?.secondary?.sharedPostalCodes||[]).slice(0,8);
      if(code?(!selectedPostcodes.includes(code)||!outlineRequest&&!polygonBounds.has(code)):
          expected.join('|')!==selectedPostcodes.join('|')){
        clearOutlines();
        selectedPostcodes=expected;
        addOutlines();
      }
    }
    for (const {code:area,polygon} of polygons) polygon.setOptions({fillOpacity:!code||area===code? .24 : .05});
    const box=polygonBounds.get(code);
    if (box) fit([{lat:box[1],lng:box[0]},{lat:box[3],lng:box[2]}]);
    else fit(markerRows.filter(row=>!code||row.postalCode===code).map(row=>row.point));
    if (!screenReview)renderStoreList();
    if(screenReview&&!period)renderDetail();
  }
  postcode.onchange=showPostcode;
  postcodeSearch.oninput=()=>{
    const query=postcodeSearch.value.replace(/\D/g,'').slice(0,5);
    postcodeSearch.value=query;
    populatePostcodes();
    if (query.length===5&&choicesPostcodes.some(({zip})=>zip===query)) {
      postcode.value=query;
      showPostcode();
    }
  };
  vehicles.onchange=updatePeriod;
  primary.onchange=()=>{
    if (screenReview) secondary.value='';
    updateRoutes();
  };
  secondary.onchange=updateRoutes;
  fleetScope.onchange=renderFleet;
  vehicleSearch.oninput=()=>{
    if (comparisonMode()) screenReview.search(vehicleSearch.value);
    else if (period) populatePeriodVehicles();
    else if (model) {populateDayVehicles();renderFleet();}
  };

  function reset() {
    request?.abort();
    request=null;
    boardPostal=lastBoardFit=null;
    model=routes=comparisons=period=analysis=chosenArea=null;
    board?.setDay(null);
    if(mapLegend)mapLegend.hidden=true;
    clearDispatchSelection();
    markerRows=[];
    deliveryRows=[];
    repeatedCustomers.clear();
    dayVehicles=periodVehicles=discoveries=[];
    focusedAnchor=null;
    additionalVehicles.clear();
    vehicleSearch.value='';
    fleetList.replaceChildren();
    controls.querySelector('summary').textContent='오산 배차 조건';
    selectedPostcodes=[];
    choicesPostcodes=[];
    clearMarkers();
    clearOutlines();
    choices.hidden=!boardMode();
    status.textContent='';
    renderDetail();
  }

  form.onsubmit=async event=>{
    event.preventDefault();
    const prior=[primary.value,secondary.value];
    const periodMode=mode.value==='period';
    const today=updateDateLimit(periodMode), selectedDate=date.value;
    reset();
    if(!selectedDate||!date.validity.valid)return;
    const controller=request=new AbortController();
    status.textContent=periodMode?'확정된 기간 자료를 분석하고 있습니다.':'확정 배차와 WMS 금액을 조회하고 있습니다.';
    try {
      const options={signal:controller.signal};
      const value=periodMode?await readPeriod(selectedDate,Number(days.value),options):await readDay(selectedDate,options);
      if (controller.signal.aborted || !isOpen()) return;
      if (periodMode) {
        period=value;
        const available=summarizeDispatchPeriod(period,new Set()).vehicles;
        periodVehicles=[...available.keys()].sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}));
        populatePeriodVehicles(new Set(['101','208'].every(vehicle=>available.has(vehicle))?['101','208']:periodVehicles.slice(0,2)));
        status.textContent=available.size?'호차를 선택하면 확인된 배송지역이 지도에 표시됩니다.':'조회 기간에 확인된 배차 자료가 없습니다.';
        choices.hidden=!available.size;
        updatePeriod();
        return;
      }
      model=createDispatchReference(value,[],selectedDate);
      board?.setDay(model);
      if (!model.routeVerified && !model.vehicles.size) {
        status.textContent=selectedDate>today?'내일 게시된 확정 배차가 아직 없습니다.':'선택한 배송일의 확정 배차 미확인 · WMS 금액 미확인';
        return;
      }
      status.textContent=[!model.routeVerified&&'확정 배차 미확인',!model.amountsVerified&&'같은 배송일 WMS 금액 미확인'].filter(Boolean).join(' · ');
      dayVehicles=[...model.vehicles.values()].filter(route=>boardMode()&&model.amountsVerified?
        route.wmsConfirmed&&route.vehicle!=='미배정':route.stops.length).sort((a,b)=>a.vehicle.localeCompare(b.vehicle,'ko',{numeric:true}));
      populateDayVehicles(...(screenReview?[prior[0],'']:prior));
      choices.hidden=!boardMode()&&!dayVehicles.length;
      const activeCandidate=board?.currentCandidate();
      if(activeCandidate)applyBoardOverlap(activeCandidate);
      else updateRoutes();
    } catch {
      if (!controller.signal.aborted) status.textContent='배송 자료를 불러오지 못했습니다. 다시 조회하세요.';
    }
  };
  date.onchange=()=>{ if (date.validity.valid && date.value) form.requestSubmit(); };
  days.onchange=()=>form.requestSubmit();
  periodBasis.onchange=()=>{if (period) updatePeriod();};
  mode.onchange=()=>{
    const periodMode=mode.value==='period';
    updateDateLimit(periodMode);
    if(date.value>date.max)date.value=date.max;
    $('.dispatch-period-field').hidden=!periodMode;
    $('.dispatch-period-basis').hidden=!periodMode;
    $('.dispatch-period-vehicles').hidden=!periodMode;
    $('.dispatch-primary').hidden=$('.dispatch-secondary').hidden=periodMode;
    fleet.hidden=periodMode;
    $('.dispatch-legend').hidden=periodMode;
    $('[data-date-label]').textContent=periodMode?'기간 종료일':'배송일';
    syncComparisonLayout();
    requestAnimationFrame(()=>{if(isOpen())map()?.relayout();});
    form.requestSubmit();
  };
  controls.addEventListener('keydown',event=>{if(event.key==='Escape' && document.activeElement?.tagName==='SELECT') event.stopPropagation();});
  return {
    open() {
      if (active) return;
      active=true;
      const current=map();
      if (current) savedView={center:current.getCenter(),level:current.getLevel()};
      controls.hidden=false;
      controls.open=true;
      details.hidden=false;
      details.open=true;
      if (mapNode) observer.observe(mapNode);
      mapReset?.addEventListener('click',resetDispatchArea);
      const today=updateDateLimit(mode.value==='period');
      date.value=today;
      syncComparisonLayout();
      window.addEventListener('map-sdk-ready',wireMap);
      window.addEventListener('map-store-selected',selectFromMap);
      window.addEventListener('map-fixed-master-ready',renderDetail);
      wireMap();
      requestAnimationFrame(()=>{if (isOpen()) {map()?.relayout();form.requestSubmit();}});
    },
    close({restoreView=true}={}) {
      if (!active) return;
      active=false;
      board?.close();
      document.body.removeAttribute('data-dispatch-v4');
      screenReview?.close();
      showReviewDistance();
      reset();
      observer.disconnect();
      mapReset?.removeEventListener('click',resetDispatchArea);
      bridge.setDispatchReferenceMapFit?.(false);
      controls.hidden=details.hidden=true;
      window.removeEventListener('map-sdk-ready',wireMap);
      window.removeEventListener('map-store-selected',selectFromMap);
      window.removeEventListener('map-fixed-master-ready',renderDetail);
      if (markerMap) sdk()?.event.removeListener(markerMap,'idle',queueMarkers);
      markerMap=null;
      if (frame!=null) cancelAnimationFrame(frame);
      frame=null;
      const view=savedView;
      savedView=null;
      if (restoreView && view) requestAnimationFrame(()=>{
        if (active || !map()) return;
        map().relayout();
        map().setLevel(view.level);
        map().setCenter(view.center);
      });
    },
    clear:reset,
  };
}
