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
        ${navigationMarkup}
        <div id="nearWrap" aria-live="polite"><p class="areaPanelHint">주변 매장을 확인하고 있습니다.</p></div>
        <div class="areaPanelActions">
          ${allowBatch?'<button type="button" id="searchPointToBatch" class="areaPanelPrimary">신규권역 일괄조회에 추가</button>':''}
          ${canRemove?'<button type="button" id="removeTemporaryPin" class="areaPanelSecondary">임시 핀 삭제</button>':''}
          ${distanceMarkup}
        </div>
      </div>
    </div>`;
  }

  const nearbyVisibleCount=5;
  const compareNearby=(a,b)=>a.distance-b.distance||a.store.customerCode.localeCompare(b.store.customerCode);
  function rankNearby(point,registered,distanceKm){
    const head=[],remainder=[];
    for(const store of registered){
      const item={store,distance:distanceKm(point,store)};
      if(head.length===nearbyVisibleCount+1&&compareNearby(item,head.at(-1))>=0){
        remainder.push(item);
        continue;
      }
      const position=head.findIndex(entry=>compareNearby(item,entry)<0);
      head.splice(position<0?head.length:position,0,item);
      if(head.length>nearbyVisibleCount+1)remainder.push(head.pop());
    }
    const project=({store,distance})=>({
      customerCode:store.customerCode,customerName:store.customerName,baseVehicle:store.baseVehicle,
      unassigned:store.baseVehicleState==='UNASSIGNED',stale:store.baseVehicleStale,distance
    });
    const [nearest,...stores]=head.map(project);
    let sorted=false;
    return {nearest,stores,storeCount:Math.max(0,registered.length-1),readPage(start,end){
      if(!sorted){remainder.sort(compareNearby);sorted=true;}
      return remainder.slice(start-nearbyVisibleCount,end-nearbyVisibleCount).map(project);
    }};
  }

  function limitedList(items,storeCount,expanded){
    const rest=storeCount-nearbyVisibleCount;
    return `<ul class="areaPanelList">${items.slice(0,nearbyVisibleCount).map(storeRow).join('')}</ul>`+(rest>0?`<details data-nearby-stores${expanded?' open':''}>
      <summary>전체 보기 <span>+${rest}</span></summary><div class="areaPanelScroll"><ul class="areaPanelList"></ul><button type="button" class="areaPanelSecondary" data-area-nearby-more>매장 더 보기</button></div>
    </details>`:'');
  }

  function storeRow(store){
    const name=store.customerName||store.customerCode||'매장명 미확인';
    return `<li><button type="button" data-area-nearby-code="${escape(store.customerCode)}">
      <span>${escape(name)}<small>${escape(store.customerCode)}${store.baseVehicle?' · '+escape(vehicle(store.baseVehicle)):''}</small></span>
      <b>${distance(store.distance)}</b></button></li>`;
  }

  function nearby({nearest,stores,storeCount=stores.length,expanded}){
    if(!nearest)return '<p class="areaPanelHint">등록 매장 위치 미확인</p>';
    const fixed=nearest.baseVehicle?vehicle(nearest.baseVehicle)+(nearest.stale?' (이전 배차표)':''):nearest.unassigned?'미배정':'미확인';
    return `<section class="areaPanelSection" aria-label="가장 가까운 매장" data-area-nearest>
      <div class="areaPanelHeading">가장 가까운 등록 매장 <small>직선거리</small></div>
      <div class="areaPanelClosest"><button type="button" data-area-nearby-code="${escape(nearest.customerCode)}"><strong>${escape(nearest.customerName||nearest.customerCode)}</strong><small>${escape(nearest.customerCode)}</small></button><b>${distance(nearest.distance)}</b></div>
      <dl class="areaPanelFacts"><div><dt>기준호차</dt><dd>${escape(fixed)}</dd></div><div><dt>배송요일</dt><dd>${escape(nearest.weekdays||'배송이력 확인 필요')}</dd></div></dl>
    </section>${stores.length?`<section class="areaPanelSection" aria-label="주변 등록 매장">
      <div class="areaPanelHeading">주변 등록 매장 <small>직선거리순</small></div>
      ${limitedList(stores,storeCount,expanded)}
    </section>`:''}`;
  }

  function bindMore(panel,stores,{storeCount=stores.length,readPage=(start,end)=>stores.slice(start,end)}={}){
    const details=panel.querySelector('[data-nearby-stores]');
    if(!details)return;
    const list=details.querySelector('.areaPanelScroll ul');
    const more=details.querySelector('[data-area-nearby-more]');
    let next=nearbyVisibleCount;
    const append=()=>{
      const page=readPage(next,next+80);
      list.insertAdjacentHTML('beforeend',page.map(storeRow).join(''));
      next+=page.length;
      more.hidden=next>=storeCount;
    };
    details.ontoggle=()=>{if(details.open&&next===nearbyVisibleCount)append();};
    if(details.open)append();
    more.onclick=append;
  }

  root.MapNewAreaDetailPanel=Object.freeze({shell,nearby,bindMore,rankNearby});
})(typeof window==='object'?window:globalThis);
