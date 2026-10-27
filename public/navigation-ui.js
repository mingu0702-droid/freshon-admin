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
      clear(){rows.clear();}
    };
  }
  root.MapNavigationLookup=Object.freeze({normalize,located,unique,resolve,search,visitCodes,createTemporaryPlaces});
})(typeof window==='object'?window:globalThis);

(()=>{
  'use strict';
  if(typeof document!=='object')return;
  const $=selector=>document.querySelector(selector),bridge=window.MapUiLocalBridge,editor=window.MapNavigationEditor,lookup=window.MapNavigationLookup;
  const planner=$('#waypointPlanner'),routeList=$('#runListTool');
  if(!bridge||!editor||!planner||!routeList)return;
  const plannerAnchor=document.createComment('navigation-planner-home'),routeAnchor=document.createComment('navigation-list-home');
  planner.before(plannerAnchor);routeList.before(routeAnchor);
  const workspace=document.createElement('section');workspace.id='navigationWorkspace';workspace.className='navigationWorkspace';workspace.hidden=true;
  workspace.innerHTML='<section id="navigationSummary" aria-label="길찾기 결과"><div class="sectiontitle"><h2>길찾기</h2><span id="navigationMeaning">자동차</span></div><div class="navTotals"><b id="navDistance">— km</b><b id="navDuration">— 분</b></div><p id="navRouteStatus" role="status">출발지와 목적지를 선택해 주세요.</p><div class="navToggles"><label><input id="navRoadLines" type="checkbox" checked>경로선 표시</label><input id="navConnections" type="checkbox" hidden disabled></div><button id="queryRecordedRoute" type="button">방문 목록 적용</button><div id="navLegs" aria-label="구간별 거리와 시간"></div></section>';
  $('.scrollside').append(workspace);
  if($('#syncOperation'))$('#navigationSummary').append($('#syncOperation'));
  const picker=document.createElement('section');picker.className='navigationPicker';picker.setAttribute('aria-label','지도에서 선택한 매장');
  picker.innerHTML='<div class="navSelectedHeading">지도에서 선택한 매장</div><p id="navSelectedStore" role="status">매장을 선택하면 경로에 추가할 수 있습니다.</p><div class="navPickActions"><button type="button" data-nav-pick="origin">출발지로</button><button type="button" data-nav-pick="waypoint">경유지로</button><button type="button" data-nav-pick="destination">목적지로</button></div><p id="navPointStatus" role="status"></p>';
  planner.querySelector('.plannerHelp').after(picker);
  const centerChoices=document.createElement('div');centerChoices.className='navCenterChoices';centerChoices.setAttribute('aria-label','센터에서 출발');picker.before(centerChoices);
  const suggestions=document.createElement('div');suggestions.id='navSearchResults';suggestions.className='navSearchResults';suggestions.hidden=true;suggestions.setAttribute('role','listbox');suggestions.setAttribute('aria-label','매장 검색 결과');
  const missing=document.createElement('details');missing.id='navMissingStores';missing.innerHTML='<summary>위치 확인이 필요한 매장</summary><div></div>';workspace.append(missing);
  const centerNames={osan:'오산센터',yeongnam:'영남센터',honam:'호남센터'};
  const temporaryPlaces=lookup.createTemporaryPlaces();
  let addressSearchController=null,addressSearchGeneration=0;
  let centers=[],centerOverlays=[],routePointOverlays=[],lastResult=null,lastKind='manual',disposed=false,selectedCandidate=null,activeInput=null,roleSignature='',missingSignature='',suggestTimer=null,suggestionIndex=-1;
  function centerRows(){return (window.KAKAO_MAP_CONFIG?.centers||[]).filter(row=>centerNames[row.id]&&row.verified===true&&typeof row.sourceVersion==='string'&&row.sourceVersion&&lookup.located(row)).map(row=>({...row,customerCode:'CENTER_'+row.id,customerName:centerNames[row.id],address:row.address||'',coordinateStatus:'VERIFIED'}));}
  function all(){return lookup.unique([...bridge.navigationStores(),...centers,...temporaryPlaces.values()]);}
  const resolve=value=>lookup.resolve(value,all());
  const status=text=>{$('#navPointStatus').textContent=text;};
  function updateSelected(candidate=bridge.state.selected){
    candidate=temporaryPlaces.add(candidate);selectedCandidate=candidate||null;
    const target=$('#navSelectedStore');target.replaceChildren();
    if(!candidate)target.textContent='매장을 선택하면 경로에 추가할 수 있습니다.';
    else {
      const name=document.createElement('strong');name.textContent=candidate.customerName||candidate.address||candidate.customerCode;
      const meta=document.createElement('small');meta.textContent=[candidate.virtual?'임시 위치':candidate.customerCode,candidate.address,!lookup.located(candidate)?'위치 확인 필요':''].filter(Boolean).join(' · ');target.append(name,meta);
    }
    picker.querySelectorAll('[data-nav-pick]').forEach(button=>button.disabled=!candidate||!lookup.located(candidate));
  }
  function choosePoint(role,row,index){
    row=temporaryPlaces.add(row);
    if(!lookup.located(row)){status('이 매장은 위치를 확인한 뒤 추가해 주세요.');return false;}
    try {
      editor.setPoint(role,row.customerCode,index);
      const roleName=role==='origin'?'출발지':role==='destination'?'목적지':'경유지';
      status(row.customerName+' · '+roleName+'로 지정했습니다.');
      hideSuggestions();planner.open=true;
      return true;
    }catch(error){status(error.message);return false;}
  }
  picker.querySelectorAll('[data-nav-pick]').forEach(button=>button.onclick=()=>{if(selectedCandidate)choosePoint(button.dataset.navPick,selectedCandidate);});
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
    const values=editor.values();return values.flatMap((value,index)=>{
      const matches=resolve(value);if(matches.length!==1||!lookup.located(matches[0]))return [];
      return [{row:matches[0],index,role:index===0?'origin':index===values.length-1?'destination':'waypoint',label:index===0?'출발':index===values.length-1?'도착':'경유 '+index}];
    });
  }
  function renderRolePins(){
    const roles=roleRows(),signature=JSON.stringify([bridge.state.mode,roles.map(item=>[item.row.customerCode,item.row.customerName,item.row.lat,item.row.lng,item.role,item.index])]);
    if(!bridge.state.map||signature===roleSignature)return;roleSignature=signature;
    routePointOverlays.forEach(overlay=>overlay.setMap(null));routePointOverlays=[];
    const assigned=new Set(roles.map(item=>item.row.customerCode));
    document.querySelectorAll('.marker[data-customer-code]').forEach(node=>node.classList.toggle('navAssigned',bridge.state.mode==='DATE_ROUTE'&&assigned.has(node.dataset.customerCode)));
    if(bridge.state.mode!=='DATE_ROUTE')return;
    const groups=new Map();for(const item of roles){const key=item.row.lat+','+item.row.lng;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
    for(const items of groups.values()){
      const group=document.createElement('div');group.className='navRoutePointGroup';
      for(const item of items){
        const label=document.createElement('button');label.type='button';label.className='navRoutePoint';label.dataset.role=item.role;label.dataset.customerCode=item.row.customerCode;label.textContent=item.label;
        const name=document.createElement('small');name.textContent=item.row.customerName||item.row.customerCode;label.append(name);label.setAttribute('aria-label',item.label+' · '+name.textContent);
        label.onclick=event=>{event.stopPropagation();updateSelected(item.row);if(!item.row.customerCode.startsWith('CENTER_')&&!item.row.virtual)bridge.selectNavigationStore(item.row.customerCode);};group.append(label);
      }
      const first=items[0].row,overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(first.lat,first.lng),content:group,zIndex:30,yAnchor:1.15});overlay.setMap(bridge.state.map);routePointOverlays.push(overlay);
    }
  }
  function displayLabel(value,fallback){const found=resolve(value);return found.length===1?(found[0].customerName||found[0].customerCode):fallback;}
  function showResult(result,kind='manual'){
    // A cancelled inactive controller must not erase the other controller's route.
    if(result?.state==='idle'&&lastKind!==kind&&['loading','success','partial'].includes(lastResult?.state))return;
    lastResult=result;lastKind=kind;renderRolePins();
    const metric=RoadRouteUi.metrics(result);$('#navDistance').textContent=metric.distance==='—'?'— km':metric.distance;$('#navDuration').textContent=metric.duration==='—'?'— 분':metric.duration;
    $('#navRouteStatus').textContent=result?.noDrivingRequired?'방문지가 같은 위치에 있습니다. 이동 거리는 0 km입니다.':MapDotUi.describeRoute(result);$('#navigationSummary').dataset.state=result?.state||'idle';
    const legs=$('#navLegs');legs.replaceChildren();if(!['success','partial'].includes(result?.state))return;
    const labels=kind==='manual'?editor.values().map((value,index)=>displayLabel(value,index===0?'출발지':'방문지 '+index)):(result.routePoints||[]).map(row=>row.customerName||row.customerCode);
    const highlight=index=>kind==='recorded'?bridge.highlightRecordedLeg?.(index):bridge.highlightManualLeg(index);
    const allButton=document.createElement('button');allButton.type='button';allButton.textContent='전체 경로';allButton.setAttribute('aria-pressed','true');allButton.onclick=()=>{if($('#navRoadLines').checked)highlight();legs.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button===allButton)));};legs.append(allButton);
    if(kind==='manual'&&bridge.state.map){const bounds=new kakao.maps.LatLngBounds();let any=false;for(const point of roleRows()){bounds.extend(new kakao.maps.LatLng(point.row.lat,point.row.lng));any=true;}if(any)bridge.fitNavigationBounds?.(bounds);}
    for(let i=0;i<result.totalLegs;i++){
      const value=result.legs?.find(leg=>leg.index===i),button=document.createElement('button');button.type='button';button.dataset.navLeg=i;
      const from=labels[i]||(i===0?'출발지':i+'번 방문'),to=labels[i+1]||((i+1)+'번 방문');
      button.textContent=`${from} → ${to} · ${value?.stationary?'같은 위치':value?(value.distanceMeters/1000).toFixed(1)+' km · '+Math.ceil(value.durationSeconds/60)+'분':'조회되지 않음'}`;
      button.setAttribute('aria-pressed','false');button.onclick=()=>{if($('#navRoadLines').checked)highlight(i);legs.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));};legs.append(button);
    }
    if(!$('#navRoadLines').checked)bridge.toggleRoadLines(false);
  }
  $('#navRoadLines').onchange=event=>bridge.toggleRoadLines(event.target.checked);
  $('#queryRecordedRoute').onclick=()=>{
    hideSuggestions();
    try{
      const codes=lookup.visitCodes(bridge.navigationVisitRows?.(),all());
      if(typeof editor.replacePoints!=='function')throw Error('경로 설정을 새로고침한 뒤 다시 시도해 주세요.');
      editor.replacePoints(codes);planner.open=true;
      status('방문 목록 순서로 '+codes.length+'개 지점을 적용했습니다. 확인 후 경로를 조회해 주세요.');
      planner.scrollIntoView({block:'nearest'});
    }catch(error){status(error.message);planner.open=true;}
  };
  function drawCenters(){
    centerOverlays.forEach(overlay=>overlay.setMap(null));centerOverlays=[];centers=centerRows();centerChoices.replaceChildren();centerChoices.hidden=!centers.length;
    if(centers.length){const label=document.createElement('span');label.textContent='센터에서 출발';centerChoices.append(label);}
    for(const center of centers){
      const button=document.createElement('button');button.type='button';button.textContent=center.customerName;button.onclick=()=>choosePoint('origin',center);centerChoices.append(button);
      if(bridge.state.map){const label=document.createElement('button');label.type='button';label.className='centerMarker';label.textContent=center.customerName;label.onclick=()=>{updateSelected(center);if(bridge.state.mode==='DATE_ROUTE')planner.open=true;};const overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(center.lat,center.lng),content:label,zIndex:2});overlay.setMap(bridge.state.map);centerOverlays.push(overlay);}
    }
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
    syncMissing();describeInputs();renderRolePins();bridge.relayoutPreservingView?.();
  }
  const onManual=event=>showResult(event.detail,'manual'),onRecorded=event=>showResult(event.detail,'recorded'),onSelected=()=>updateSelected(),onReady=()=>{roleSignature='';drawCenters();sync();};
  const onDraft=()=>{status('');roleSignature='';hideSuggestions();describeInputs();renderRolePins();window.MapDotUi?.arrangeNavigation?.();};
  const onContext=()=>{hideSuggestions();temporaryPlaces.clear();editor.clear();selectedCandidate=null;updateSelected(null);lastResult=null;lastKind='manual';showResult({state:'idle'});roleSignature='';sync();};
  const events=[['map-manual-route',onManual],['map-recorded-route',onRecorded],['map-store-selected',onSelected],['map-sdk-ready',onReady],['map-navigation-logout',onContext],['map-navigation-context-changed',onContext],['map-navigation-draft',onDraft],['map-coordinate-updated',sync]];
  events.forEach(([name,listener])=>window.addEventListener(name,listener));
  const observer=new MutationObserver(sync);if($('#modeDaily'))observer.observe($('#modeDaily'),{attributes:true,attributeFilter:['aria-pressed']});if($('#runList'))observer.observe($('#runList'),{childList:true});
  window.addEventListener('pagehide',event=>{if(event.persisted)return;disposed=true;cancelAddressSearch();clearTimeout(suggestTimer);observer.disconnect();events.forEach(([name,listener])=>window.removeEventListener(name,listener));document.removeEventListener('pointerdown',outsidePointer);[...centerOverlays,...routePointOverlays].forEach(overlay=>overlay.setMap(null));centerOverlays=[];routePointOverlays=[];},{once:true});
  window.MapNavigation=Object.freeze({resolve,search:value=>lookup.search(value,all()),sync,metrics:()=>({centerOverlays:centerOverlays.length,routePointOverlays:routePointOverlays.length,routePointCount:roleRows().length,temporaryPointCount:temporaryPlaces.values().length,routeState:lastResult?.state||'idle'})});
  drawCenters();updateSelected();sync();
})();
