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
  function recordedVisitCodes(rows,currentRows,vehicle,origin){
    if(!vehicle||!Array.isArray(rows)||rows.some(row=>!Number.isSafeInteger(row?.order)||row.order<1||String(row.vehicle||'')!==String(vehicle))||new Set(rows.map(row=>row.order)).size!==rows.length)throw Error('선택한 호차의 저장된 방문 순서를 확인해 주세요.');
    const ordered=[...rows].sort((a,b)=>a.order-b.order);
    if(origin){if(!origin.customerCode||!located(origin))throw Error('출발지의 위치를 확인해 주세요.');ordered.unshift(origin);}
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
  root.MapNavigationLookup=Object.freeze({normalize,located,unique,resolve,search,visitCodes,recordedVisitCodes,createTemporaryPlaces,kakaoDestinationLink,kakaoRouteLinks,kakaoLegLinks});
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
  workspace.innerHTML='<section id="navigationSummary" aria-label="길찾기 결과"><div class="sectiontitle"><h2>길찾기</h2><span id="navigationMeaning">자동차</span></div><p id="navRouteStatus" role="status">출발지와 목적지를 선택해 주세요.</p><div class="navToggles"><label><input id="navRoadLines" type="checkbox" checked>경로선 표시</label><input id="navConnections" type="checkbox" hidden disabled></div><button id="queryRecordedRoute" type="button">방문 목록 적용</button><div id="navLegs" aria-label="구간별 거리와 시간"></div></section>';
  $('.scrollside').append(workspace);
  const routeTotals=document.createElement('div');routeTotals.id='mapRouteTotals';routeTotals.hidden=true;
  routeTotals.setAttribute('role','status');
  routeTotals.innerHTML='<span id="navPartialTotals" hidden>일부 구간</span><span>주행거리 <b id="navDistance">— km</b></span><span>예상 소요시간 <b id="navDuration">— 분</b></span>';
  mapArea.append(routeTotals);
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
  let recalculateTimer=null,autoRecalculate=false;
  let centers=[],centerOverlays=[],routePointOverlays=[],lastResult=null,lastKind='manual',disposed=false,selectedCandidate=null,activeInput=null,roleSignature='',missingSignature='',suggestTimer=null,suggestionIndex=-1;
  let centerDraw=null,centerCard=null,rolePinMap=null,rolePinFrame=null;
  let recordedRead=null,automaticOrigin=false,originVersion=0,lastOrigin='';
  function centerRows(){return (window.KAKAO_MAP_CONFIG?.centers||[]).filter(row=>centerNames[row.id]&&row.verified===true&&typeof row.sourceVersion==='string'&&row.sourceVersion&&lookup.located(row)).map(row=>({...row,customerCode:'CENTER_'+row.id,customerName:centerNames[row.id],address:row.address||'',coordinateStatus:'VERIFIED'}));}
  function all(){return lookup.unique([...bridge.navigationStores(),...centers,...temporaryPlaces.values()]);}
  const resolve=value=>lookup.resolve(value,all());
  const status=text=>{$('#navPointStatus').textContent=text;};
  function updateSelected(candidate=bridge.state.selected||bridge.state.virtual){
    // A search preview is not a saved route stop. Drop it when selection changes,
    // while retaining temporary points explicitly assigned to the route.
    temporaryPlaces.retainSearchPoints(editor.values());
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
      if(role==='origin')automaticOrigin=false;
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
    const values=editor.values();if(!values.some(value=>String(value||'').trim()))return [];
    const rows=all(),byCode=new Map(rows.map(row=>[lookup.normalize(row.customerCode),row]));
    return values.flatMap((value,index)=>{
      if(!String(value||'').trim())return [];
      const exact=byCode.get(lookup.normalize(value)),matches=exact?[exact]:lookup.resolve(value,rows);
      if(matches.length!==1||!lookup.located(matches[0]))return [];
      return [{row:matches[0],index,role:index===0?'origin':index===values.length-1?'destination':'waypoint',label:index===0?'출발':index===values.length-1?'도착':'경유'+index}];
    });
  }
  function positionRolePins(){
    rolePinFrame=null;
    const projection=rolePinMap?.getProjection?.(),mapNode=$('#map');
    if(!projection?.containerPointFromCoords||!mapNode)return;
    const mapRect=mapNode.getBoundingClientRect();
    for(const {group,position,items} of routePointOverlays){
      const point=projection.containerPointFromCoords(position);
      if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y))continue;
      const x=mapRect.left+point.x,y=mapRect.top+point.y;
      const tops=items.flatMap(({row})=>{
        const code=CSS.escape(String(row.customerCode));
        const marker=mapNode.querySelector(`[data-center-code="${code}"],.marker[data-customer-code="${code}"]:not(.periodCluster)`)||
          (row.searchTemporary?mapNode.querySelector('[data-search-temporary-pin]'):null);
        if(!marker)return [];
        const graphic=(marker.querySelector('.pin,.pinShape')||marker).getBoundingClientRect();
        return graphic.width&&Math.abs((graphic.left+graphic.right)/2-x)<32&&Math.abs(graphic.bottom-y)<35?[graphic.top]:[];
      });
      const width=Math.max(0,mapRect.width-12);
      group.style.maxWidth=`${Math.min(245,width)}px`;
      const half=group.offsetWidth/2+6;
      const shift=point.x>=0&&point.x<=mapRect.width?Math.max(half,Math.min(mapRect.width-half,point.x))-point.x:0;
      group.style.setProperty('--nav-badge-shift',`${shift}px`);
      if(tops.length)group.style.setProperty('--nav-badge-offset',`${y-Math.min(...tops)+5}px`);
      else group.style.removeProperty('--nav-badge-offset');
    }
  }
  function scheduleRolePins(){if(routePointOverlays.length&&rolePinFrame===null)rolePinFrame=requestAnimationFrame(positionRolePins);}
  function clearRolePins(){
    if(rolePinFrame!==null)cancelAnimationFrame(rolePinFrame);rolePinFrame=null;
    routePointOverlays.forEach(({overlay})=>overlay.setMap(null));routePointOverlays=[];
  }
  function renderRolePins(){
    const map=bridge.state.map;if(!map)return;
    const roles=roleRows(),signature=JSON.stringify(roles.map(item=>[item.row.customerCode,item.row.customerName,item.row.lat,item.row.lng,item.role,item.index]));
    if(rolePinMap===map&&signature===roleSignature){scheduleRolePins();return;}
    if(rolePinMap!==map){
      if(rolePinMap)kakao.maps.event?.removeListener(rolePinMap,'idle',scheduleRolePins);
      rolePinMap=map;kakao.maps.event?.addListener(map,'idle',scheduleRolePins);
    }
    roleSignature=signature;clearRolePins();
    const groups=new Map();for(const item of roles){const key=item.row.lat+','+item.row.lng;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
    for(const items of groups.values()){
      const anchor=document.createElement('div');anchor.className='navRoutePointAnchor';
      const group=document.createElement('div');group.className='navRoutePointGroup';
      for(const item of items){
        const label=document.createElement('button');label.type='button';label.className='navRoutePoint';label.dataset.role=item.role;label.dataset.customerCode=item.row.customerCode;label.textContent=item.label;
        label.title=item.row.customerName||item.row.customerCode;label.setAttribute('aria-label',item.label+' · '+label.title);
        label.onclick=event=>{event.stopPropagation();updateSelected(item.row);if(!item.row.customerCode.startsWith('CENTER_')&&!item.row.virtual)bridge.selectNavigationStore(item.row.customerCode);};group.append(label);
      }
      anchor.append(group);
      const first=items[0].row,position=new kakao.maps.LatLng(first.lat,first.lng);
      const overlay=new kakao.maps.CustomOverlay({position,content:anchor,clickable:true,xAnchor:0,yAnchor:0,zIndex:30});
      overlay.setMap(map);routePointOverlays.push({overlay,group,position,items});
    }
    scheduleRolePins();
  }
  function displayLabel(value,fallback){const found=resolve(value);return found.length===1?(found[0].customerName||found[0].customerCode):fallback;}
  function showResult(result,kind='manual'){
    // A cancelled inactive controller must not erase the other controller's route.
    if(result?.state==='idle'&&lastKind!==kind&&['loading','success','partial'].includes(lastResult?.state))return;
    lastResult=result;lastKind=kind;renderRolePins();
    const metric=RoadRouteUi.metrics(result);$('#navDistance').textContent=metric.distance==='—'?'— km':metric.distance;$('#navDuration').textContent=metric.duration==='—'?'— 분':metric.duration;
    $('#navPartialTotals').hidden=result?.state!=='partial';
    routeTotals.hidden=metric.distance==='—'||metric.duration==='—';
    $('#navRouteStatus').textContent=['success','partial'].includes(result?.state)&&result?.noDrivingRequired?'방문지가 같은 위치에 있습니다.':MapDotUi.describeRoute(result);$('#navigationSummary').dataset.state=result?.state||'idle';
    const legs=$('#navLegs');legs.replaceChildren();if(!['success','partial'].includes(result?.state))return;
    const labels=kind==='manual'?editor.values().map((value,index)=>displayLabel(value,index===0?'출발지':'방문지 '+index)):(result.routePoints||[]).map(row=>row.customerName||row.customerCode);
    const highlight=index=>kind==='recorded'?bridge.highlightRecordedLeg?.(index):bridge.highlightManualLeg(index);
    const allButton=document.createElement('button');allButton.type='button';allButton.textContent='전체 경로';allButton.setAttribute('aria-pressed','true');allButton.onclick=()=>{if($('#navRoadLines').checked)highlight();legs.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button===allButton)));};legs.append(allButton);
    if(kind==='manual'&&bridge.state.map){const bounds=new kakao.maps.LatLngBounds();let any=false;for(const point of roleRows()){bounds.extend(new kakao.maps.LatLng(point.row.lat,point.row.lng));any=true;}if(any)bridge.fitNavigationBounds?.(bounds);}
    for(let i=0;i<result.totalLegs;i++){
      const value=result.legs?.find(leg=>leg.index===i),button=document.createElement('button');button.type='button';button.dataset.navLeg=i;
      const from=labels[i]||(i===0?'출발지':i+'번 방문'),to=labels[i+1]||((i+1)+'번 방문');
      button.textContent=`${from} → ${to}${value?.stationary?' · 같은 위치':value?'':' · 조회되지 않음'}`;
      button.setAttribute('aria-pressed','false');button.onclick=()=>{if($('#navRoadLines').checked)highlight(i);legs.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));};legs.append(button);
    }
    if(!$('#navRoadLines').checked)bridge.toggleRoadLines(false);
  }
  $('#navRoadLines').onchange=event=>bridge.toggleRoadLines(event.target.checked);
  const recordedButton=$('#queryRecordedRoute');
  const dailyIdentity=()=>bridge.state.mode==='DATE_ROUTE'?bridge.navigationDailyIdentity?.():null;
  const recordedKey=identity=>identity?JSON.stringify([identity.date,identity.vehicle]):'';
  function cancelRecordedRead(){recordedRead?.controller.abort();recordedRead=null;}
  function syncRecordedStops({retry=false}={}){
    const identity=dailyIdentity(),key=recordedKey(identity);
    recordedButton.hidden=bridge.state.mode!=='DATE_ROUTE';recordedButton.disabled=!identity;
    if(recordedRead&&recordedRead.key!==key){
      cancelRecordedRead();autoRecalculate=false;clearTimeout(recalculateTimer);
      if(automaticOrigin&&editor.values()[0]==='CENTER_osan')editor.removePoint('origin');
      automaticOrigin=false;
    }
    if(!identity||!centers.some(row=>row.id==='osan')&&!retry)return recordedRead;
    if(recordedRead&&(!retry||!recordedRead.error))return recordedRead;
    cancelRecordedRead();
    const controller=new AbortController(),read={key,controller,error:'',originVersion};
    recordedRead=read;
    const timer=setTimeout(()=>controller.abort(),17000);
    read.promise=(async()=>{
      const response=await fetch('/api/map-phase2b/private/road-route/recorded-stops?'+new URLSearchParams(identity),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error(response.status===401?'직원 로그인이 필요합니다.':'해당 배송일의 저장된 방문 순서를 확인할 수 없습니다.');
      const payload=await response.json(),data=payload?.data;
      if(recordedRead!==read||recordedKey(dailyIdentity())!==key)return null;
      if(payload?.ok!==true||payload.meta?.source!=='HUB_ROUTE_STOPS'||data?.date!==identity.date||String(data.vehicle)!==String(identity.vehicle)||!Array.isArray(data.stops))throw Error('선택한 배송일과 호차의 방문 자료를 확인할 수 없습니다.');
      const center=centers.find(row=>row.id==='osan');
      if(center&&data.origin?.customerCode===center.customerCode&&data.origin.lat===center.lat&&data.origin.lng===center.lng&&editor.values()[0]===''&&read.originVersion===originVersion){
        autoRecalculate=false;clearTimeout(recalculateTimer);
        if(editor.setPoint('origin',center.customerCode))automaticOrigin=true;
      }
      return data;
    })().catch(error=>{
      read.error=error.name==='AbortError'||error instanceof TypeError||error instanceof SyntaxError?'해당 배송일의 저장된 방문 순서를 확인할 수 없습니다.':error.message;
      return null;
    }).finally(()=>clearTimeout(timer));
    return read;
  }
  recordedButton.onclick=async()=>{
    hideSuggestions();
    try{
      const identity=dailyIdentity();
      if(!identity)throw Error('배송일과 방문 순서를 가져올 호차 하나를 선택해 주세요.');
      const read=syncRecordedStops({retry:true});
      status('저장된 배송 순서를 확인하고 있습니다.');
      const data=await read.promise;
      if(recordedRead!==read||recordedKey(dailyIdentity())!==read.key)return;
      if(!data)throw Error(read.error||'해당 배송일의 저장된 방문 순서를 확인할 수 없습니다.');
      if(!data.sourceStopCount)throw Error('선택한 배송일에 이 호차의 방문 매장이 없습니다.');
      if(data.orderVerified!==true||data.stops.length!==data.sourceStopCount)throw Error('저장된 착순을 확인할 수 없습니다. 방문지를 직접 지정해 주세요.');
      const origins=resolve(editor.values()[0]);
      if(origins.length!==1||!lookup.located(origins[0]))throw Error('방문 목록을 적용하기 전에 출발지를 선택해 주세요.');
      const codes=lookup.recordedVisitCodes(data.stops,all(),identity.vehicle,origins[0]);
      if(typeof editor.replacePoints!=='function')throw Error('경로 설정을 새로고침한 뒤 다시 시도해 주세요.');
      editor.replacePoints(codes);planner.open=true;
      status('방문 목록 순서로 '+codes.length+'개 지점을 적용했습니다. 확인 후 경로를 조회해 주세요.');
      planner.scrollIntoView({block:'nearest'});
    }catch(error){status(error.message);planner.open=true;}
  };
  function closeCenterCard(restoreFocus=false){
    if(!centerCard||centerCard.card.hidden)return;
    centerCard.card.hidden=true;centerCard.button.setAttribute('aria-expanded','false');
    if(restoreFocus)centerCard.button.focus();
  }
  function clearCenters(){
    centerCard?.dispose();centerCard=null;centerDraw=null;
    centerOverlays.forEach(overlay=>overlay.setMap(null));centerOverlays=[];centers=[];
    centerChoices.replaceChildren();centerChoices.hidden=true;
  }
  function drawCenters(){
    const map=bridge.state.map,rows=centerRows(),signature=JSON.stringify(rows);
    if(centerDraw?.map===map&&centerDraw.signature===signature)return;
    clearCenters();centers=rows;centerDraw={map,signature};centerChoices.hidden=!centers.length;
    if(centers.length){const label=document.createElement('span');label.textContent='센터에서 출발';centerChoices.append(label);}
    for(const center of centers){
      const button=document.createElement('button');button.type='button';button.textContent=center.customerName;button.onclick=()=>choosePoint('origin',center);centerChoices.append(button);
      if(!map)continue;
      if(center.id==='osan')drawOsanCenter(center,map);
      else{
        const label=document.createElement('button');label.type='button';label.className='centerMarker';label.textContent=center.customerName;label.onclick=()=>{updateSelected(center);if(bridge.state.mode==='DATE_ROUTE')planner.open=true;};
        const overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(center.lat,center.lng),content:label,zIndex:2});overlay.setMap(map);centerOverlays.push(overlay);
      }
    }
  }
  function drawOsanCenter(center,map){
    const anchor=document.createElement('div');anchor.className='osanCenterAnchor';
    const button=document.createElement('button');button.type='button';button.className='centerMarker osanCenterMarker';button.dataset.centerCode=center.customerCode;
    button.setAttribute('aria-controls','osanCenterCard');button.setAttribute('aria-expanded','false');
    button.innerHTML='<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 12l10-6 10 6v11H4z M10 23v-8h8v8m-8-4h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span></span>';
    button.querySelector('span').textContent=center.customerName;
    const card=document.createElement('section');card.id='osanCenterCard';card.hidden=true;card.setAttribute('aria-label',center.customerName);
    card.innerHTML='<strong></strong><p></p><div><button type="button" data-center-origin>출발지로</button><button type="button" data-center-close>닫기</button></div>';
    card.querySelector('strong').textContent=center.customerName;card.querySelector('p').textContent=center.address;
    function placeCard(){
      if(card.hidden)return;
      const point=anchor.getBoundingClientRect(),bounds=$('#map').getBoundingClientRect(),size=card.getBoundingClientRect();
      const left=bounds.left+8+size.width/2,right=bounds.right-8-size.width/2;
      card.style.setProperty('--osan-card-shift',`${Math.max(left,Math.min(right,point.left))-point.left}px`);
      card.dataset.side=point.top-bounds.top<size.height+button.offsetHeight+10?'below':'above';
    }
    function syncCenterSize(){const level=map.getLevel?.()??7;anchor.style.setProperty('--osan-icon-size',`${Math.max(15,Math.min(23,27-level))}px`);placeCard();}
    button.onclick=event=>{event.stopPropagation();if(!card.hidden)return closeCenterCard(true);card.hidden=false;button.setAttribute('aria-expanded','true');placeCard();};
    card.querySelector('[data-center-close]').onclick=()=>closeCenterCard(true);
    card.querySelector('[data-center-origin]').onclick=()=>{if(choosePoint('origin',center))closeCenterCard();};
    card.onkeydown=button.onkeydown=event=>{if(event.key==='Escape')closeCenterCard(true);};
    anchor.append(button,card);
    const overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(center.lat,center.lng),content:anchor,clickable:true,xAnchor:0,yAnchor:0,zIndex:42});
    overlay.setMap(map);centerOverlays.push(overlay);syncCenterSize();
    const onMapClick=()=>closeCenterCard();
    const listeners=[['zoom_changed',syncCenterSize],['idle',placeCard],['click',onMapClick]];
    listeners.forEach(([name,fn])=>kakao.maps.event?.addListener(map,name,fn));window.addEventListener('resize',placeCard);
    centerCard={button,card,dispose(){listeners.forEach(([name,fn])=>kakao.maps.event?.removeListener(map,name,fn));window.removeEventListener('resize',placeCard);}};
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
    syncMissing();describeInputs();renderRolePins();syncRecordedStops();bridge.relayoutPreservingView?.();
  }
  const onManual=event=>{if(event.detail?.state==='loading')clearTimeout(recalculateTimer);if(['success','partial'].includes(event.detail?.state))autoRecalculate=true;else if(['error','disabled'].includes(event.detail?.state))autoRecalculate=false;showResult(event.detail,'manual');},onRecorded=event=>showResult(event.detail,'recorded'),onSelected=()=>{closeCenterCard();updateSelected();},onReady=()=>{drawCenters();sync();};
  const onStaffReady=()=>{if(bridge.state.map)void window.KakaoMapsAdapter.ready().then(onReady).catch(()=>{});};
  const onDraft=()=>{
    const values=editor.values();
    if(values[0]!==lastOrigin){lastOrigin=values[0];originVersion++;automaticOrigin=false;}
    clearTimeout(recalculateTimer);status('');hideSuggestions();describeInputs();renderRolePins();window.MapDotUi?.arrangeNavigation?.();
    if(values.every(value=>!String(value||'').trim()))autoRecalculate=false;
    // Only a route explicitly queried successfully enables recalculation.
    // Incomplete text, initial load and provider errors never cause API calls.
    if(autoRecalculate&&values.length>=2&&roleRows().length===values.length)recalculateTimer=setTimeout(()=>{if(!disposed&&autoRecalculate&&roleRows().length===editor.values().length)$('#planRoute').click();},450);
  };
  const onContext=()=>{autoRecalculate=false;automaticOrigin=false;cancelRecordedRead();closeCenterCard();clearTimeout(recalculateTimer);hideSuggestions();temporaryPlaces.clear();editor.clear();selectedCandidate=null;updateSelected(null);lastResult=null;lastKind='manual';showResult({state:'idle'});queueMicrotask(sync);};
  const onLogout=()=>{clearCenters();onContext();};
  const events=[['map-manual-route',onManual],['map-recorded-route',onRecorded],['map-store-selected',onSelected],['map-sdk-ready',onReady],['map-staff-ready',onStaffReady],['map-navigation-logout',onLogout],['map-navigation-context-changed',onContext],['map-navigation-vehicle-changed',sync],['map-navigation-draft',onDraft],['map-coordinate-updated',sync],['resize',scheduleRolePins]];
  events.forEach(([name,listener])=>window.addEventListener(name,listener));
  const observer=new MutationObserver(sync);if($('#modeDaily'))observer.observe($('#modeDaily'),{attributes:true,attributeFilter:['aria-pressed']});if($('#runList'))observer.observe($('#runList'),{childList:true});
  window.addEventListener('pagehide',event=>{if(event.persisted)return;disposed=true;cancelAddressSearch();cancelRecordedRead();clearTimeout(suggestTimer);clearTimeout(recalculateTimer);observer.disconnect();events.forEach(([name,listener])=>window.removeEventListener(name,listener));document.removeEventListener('pointerdown',outsidePointer);if(rolePinMap)kakao.maps.event?.removeListener(rolePinMap,'idle',scheduleRolePins);clearCenters();clearRolePins();},{once:true});
  window.MapNavigation=Object.freeze({resolve,search:value=>lookup.search(value,all()),sync,metrics:()=>({centerOverlays:centerOverlays.length,routePointOverlays:routePointOverlays.length,routePointCount:roleRows().length,temporaryPointCount:temporaryPlaces.values().length,routeState:lastResult?.state||'idle'})});
  drawCenters();updateSelected();sync();
})();
