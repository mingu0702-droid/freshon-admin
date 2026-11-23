(function(root){
  'use strict';

  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const distance=km=>!Number.isFinite(km)?'':km<1?`${Math.round(km*1000)}m`:`${km.toFixed(1)}km`;
  const vehicle=value=>root.Phase2bUi?.normalizeVehicleLabel(value)||String(value||'').trim();

  function shell({address,locationBasis,canRemove,allowBatch,navigationMarkup='',distanceMarkup=''}){
    return `<div class="newAreaTemporaryPanel">
      <div class="detailHead"><button id="detailClose" class="detailClose" type="button" aria-label="닫기">×</button>
        <h2 class="areaPanelAddress storeName">${escape(address||'선택 위치')}</h2>
        <p class="areaPanelStatus">임시 위치 · 저장되지 않음${locationBasis&&locationBasis!=='임시 위치'?' · '+escape(locationBasis):''}</p>
      </div>
      <div class="detailBody areaPanelBody">
        <div id="nearWrap" aria-live="polite"><p class="areaPanelHint">주변 매장을 확인하고 있습니다.</p></div>
        <label class="areaPanelRadius" for="newAreaSingleRadius">참고 호차 반경 <select id="newAreaSingleRadius">${[30,40,50].map(value=>`<option value="${value}">${value}km</option>`).join('')}</select></label>
        ${navigationMarkup}${distanceMarkup}
        <div class="areaPanelActions">
          ${allowBatch?'<button type="button" id="searchPointToBatch" class="areaPanelPrimary">신규권역 일괄조회에 추가</button>':''}
          ${canRemove?'<button type="button" id="removeTemporaryPin" class="areaPanelSecondary">임시 핀 삭제</button>':''}
        </div>
      </div>
    </div>`;
  }

  function limitedList(items,render,{kind,open=false,limit=5}){
    const list=rows=>`<ul class="areaPanelList">${rows.map(render).join('')}</ul>`;
    const rest=items.slice(limit);
    return list(items.slice(0,limit))+(rest.length?`<details data-nearby-${kind}${open?' open':''}>
      <summary>전체 보기 <span>+${rest.length}</span></summary><div class="areaPanelScroll">${list(rest)}</div>
    </details>`:'');
  }

  function storeRow(store){
    const name=store.customerName||store.customerCode||'매장명 미확인';
    return `<li><button type="button" data-area-nearby-code="${escape(store.customerCode)}">
      <span>${escape(name)}<small>${escape(store.customerCode)}${store.baseVehicle?' · '+escape(vehicle(store.baseVehicle)):''}</small></span>
      <b>${distance(store.distance)}</b></button></li>`;
  }

  function nearby({facts,groups=[],radius,activeIndex=-1,activeLabel='',recent=[],observationMarkup='',expanded={}}){
    const hasNearest=Boolean(facts.nearestStoreCode)&&Number.isFinite(facts.nearestDistanceMeters);
    const stores=(facts.nearbyRegistered||[]).filter(store=>store.customerCode!==facts.nearestStoreCode);
    const nearbyCount=Array.isArray(facts.nearbyRegistered)?facts.nearbyRegistered.length:null;
    const nearbyContainsNearest=hasNearest&&facts.nearbyRegistered?.some(store=>store.customerCode===facts.nearestStoreCode);
    const fixed=facts.nearestBaseVehicle?vehicle(facts.nearestBaseVehicle)+(facts.dispatchStale?' (이전 배차표)':''):facts.nearestDispatchLabel||'미확인';
    const weekdays=root.MapPeriodUi?.areaFixedWeekdayLabel(facts)||'미확인';
    const observed=Array.isArray(recent)?recent.filter(value=>typeof value==='string'&&value.trim()).slice(0,5):[];
    const reference=Number.isInteger(facts.storeCounts?.[radius])?`등록 매장 ${facts.storeCounts[radius]}곳`:'';
    const groupRow=({group,index})=>{
      const count=Number.isInteger(group.storeCounts?.[radius])?`${group.storeCounts[radius]}곳`:'';
      const detail=[group.nearestStop?.customerName,count].filter(Boolean).join(' · ');
      return `<li><button type="button" data-area-dispatch-vehicle="${index}" aria-pressed="${index===activeIndex}">
        <span>${escape(root.MapPeriodUi?.areaVehicleLabel(group)||vehicle(group.vehicle))}${detail?`<small>${escape(detail)}</small>`:''}</span>
        <b>${distance(group.distance)}</b></button></li>`;
    };
    return `<section class="areaPanelSection" aria-label="가장 가까운 매장" data-area-nearest>
      <div class="areaPanelHeading">가장 가까운 등록 매장 <small>직선거리</small></div>
      ${facts.lookupState==='USER_SELECTED_LOCATION'?'<p class="areaPanelHint">직접 지정한 위치 · 검토 필요</p>':''}
      ${hasNearest?`<div class="areaPanelClosest"><button type="button" data-area-nearby-code="${escape(facts.nearestStoreCode)}"><strong>${escape(facts.nearestStore||facts.nearestStoreCode)}</strong><small>${escape(facts.nearestStoreCode)}</small></button><b>${facts.nearestDistanceMeters}m</b></div>
      <dl class="areaPanelFacts"><div><dt>기준호차</dt><dd>${escape(fixed)}</dd></div><div><dt>500m 내 배송요일</dt><dd>${escape(weekdays)}</dd></div>
      ${observed.length?`<div><dt>최근 배송 확인</dt><dd>${observed.map(escape).join(' · ')}</dd></div>`:''}</dl>`:'<p class="areaPanelHint">현재 자료에서 인근 등록 매장 위치를 확인하지 못했습니다.</p>'}
    </section>
    ${nearbyCount!==null?`<section class="areaPanelSection" aria-label="500m 내 등록 매장">
      <div class="areaPanelHeading">500m 내 등록 매장 <b>${nearbyCount}곳</b></div>
      ${stores.length?limitedList(stores,storeRow,{kind:'stores',limit:nearbyContainsNearest?4:5,open:expanded.stores}):''}
    </section>`:''}
    <section class="areaPanelSection" aria-label="반경 내 참고 호차">
      <div class="areaPanelHeading">${escape(radius)}km 내 참고 호차 <b>${groups.length?groups.length+'대':'미확인'}</b></div>
      ${reference?`<p class="areaPanelHint">${reference}</p>`:''}
      ${groups.length?limitedList(groups.map((group,index)=>({group,index})),groupRow,{kind:'vehicles',open:expanded.vehicles}):'<p class="areaPanelHint">현재 배차표에서 확인한 호차가 없습니다.</p>'}
      ${groups.length?'<button class="areaPanelSecondary" type="button" data-area-dispatch-overview>반경 지도 보기</button>':''}
      <p class="areaPanelHint" data-area-dispatch-stop${activeLabel?'':' hidden'}>${escape(activeLabel)}</p>
      ${observationMarkup}
    </section>`;
  }

  root.MapNewAreaDetailPanel=Object.freeze({shell,nearby});
})(typeof window==='object'?window:globalThis);
