/* Shared lookup rules for search fields, map selections and route pins. */
(function(root){
  'use strict';
  const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('ko');
  const located=row=>!!row&&row.coordinateStatus!=='CONFLICT'&&Number.isFinite(row.lat)&&Number.isFinite(row.lng)&&row.lat>=33&&row.lat<=39.5&&row.lng>=124&&row.lng<=132;
  function unique(rows){
    const result=new Map();
    for(const row of rows||[]){
      if(!row?.customerCode)continue;
      const code=String(row.customerCode),prior=result.get(code);
      if(!prior){result.set(code,row);continue;}
      const addressConflict=normalize(prior.address)&&normalize(row.address)&&normalize(prior.address)!==normalize(row.address);
      const coordinateConflict=located(prior)&&located(row)&&(prior.lat!==row.lat||prior.lng!==row.lng);
      if(addressConflict||coordinateConflict)result.set(code,{...prior,coordinateStatus:'CONFLICT'});
      else if(!located(prior)&&located(row)&&prior.coordinateStatus!=='CONFLICT')result.set(code,row);
    }
    return [...result.values()];
  }
  function resolve(value,rows){
    const key=normalize(value);if(!key)return [];
    const records=unique(rows),codes=records.filter(row=>normalize(row.customerCode)===key);
    if(codes.length)return codes;
    return records.filter(row=>[row.customerName,row.address].some(text=>normalize(text)===key));
  }
  function search(value,rows,limit=12){
    const key=normalize(value),records=unique(rows);
    if(!key)return records.filter(row=>row.customerCode.startsWith('CENTER_')).slice(0,limit);
    return records.map(row=>{
      const code=normalize(row.customerCode),name=normalize(row.customerName),address=normalize(row.address);
      const rank=code===key?0:name===key?1:code.startsWith(key)?2:name.startsWith(key)?3:name.includes(key)?4:address.includes(key)?5:99;
      return {row,rank};
    }).filter(item=>item.rank<99).sort((a,b)=>a.rank-b.rank||String(a.row.customerName).localeCompare(String(b.row.customerName),'ko')).slice(0,limit).map(item=>item.row);
  }
  const centerNames={osan:'오산센터',yeongnam:'영남센터',honam:'호남센터'};
  function registeredCenters(){
    const rows=root.KAKAO_MAP_CONFIG?.centers;
    if(!Array.isArray(rows))return [];
    return unique(rows.filter(row=>row&&Object.hasOwn(centerNames,row.id)&&row.verified===true&&
      typeof row.sourceVersion==='string'&&row.sourceVersion.trim()&&located(row))
      .map(row=>({...row,customerCode:'CENTER_'+row.id,customerName:centerNames[row.id],address:row.address||'',coordinateStatus:'VERIFIED'}))).filter(located);
  }
  function visitCodes(rows,currentRows){
    if(!Array.isArray(rows)||rows.length<2)throw Error('방문 목록에서 두 개 이상의 매장을 선택해 주세요.');
    if(rows.length>32)throw Error('방문 목록이 '+rows.length+'개입니다. 출발지와 목적지를 포함해 32개까지 적용할 수 있습니다.');
    const seen=new Map(),codes=[];
    for(let index=0;index<rows.length;index++){
      const row=rows[index],code=String(row?.customerCode||'').trim();
      if(!code)throw Error((index+1)+'번째 매장의 고객코드를 확인해 주세요.');
      if(!located(row))throw Error((row.customerName||code)+'의 위치를 확인한 뒤 목록을 적용해 주세요.');
      const found=resolve(code,currentRows);
      if(found.length!==1||!located(found[0])||found[0].lat!==row.lat||found[0].lng!==row.lng)throw Error((row.customerName||code)+'의 위치가 현재 매장 정보와 다릅니다. 목록을 다시 조회해 주세요.');
      if(seen.has(code)&&!(seen.get(code)===0&&index===rows.length-1))throw Error((row.customerName||code)+'이 방문 목록에 여러 번 있습니다. 경로 지점을 직접 지정해 주세요.');
      seen.set(code,index);codes.push(code);
    }
    return codes;
  }
  function recordedVisitCodes(rows,currentRows,vehicle,origin){
    if(!vehicle||!Array.isArray(rows)||rows.some(row=>!Number.isSafeInteger(row?.order)||row.order<1||String(row.vehicle||'')!==String(vehicle))||new Set(rows.map(row=>row.order)).size!==rows.length)throw Error('선택한 호차의 저장된 방문 순서를 확인해 주세요.');
    const ordered=[...rows].sort((a,b)=>a.order-b.order);
    if(origin){if(!String(origin.customerCode||'').startsWith('CENTER_')||!located(origin))throw Error('센터 출발지의 위치를 확인해 주세요.');ordered.unshift(origin);}
    return visitCodes(ordered,currentRows);
  }
  function createTemporaryPlaces(){
    const rows=new Map();let sequence=0;
    return {
      add(row){
        if(row?.customerCode)return row;
        if(!located(row))return null;
        const key=JSON.stringify([row.lat,row.lng,normalize(row.address)]);
        if(!rows.has(key))rows.set(key,{...row,customerCode:'POINT_'+(++sequence),customerName:row.customerName||row.address||'선택한 위치',virtual:true});
        return {...rows.get(key)};
      },
      values:()=>[...rows.values()].map(row=>({...row})),
      retainSearchPoints(codes){const keep=new Set(codes);for(const [key,row]of rows)if(row.searchTemporary&&!keep.has(row.customerCode))rows.delete(key);},
      clear(){rows.clear();}
    };
  }
  // Official Web guide: map.kakao.com/link (PC / mobile web), max five via points.
  // These links never query Mobility Directions or calculate distance/time here.
  function kakaoPoint(row){
    if(!located(row))throw Error('카카오 길찾기에 전달할 지점의 위치를 확인해 주세요.');
    const name=String(row.customerName||row.address||row.customerCode||'선택한 위치').trim();
    return encodeURIComponent(name)+','+row.lat+','+row.lng;
  }
  function kakaoDestinationLink(destination,origin){
    const to=kakaoPoint(destination);
    return 'https://map.kakao.com/link/'+(origin?'from/'+kakaoPoint(origin)+'/to/':'to/')+to;
  }
  function kakaoRouteLinks(rows){
    if(!Array.isArray(rows)||rows.length<2||rows.length>32)throw Error('출발지와 목적지를 포함해 2~32개 지점을 확인해 주세요.');
    // Validate every point before splitting; an unresolved point is never skipped.
    const points=rows.map(kakaoPoint),segments=[];
    for(let start=0;start<points.length-1;start+=6){
      const end=Math.min(start+6,points.length-1);
      segments.push({start,end,url:'https://map.kakao.com/link/by/car/'+points.slice(start,end+1).join('/')});
    }
    return segments;
  }
  function kakaoLegLinks(rows){
    kakaoRouteLinks(rows); // Validate the complete route before making any fallback link.
    return rows.slice(0,-1).map((origin,start)=>{
      const destination=rows[start+1],sameCoordinate=origin.lat===destination.lat&&origin.lng===destination.lng;
      return {start,end:start+1,sameCoordinate,url:kakaoDestinationLink(destination,sameCoordinate?undefined:origin)};
    });
  }
  root.MapNavigationLookup=Object.freeze({normalize,located,unique,resolve,search,registeredCenters,visitCodes,recordedVisitCodes,createTemporaryPlaces,kakaoDestinationLink,kakaoRouteLinks,kakaoLegLinks});
})(typeof window==='object'?window:globalThis);

(()=>{
  'use strict';
  if(typeof document!=='object')return;
  const $=selector=>document.querySelector(selector),bridge=window.MapUiLocalBridge,editor=window.MapNavigationEditor,lookup=window.MapNavigationLookup;
  const planner=$('#waypointPlanner'),routeList=$('#runListTool'),mapArea=$('#map')?.parentElement;
  if(!bridge||!editor||!planner||!routeList||!mapArea)return;
  const plannerAnchor=document.createComment('navigation-planner-home'),routeAnchor=document.createComment('navigation-list-home');
  planner.before(plannerAnchor);routeList.before(routeAnchor);
  const workspace=document.createElement('section');workspace.id='navigationWorkspace';workspace.className='navigationWorkspace';workspace.hidden=true;
  workspace.innerHTML='<section id="navigationSummary" aria-label="길찾기 결과"><div class="sectiontitle"><h2>길찾기</h2><span id="navigationMeaning">자동차</span></div><p id="navRouteStatus" role="status">출발지와 목적지를 선택해 주세요.</p><div class="navToggles"><label><input id="navRoadLines" type="checkbox" checked>경로선 표시</label></div><button id="queryRecordedRoute" type="button">방문 목록 적용</button><div id="navLegs" aria-label="구간별 거리와 시간"></div></section>';
  $('.scrollside').append(workspace);
  const routeTotals=document.createElement('div');routeTotals.id='mapRouteTotals';routeTotals.hidden=true;
  routeTotals.setAttribute('role','status');
  routeTotals.innerHTML='<span id="navPartialTotals" hidden>일부 구간</span><span>주행거리 <b id="navDistance">— km</b></span><span>예상 소요시간 <b id="navDuration">— 분</b></span>';
  mapArea.append(routeTotals);
  if($('#syncOperation'))$('#navigationSummary').append($('#syncOperation'));
  const dailyStatus=document.createElement('p');dailyStatus.id='navDailyStatus';dailyStatus.setAttribute('role','status');
  const readinessStatus=document.createElement('p');readinessStatus.id='navReadiness';readinessStatus.setAttribute('role','status');
  planner.querySelector('summary').after(dailyStatus);
  planner.querySelector('.plannerActions').after(readinessStatus);
  const centerChoices=document.createElement('div');centerChoices.className='navCenterChoices';centerChoices.setAttribute('aria-label','센터에서 출발');dailyStatus.after(centerChoices);
  const suggestions=document.createElement('div');suggestions.id='navSearchResults';suggestions.className='navSearchResults';suggestions.hidden=true;suggestions.setAttribute('role','listbox');suggestions.setAttribute('aria-label','매장 검색 결과');
  const missing=document.createElement('details');missing.id='navMissingStores';missing.innerHTML='<summary>위치 확인이 필요한 매장</summary><div></div>';workspace.append(missing);
  const temporaryPlaces=lookup.createTemporaryPlaces(),explicitStores=new Map();
  let addressSearchController=null,addressSearchGeneration=0;
  let recalculateTimer=null,autoRecalculate=false;
  let centers=[],centerMarker=null,otherCenterMarkers=[],centerDraw=null,routePointOverlays=[],lastResult=null,lastKind='manual',disposed=false,activeInput=null,roleSignature='',missingSignature='',suggestTimer=null,suggestionIndex=-1;
  let mode=bridge.state.mode,manualValues=['',''];
  let dailyIdentity='',dailyDefaults=[],dailyStops=[],dailyController=null;
  let readiness=null,readinessController=null;
  function all(){
    const verified=scope==='daily'?dailyStops:[];
    const codes=new Set(verified.map(row=>row.customerCode));
    const records=lookup.unique([...bridge.navigationStores(scope==='manual'?'BASE_60D':undefined).filter(row=>!codes.has(row.customerCode)),...verified,...centers,...temporaryPlaces.values()]);
    for(const row of explicitStores.values()){
      const known=records.findIndex(item=>item.customerCode===row.customerCode);
      if(known<0)records.push(row);
      else if(records[known].coordinateStatus!=='CONFLICT'&&!lookup.located(records[known]))records[known]=row;
    }
    return records;
  }
  const resolve=value=>lookup.resolve(value,all());
  const status=text=>{const node=$('#plannerStatus');node.hidden=!text;node.textContent=text;};
  function refreshPointActions(){
    const candidate=bridge.state.selected||bridge.state.virtual;
    document.querySelectorAll('#detail [data-nav-pick]').forEach(button=>button.disabled=!lookup.located(candidate));
  }
  function onPointClick(event){
    const button=event.target.closest?.('#detail [data-nav-pick]');
    if(!button)return;
    const candidate=bridge.state.selected||bridge.state.virtual;
    if(candidate&&choosePoint(button.dataset.navPick,candidate)){
      bridge.closeNavigationSelection?.();
      if(window.innerWidth<=900)planner.scrollIntoView({block:'nearest'});
    }else{
      const feedback=button.parentElement.nextElementSibling;
      if(feedback?.matches('[data-nav-feedback]'))feedback.textContent=$('#plannerStatus').textContent;
    }
  }
  $('#detail').addEventListener('click',onPointClick);
  function choosePoint(role,row,index){
    row=temporaryPlaces.add(row);
    if(!lookup.located(row)){status('위치를 확인한 뒤 추가해 주세요.');return false;}
    if(!row.virtual&&!row.customerCode.startsWith('CENTER_')){
      const {customerCode,customerName,address,lat,lng,coordinateStatus}=row;
      explicitStores.set(customerCode,{customerCode,customerName,address,lat,lng,coordinateStatus});
    }
    try {
      if(!lookup.located(resolve(row.customerCode)[0]))throw Error('선택한 지점의 위치를 확인해 주세요.');
      editor.setPoint(role,row.customerCode,index);
      const roleName=role==='origin'?'출발지':role==='destination'?'목적지':'경유지';
      status(row.customerName+' · '+roleName+'로 지정했습니다.');
      hideSuggestions();planner.open=true;
      return true;
    }catch(error){status(error.message);return false;}
  }
  function fieldRole(input){return input.id==='plannerStart'?'origin':input.id==='plannerEnd'?'destination':input.dataset.navRole||'waypoint';}
  function fieldIndex(input){const index=input.dataset.navIndex;return fieldRole(input)==='waypoint'&&index!==undefined?Number(index):undefined;}
  function inputs(){return [...planner.querySelectorAll('#plannerStart,#plannerEnd,#plannerStops input')];}
  function cancelAddressSearch(){addressSearchGeneration++;addressSearchController?.abort();addressSearchController=null;}
  function hideSuggestions(){cancelAddressSearch();clearTimeout(suggestTimer);suggestions.hidden=true;activeInput?.setAttribute('aria-expanded','false');suggestionIndex=-1;}
  function renderSuggestions(input){
    if(!input?.isConnected)return;
    cancelAddressSearch();activeInput=input;const found=lookup.search(input.value,all());suggestions.replaceChildren();suggestionIndex=-1;
    const host=input.closest('.navEditorField')||input.closest('.waypointRow')||input;
    host.after(suggestions);
    for(const row of found){
      const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.dataset.code=row.customerCode;button.disabled=!lookup.located(row);
      const name=document.createElement('strong');name.textContent=row.customerName||row.customerCode;
      const meta=document.createElement('small');meta.textContent=[row.virtual?'임시 위치':row.customerCode,row.address,!lookup.located(row)?'위치 확인 필요':''].filter(Boolean).join(' · ');button.append(name,meta);
      button.onmousedown=event=>event.preventDefault();
      button.onclick=()=>{const role=fieldRole(input),index=fieldIndex(input);if(choosePoint(role,row,index)){const current=role==='origin'?$('#plannerStart'):role==='destination'?$('#plannerEnd'):planner.querySelector(`input[data-nav-role="waypoint"][data-nav-index="${index}"]`);current?.focus();hideSuggestions();}};
      suggestions.append(button);
    }
    if(!found.length){const message=document.createElement('p');message.textContent=input.value.trim()?'검색 결과가 없습니다. 고객코드·매장명·주소를 확인해 주세요.':'고객코드·매장명·주소로 검색해 주세요.';suggestions.append(message);}
    if(!found.length&&input.value.trim()&&bridge.canLookupNavigationAddress?.()===true){
      const button=document.createElement('button');button.type='button';button.id='navLookupAddress';button.className='navLookupAddress';button.textContent='주소로 위치 찾기';button.onmousedown=event=>event.preventDefault();button.onclick=()=>lookupAddress(input);suggestions.append(button);
    }
    suggestions.hidden=false;input.setAttribute('aria-expanded','true');
  }
  async function lookupAddress(input){
    cancelAddressSearch();
    if(bridge.canLookupNavigationAddress?.()!==true||typeof bridge.lookupNavigationAddress!=='function')return;
    const query=input.value.trim();if(!query)return;
    const generation=addressSearchGeneration,controller=new AbortController(),context=JSON.stringify([bridge.state.mode,bridge.state.selectedDate]),value=input.value;
    addressSearchController=controller;suggestions.replaceChildren();const message=document.createElement('p');message.setAttribute('role','status');message.textContent='주소 위치를 찾고 있습니다.';suggestions.append(message);suggestions.hidden=false;
    const current=()=>!controller.signal.aborted&&generation===addressSearchGeneration&&input.isConnected&&activeInput===input&&input.value===value&&context===JSON.stringify([bridge.state.mode,bridge.state.selectedDate]);
    try{
      const result=await bridge.lookupNavigationAddress(query,controller.signal);if(!current())return;
      const candidates=(Array.isArray(result?.candidates)?result.candidates:result?[result]:[]).filter(row=>lookup.located(row)&&String(row.address||'').trim());
      suggestions.replaceChildren();suggestionIndex=-1;
      const instruction=document.createElement('p');instruction.textContent=candidates.length?'경로에 사용할 주소를 선택해 주세요.':'일치하는 주소를 찾지 못했습니다. 도로명과 건물번호를 확인해 주세요.';suggestions.append(instruction);
      for(const candidate of candidates){
        const row={...candidate,customerCode:'',customerName:candidate.placeName||candidate.address,virtual:true},button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.dataset.navAddressResult='true';
        const name=document.createElement('strong');name.textContent=row.address;const hint=document.createElement('small');hint.textContent='선택하면 이 경로에서만 사용합니다.';button.append(name,hint);button.onmousedown=event=>event.preventDefault();
        button.onclick=()=>{if(!current())return;choosePoint(fieldRole(input),row,fieldIndex(input));};suggestions.append(button);
      }
    }catch(error){if(current()){suggestions.replaceChildren();const message=document.createElement('p');message.textContent='주소 위치를 찾지 못했습니다. 잠시 후 다시 시도해 주세요.';suggestions.append(message);}}
    finally{if(generation===addressSearchGeneration)addressSearchController=null;}
  }
  function describeInputs(){
    for(const input of inputs()){
      input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','navSearchResults');if(!input.hasAttribute('aria-expanded'))input.setAttribute('aria-expanded','false');
      const field=input.closest('.navEditorField')||input.parentNode;let detail=field.querySelector('.navFieldDetail');
      if(!input.id)input.id='navWaypoint'+(input.dataset.navIndex||inputs().indexOf(input));
      if(!detail){detail=document.createElement('small');detail.className='navFieldDetail';detail.dataset.navDetailFor=input.id;const after=input.closest('.pointInputRow')||input;after.after(detail);}
      const found=resolve(input.dataset.pointCode||input.value),row=found.length===1?found[0]:null;
      detail.textContent=row?[row.customerName,row.address].filter(Boolean).join(' · '):'';detail.hidden=!row;
      input.dataset.resolved=String(!!row&&lookup.located(row));
    }
  }
  planner.addEventListener('focusin',event=>{if(event.target.matches('#plannerStart,#plannerEnd,#plannerStops input'))renderSuggestions(event.target);});
  planner.addEventListener('input',event=>{if(!event.target.matches('#plannerStart,#plannerEnd,#plannerStops input'))return;clearTimeout(suggestTimer);const input=event.target;suggestTimer=setTimeout(()=>renderSuggestions(input),100);});
  planner.addEventListener('keydown',event=>{
    if(!event.target.matches('#plannerStart,#plannerEnd,#plannerStops input'))return;
    if(event.key==='Escape'){hideSuggestions();event.stopPropagation();return;}
    const options=[...suggestions.querySelectorAll('button:not(:disabled)')];
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();if(suggestions.hidden)renderSuggestions(event.target);
      const available=[...suggestions.querySelectorAll('button:not(:disabled)')];if(!available.length)return;
      suggestionIndex=suggestionIndex<0?(event.key==='ArrowDown'?0:available.length-1):(suggestionIndex+(event.key==='ArrowDown'?1:-1)+available.length)%available.length;
      available.forEach((button,index)=>button.setAttribute('aria-selected',String(index===suggestionIndex)));available[suggestionIndex].scrollIntoView({block:'nearest'});
    }else if(event.key==='Enter'&&!suggestions.hidden){event.preventDefault();const selected=options[suggestionIndex]||(options.length===1?options[0]:null);if(selected)selected.click();else if(options.length)status('검색 결과에서 매장을 선택해 주세요.');}
  });
  function outsidePointer(event){if(!planner.contains(event.target))hideSuggestions();}
  document.addEventListener('pointerdown',outsidePointer);
  function roleRows(){
    const values=editor.values(),records=all();return values.flatMap((value,index)=>{
      if(!String(value||'').trim())return [];
      const matches=lookup.resolve(value,records);if(matches.length!==1||!lookup.located(matches[0]))return [];
      return [{row:matches[0],index,role:index===0?'origin':index===values.length-1?'destination':'waypoint',label:index===0?'출발':index===values.length-1?'도착':'경유 '+index}];
    });
  }
  function renderRolePins(){
    const roles=roleRows(),signature=JSON.stringify([bridge.state.mode,roles.map(item=>[item.row.customerCode,item.row.customerName,item.row.lat,item.row.lng,item.role,item.index])]);
    if(!bridge.state.map||signature===roleSignature)return;roleSignature=signature;
    routePointOverlays.forEach(overlay=>overlay.setMap(null));routePointOverlays=[];
    const assigned=new Set(roles.map(item=>item.row.storeCode||item.row.customerCode));
    document.querySelectorAll('.marker[data-customer-code]').forEach(node=>node.classList.toggle('navAssigned',assigned.has(node.dataset.customerCode)));
    if(!window.kakao?.maps?.CustomOverlay)return;
    const groups=new Map();for(const item of roles){const key=item.row.lat+','+item.row.lng;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
    for(const items of groups.values()){
      if(items.every(item=>item.row.customerCode==='CENTER_osan'))continue;
      const group=document.createElement('div');group.className='navRoutePointGroup';
      for(const item of items){
        const label=document.createElement('button');label.type='button';label.className='navRoutePoint';label.dataset.role=item.role;label.dataset.customerCode=item.row.customerCode;label.textContent=item.label;
        const name=document.createElement('small');name.textContent=item.row.customerName||item.row.customerCode;label.append(name);label.setAttribute('aria-label',item.label+' · '+name.textContent);
        label.onclick=event=>{event.stopPropagation();if(item.row.customerCode==='CENTER_osan')centerMarker?.button.click();else if(item.row.virtual)bridge.selectNavigationPoint?.(item.row);else if(!item.row.customerCode.startsWith('CENTER_'))bridge.selectNavigationStore(item.row.storeCode||item.row.customerCode);};group.append(label);
      }
      const first=items[0].row,overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(first.lat,first.lng),content:group,zIndex:30,yAnchor:1.15});overlay.setMap(bridge.state.map);routePointOverlays.push(overlay);
    }
  }
  function displayLabel(value,fallback){const found=resolve(value);return found.length===1?(found[0].customerName||found[0].customerCode):fallback;}
  function showResult(result,kind='manual',{fit=false}={}){
    // A cancelled inactive controller must not erase the other controller's route.
    if(result?.state==='idle'&&lastKind!==kind&&['loading','success','partial'].includes(lastResult?.state))return;
    lastResult=result;lastKind=kind;renderRolePins();
    const metric=RoadRouteUi.metrics(result);$('#navDistance').textContent=metric.distance==='—'?'— km':metric.distance;$('#navDuration').textContent=metric.duration==='—'?'— 분':metric.duration;
    $('#navPartialTotals').hidden=result?.state!=='partial';
    routeTotals.hidden=metric.distance==='—'||metric.duration==='—';
    $('#navRouteStatus').textContent=!result||result.state==='idle'?'':MapDotUi.describeRoute(result);$('#navigationSummary').dataset.state=result?.state||'idle';
    const legs=$('#navLegs');legs.replaceChildren();if(!['success','partial'].includes(result?.state))return;
    const labels=result.routePoints?.length?result.routePoints.map(row=>row.customerName||row.customerCode):editor.values().map((value,index)=>displayLabel(value,index===0?'출발지':'방문지 '+index));
    const highlight=index=>kind==='recorded'?bridge.highlightRecordedLeg?.(index):bridge.highlightManualLeg(index);
    const allButton=document.createElement('button');allButton.type='button';allButton.textContent='전체 경로';allButton.setAttribute('aria-pressed','true');allButton.onclick=()=>{if($('#navRoadLines').checked)highlight();legs.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button===allButton)));};legs.append(allButton);
    if(fit&&bridge.state.map&&window.kakao?.maps?.LatLngBounds){const bounds=new kakao.maps.LatLngBounds();let any=false;for(const point of roleRows()){bounds.extend(new kakao.maps.LatLng(point.row.lat,point.row.lng));any=true;}if(any)bridge.fitNavigationBounds?.(bounds);}
    for(let i=0;i<result.totalLegs;i++){
      const value=result.legs?.find(leg=>leg.index===i),button=document.createElement('button');button.type='button';button.dataset.navLeg=i;
      const from=labels[i]||(i===0?'출발지':i+'번 방문'),to=labels[i+1]||((i+1)+'번 방문');
      const metrics=RoadRouteUi.metrics(value&&{...value,state:'success'});
      button.textContent=[from+' → '+to,value?.stationary?'같은 위치':value?metrics.distance+' · '+metrics.duration:'조회되지 않음'].join(' · ');
      button.setAttribute('aria-pressed','false');button.onclick=()=>{if($('#navRoadLines').checked)highlight(i);legs.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));};legs.append(button);
    }
    if(!$('#navRoadLines').checked)bridge.toggleRoadLines(false);
  }
  $('#navRoadLines').onchange=event=>bridge.toggleRoadLines(event.target.checked);
  const readinessReasons={
    FEATURE_DISABLED:'도로 경로 기능이 비활성화되어 있습니다.',
    KEY_MISSING:'도로 경로 제공자 인증 설정이 필요합니다.',
    PERSISTENT_BUDGET_REQUIRED:'승인된 호출 한도 저장소 설정이 필요합니다.',
    ROAD_BUDGET_UNVERIFIED:'승인된 호출 한도를 확인할 수 없습니다.',
    ROAD_BUDGET_API_UNVERIFIED:'이 경로 유형의 API 호출 승인을 확인해 주세요.',
    QUOTA_EXCEEDED:'승인된 도로 경로 호출 한도를 모두 사용했습니다.',
    STAFF_LOGIN_REQUIRED:'직원 로그인 후 경로 설정을 확인할 수 있습니다.'
  };
  function renderReadiness(){
    if(!readiness){readinessStatus.textContent=readinessController?'경로 조회 설정 확인 중…':'';return;}
    const points=roleRows().map(({row})=>row);
    const visited=points.filter((point,index)=>index===0||point.lat!==points[index-1].lat||point.lng!==points[index-1].lng);
    const api=visited.length>7?'waypoints':'directions',endpoint=readiness.apis?.[api]||readiness;
    const blocked=Array.isArray(endpoint.blockedReasons)?endpoint.blockedReasons:[];
    readinessStatus.textContent=endpoint.canRequest?'경로 조회 설정 확인됨':blocked.map(code=>readinessReasons[code]).filter(Boolean).join(' ')||'경로 조회 설정을 확인할 수 없습니다.';
  }
  async function loadReadiness(){
    if(!planner.open||readinessController||document.body.dataset.mapStaffState!=='authenticated')return;
    const controller=new AbortController();readinessController=controller;renderReadiness();
    try{
      const response=await fetch('/api/map-phase2b/private/road-route/config',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const body=await response.json();
      if(controller!==readinessController)return;
      readiness=response.ok&&body.ok===true&&body.data?body.data:{blockedReasons:response.status===401?['STAFF_LOGIN_REQUIRED']:[]};
    }catch{if(controller===readinessController)readiness={};}
    finally{if(controller===readinessController){readinessController=null;renderReadiness();}}
  }
  planner.addEventListener('toggle',()=>{if(planner.open)void loadReadiness();});
  const scopeControl=document.createElement('div');scopeControl.className='navRouteScopes';scopeControl.setAttribute('role','group');scopeControl.setAttribute('aria-label','경로 유형');
  scopeControl.innerHTML='<button type="button" data-route-scope="manual" aria-pressed="true">수동 경로</button><button type="button" data-route-scope="daily" aria-pressed="false">당일 운행</button>';
  dailyStatus.before(scopeControl);
  let scope='manual',dailyValues=null,dailyReady=false;
  scopeControl.addEventListener('click',event=>{if(event.target.dataset.routeScope)selectScope(event.target.dataset.routeScope);});
  function selectScope(next){
    if(scope===next)return;
    clearTimeout(recalculateTimer);
    if(scope==='manual')manualValues=editor.values();
    scope=next;
    editor.restore(scope==='manual'?manualValues:(dailyValues|| (dailyDefaults.length?dailyDefaults:['',''])));
    const active=bridge.setNavigationScope?.(scope);
    lastKind=active?.kind||'manual';autoRecalculate=lastKind==='manual'&&['success','partial'].includes(active?.result?.state);
    showResult(active?.result,lastKind);
    syncDraft();
  }
  function syncScope(){
    const next=bridge.state.mode;
    scopeControl.hidden=next!=='DATE_ROUTE';
    if(mode===next)return;
    mode=next;selectScope(next==='DATE_ROUTE'?'daily':'manual');
  }
  function applyDailyDraft(){
    if(scope!=='daily')return;
    clearTimeout(recalculateTimer);autoRecalculate=false;
    editor.restore(dailyDefaults.length?dailyDefaults:['','']);syncDraft();
  }
  async function syncDaily(){
    const identity=bridge.navigationDailyIdentity?.();
    const key=identity?JSON.stringify(identity):'';
    if(key===dailyIdentity)return;
    dailyIdentity=key;dailyController?.abort();dailyController=null;
    dailyDefaults=[];dailyStops=[];dailyValues=null;dailyReady=false;
    bridge.resetDailyNavigation?.();applyDailyDraft();
    if(!identity){dailyStatus.textContent='배송일과 호차 하나를 선택해 주세요.';return;}
    const controller=new AbortController();dailyController=controller;
    dailyStatus.textContent='저장된 배송 순서 확인 중…';
    try{
      const query=new URLSearchParams(identity);
      const response=await fetch('/api/map-phase2b/private/road-route/recorded-stops?'+query,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const body=await response.json();
      if(dailyController!==controller)return;
      const data=body.data,center=centers.find(row=>row.id==='osan');
      if(!response.ok||body.ok!==true||body.meta?.source!=='HUB_ROUTE_STOPS'||data?.date!==identity.date||data?.vehicle!==identity.vehicle)throw Error(body.error==='ORIGIN_UNCONFIRMED'?'오산센터의 등록 위치를 확인해 주세요.':'해당일의 저장된 배송 순서를 확인할 수 없습니다.');
      const origin=data.origin;
      if(origin&&(!lookup.located(center)||origin.customerCode!==center.customerCode||origin.lat!==center.lat||origin.lng!==center.lng))throw Error('오산센터의 등록 위치를 확인해 주세요.');
      if(!Array.isArray(data.stops)||!data.stops.length)throw Error('해당일에 확인된 배송지가 없습니다.');
      if(data.stops.length>31)throw Error('저장된 배송지가 31개를 초과합니다.');
      if(data.stops.some(row=>!row.customerCode||!Number.isSafeInteger(row.order)||row.order<1||row.vehicle!==identity.vehicle||!lookup.located(row))||new Set(data.stops.map(row=>row.order)).size!==data.stops.length)throw Error('해당일의 저장된 배송 순서를 확인할 수 없습니다.');
      // A visit identity includes the order when one store has several visits.
      const counts=new Map();for(const row of data.stops)counts.set(row.customerCode,(counts.get(row.customerCode)||0)+1);
      dailyStops=data.stops.toSorted((a,b)=>a.order-b.order).map(row=>counts.get(row.customerCode)>1?{...row,storeCode:row.customerCode,customerCode:'VISIT_'+row.order+'_'+row.customerCode}:row);
      dailyDefaults=[origin?.customerCode||'',...dailyStops.map(row=>row.customerCode)];
      dailyReady=true;
      if(!dailyValues)applyDailyDraft();
      dailyStatus.textContent=origin?'오산센터 출발 · 저장된 배송 순서 · 마지막 배송지 도착':'저장된 배송 순서를 적용했습니다. 출발지를 선택해 주세요.';
    }catch(error){if(dailyController===controller)dailyStatus.textContent=error instanceof TypeError||error instanceof SyntaxError?'해당일의 저장된 배송 순서를 확인할 수 없습니다.':error.message;}
    finally{if(dailyController===controller)dailyController=null;}
  }
  dailyStatus.textContent='배송일과 호차 하나를 선택해 주세요.';
  $('#queryRecordedRoute').textContent='저장된 배송 순서 복원';
  $('#queryRecordedRoute').onclick=()=>{
    if(!dailyReady)return;
    dailyValues=null;bridge.resetDailyNavigation?.();applyDailyDraft();planner.open=true;
  };
  function useRecordedRoute(){
    return scope==='daily'&&dailyReady&&dailyDefaults[0]==='CENTER_osan'&&JSON.stringify(editor.values())===JSON.stringify(dailyDefaults);
  }
  function syncDraft(){
    temporaryPlaces.retainSearchPoints([...manualValues,...(dailyValues||[]),...editor.values()]);
    hideSuggestions();describeInputs();roleSignature='';renderRolePins();renderReadiness();
    scopeControl.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.routeScope===scope)));
    dailyStatus.hidden=scope!=='daily';
    $('#queryRecordedRoute').hidden=scope!=='daily'||!dailyReady;
    if($('#syncOperation'))$('#syncOperation').hidden=scope!=='daily';
    window.MapDotUi?.arrangeNavigation?.();
  }
  function drawCenters(){
    const rows=lookup.registeredCenters(),map=bridge.state.map;
    const signature=JSON.stringify(rows.map(row=>[row.id,row.lat,row.lng,row.address,row.sourceVersion]));
    if(centerDraw?.map===map&&centerDraw.signature===signature)return;
    clearCenters();centers=rows;centerDraw={map,signature};
    centerChoices.hidden=!centers.length;
    if(centers.length){const label=document.createElement('span');label.textContent='센터에서 출발';centerChoices.append(label);}
    for(const center of centers){
      const button=document.createElement('button');button.type='button';button.textContent=center.customerName;button.onclick=()=>choosePoint('origin',center);centerChoices.append(button);
      if(map&&center.id!=='osan'){
        const label=document.createElement('button');label.type='button';label.className='centerMarker';label.textContent=center.customerName;
        label.onclick=()=>choosePoint('origin',center);
        const overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(center.lat,center.lng),content:label,zIndex:2});
        overlay.setMap(map);otherCenterMarkers.push(overlay);
      }
    }
    const center=centers.find(row=>row.id==='osan');
    if(!center||!map)return;

    const anchor=document.createElement('div');anchor.className='osanCenterAnchor';
    const button=document.createElement('button');button.type='button';button.className='centerMarker osanCenterMarker';
    button.setAttribute('aria-controls','osanCenterCard');button.setAttribute('aria-expanded','false');
    button.innerHTML='<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 12l10-6 10 6v11H4z M10 23v-8h8v8m-8-4h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span></span>';
    button.querySelector('span').textContent=center.customerName;anchor.append(button);
    const card=document.createElement('section');card.id='osanCenterCard';card.hidden=true;card.setAttribute('aria-label',center.customerName);
    card.innerHTML='<strong></strong><p></p><div><button type="button" data-center-origin>출발지로</button><button type="button" data-center-close>닫기</button></div><small role="status"></small>';
    card.querySelector('strong').textContent=center.customerName;
    const address=card.querySelector('p');address.textContent=center.address;address.hidden=!center.address;
    const feedback=card.querySelector('[role=status]');
    function placeCard(){
      if(card.hidden)return;
      const point=anchor.getBoundingClientRect(), bounds=$('#map').getBoundingClientRect(), size=card.getBoundingClientRect();
      const left=bounds.left+8+size.width/2, right=bounds.right-8-size.width/2;
      card.style.setProperty('--osan-card-shift',`${Math.max(left,Math.min(right,point.left))-point.left}px`);
      card.dataset.side=point.top-bounds.top<size.height+button.offsetHeight+10?'below':'above';
    }
    function syncCenterSize(){
      const level=map.getLevel?.() ?? 7;
      anchor.style.setProperty('--osan-icon-size',`${Math.max(15,Math.min(23,27-level))}px`);
      placeCard();
    }
    button.onclick=event=>{
      event.stopPropagation();
      const open=card.hidden;card.hidden=!open;button.setAttribute('aria-expanded',String(open));
      if(open){feedback.textContent='';placeCard();}
    };
    card.querySelector('[data-center-close]').onclick=()=>closeCenterCard(true);
    card.querySelector('[data-center-origin]').onclick=()=>{
      autoRecalculate=false;
      if(choosePoint('origin',center))feedback.textContent='출발지로 지정했습니다.';
    };
    card.onkeydown=button.onkeydown=event=>{if(event.key==='Escape')closeCenterCard(true);};
    anchor.append(card);
    const overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(center.lat,center.lng),content:anchor,clickable:true,xAnchor:0,yAnchor:0,zIndex:42});
    overlay.setMap(map);syncCenterSize();
    kakao.maps.event?.addListener(map,'zoom_changed',syncCenterSize);
    kakao.maps.event?.addListener(map,'idle',placeCard);
    centerMarker={button,card,overlay,dispose(){
      kakao.maps.event?.removeListener(map,'zoom_changed',syncCenterSize);
      kakao.maps.event?.removeListener(map,'idle',placeCard);
      overlay.setMap(null);
    }};
  }
  function closeCenterCard(restoreFocus=false){
    if(!centerMarker||centerMarker.card.hidden)return;
    centerMarker.card.hidden=true;centerMarker.button.setAttribute('aria-expanded','false');
    if(restoreFocus)centerMarker.button.focus();
  }
  function clearCenters(){
    centerMarker?.dispose();centerMarker=null;
    otherCenterMarkers.forEach(overlay=>overlay.setMap(null));otherCenterMarkers=[];
    centers=[];centerDraw=null;centerChoices.replaceChildren();centerChoices.hidden=true;
  }
  function syncMissing(){
    const vehicles=bridge.state.selectedVehicles,rows=lookup.unique(bridge.state.mode==='DATE_ROUTE'?bridge.navigationStores():bridge.stores()).filter(row=>(!vehicles.length||vehicles.includes(String(row.vehicle)))&&!lookup.located(row));
    const signature=JSON.stringify(rows.map(row=>[row.customerCode,row.customerName,row.coordinateStatus]));if(signature===missingSignature)return;missingSignature=signature;
    missing.hidden=!rows.length;missing.querySelector('summary').textContent='위치 확인 필요 '+rows.length+'개 매장';const list=missing.querySelector('div');list.replaceChildren();
    function appendPage(start){
      for(const row of rows.slice(start,start+50)){const button=document.createElement('button');button.type='button';button.textContent=row.customerName+' · '+row.customerCode;button.onclick=()=>bridge.selectNavigationStore(row.customerCode);list.append(button);}
      if(start+50<rows.length){const more=document.createElement('button');more.type='button';more.textContent='더 보기';more.onclick=()=>{more.remove();appendPage(start+50);};list.append(more);}
    }
    appendPage(0);
  }
  function sync(){
    if(disposed)return;const daily=bridge.state.mode==='DATE_ROUTE';workspace.hidden=!daily;
    if(!window.MapDotUi?.arrangeNavigation?.()){
      if(daily){if(planner.parentNode!==workspace)workspace.insertBefore(planner,missing);if(routeList.parentNode!==workspace)workspace.prepend(routeList);planner.hidden=false;routeList.hidden=false;}
      else{if(planner.parentNode!==plannerAnchor.parentNode)plannerAnchor.after(planner);if(routeList.parentNode!==routeAnchor.parentNode)routeAnchor.after(routeList);planner.hidden=true;}
    }
    syncScope();if(document.body.dataset.mapStaffState==='authenticated')void syncDaily();syncMissing();describeInputs();renderRolePins();refreshPointActions();bridge.relayoutPreservingView?.();
  }
  const onManual=event=>{if(event.detail?.state==='loading')clearTimeout(recalculateTimer);if(['success','partial'].includes(event.detail?.state))autoRecalculate=true;else if(['error','disabled'].includes(event.detail?.state))autoRecalculate=false;showResult(event.detail,'manual',{fit:true});},onRecorded=event=>{if(scope==='daily')showResult(event.detail,'recorded',{fit:true});},onSelected=()=>{closeCenterCard();refreshPointActions();},onReady=()=>{roleSignature='';drawCenters();sync();void loadReadiness();};
  const onDraft=()=>{
    clearTimeout(recalculateTimer);
    const values=editor.values();if(scope==='daily')dailyValues=values;else manualValues=values;
    syncDraft();if(values.every(value=>!String(value||'').trim()))autoRecalculate=false;
    // Only a route explicitly queried successfully enables recalculation.
    // Incomplete text, initial load and provider errors never cause API calls.
    if(autoRecalculate&&values.length>=2&&roleRows().length===values.length)recalculateTimer=setTimeout(()=>{if(!disposed&&autoRecalculate&&roleRows().length===editor.values().length)$('#planRoute').click();},450);
  };
  const onContext=()=>{closeCenterCard();hideSuggestions();queueMicrotask(sync);};
  const onLogout=()=>{
    clearCenters();clearTimeout(recalculateTimer);autoRecalculate=false;readinessController?.abort();readinessController=null;readiness=null;
    dailyController?.abort();dailyController=null;dailyIdentity='';dailyDefaults=[];dailyStops=[];dailyReady=false;dailyValues=null;
    temporaryPlaces.clear();explicitStores.clear();manualValues=['',''];editor.restore(manualValues);showResult({state:'idle'},lastKind);syncDraft();
  };
  const onStaffReady=()=>{void window.KakaoMapsAdapter?.ready().then(()=>{
    if(!disposed&&document.body.dataset.mapStaffState==='authenticated')onReady();
  }).catch(()=>{});};
  const events=[['map-manual-route',onManual],['map-recorded-route',onRecorded],['map-store-selected',onSelected],['map-sdk-ready',onReady],['map-staff-ready',onStaffReady],['map-navigation-logout',onLogout],['map-navigation-context-changed',onContext],['map-navigation-draft',onDraft],['map-coordinate-updated',sync]];
  events.forEach(([name,listener])=>window.addEventListener(name,listener));
  const observer=new MutationObserver(sync);if($('#modeDaily'))observer.observe($('#modeDaily'),{attributes:true,attributeFilter:['aria-pressed']});if($('#runList'))observer.observe($('#runList'),{childList:true});
  window.addEventListener('pagehide',event=>{if(event.persisted)return;disposed=true;dailyController?.abort();readinessController?.abort();cancelAddressSearch();clearTimeout(suggestTimer);clearTimeout(recalculateTimer);observer.disconnect();events.forEach(([name,listener])=>window.removeEventListener(name,listener));document.removeEventListener('pointerdown',outsidePointer);$('#detail').removeEventListener('click',onPointClick);clearCenters();routePointOverlays.forEach(overlay=>overlay.setMap(null));routePointOverlays=[];},{once:true});
  window.MapNavigation=Object.freeze({resolve,search:value=>lookup.search(value,all()),sync,useRecordedRoute,scope:()=>scope,metrics:()=>({centerOverlays:otherCenterMarkers.length+Number(Boolean(centerMarker)),osanCenterOverlays:Number(Boolean(centerMarker)),routePointOverlays:routePointOverlays.length,routePointCount:roleRows().length,temporaryPointCount:temporaryPlaces.values().length,routeState:lastResult?.state||'idle'})});
  drawCenters();syncDraft();sync();void loadReadiness();
})();
