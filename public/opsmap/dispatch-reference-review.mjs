import {money} from './dispatch-reference.mjs?v=20261124-wms-totals';
import {compareDispatchReview,groupFixedPostalRoutes,simulateDispatchReviewMoves} from './dispatch-reference-review-model.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const routeLabel=value=>/^\d+$/.test(value||'')?value+'호':value||'—';
const count=new Intl.NumberFormat('ko-KR');
const meters=km=>Number.isFinite(km)?count.format(Math.round(km*1000))+'m':'미확인';
const variants={map:'지도 중심',fleet:'호차 비교',workbench:'이관 작업'};
const fixedClock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric'});

export function createDispatchScreenReview({variant,workspace,bridge,readFixedArea}) {
  const review=document.createElement('section');
  review.className='dispatch-review-dock';
  review.hidden=true;
  review.setAttribute('aria-label','배차 이관 시안');
  review.innerHTML='<div class="dispatch-review-left"><div class="dispatch-review-nav"></div><div class="dispatch-review-area"></div></div>'+
    '<div class="dispatch-review-list" aria-label="이관 후보"></div><div class="dispatch-review-result" aria-live="polite"></div>';
  workspace.append(review);
  const $=selector=>review.querySelector(selector);
  $('.dispatch-review-nav').innerHTML=Object.entries(variants).map(([id,label])=>
    '<a href="?dispatch-review='+id+'"'+(variant===id?' aria-current="page"':'')+'>'+label+'</a>').join('');
  const areaBox=$('.dispatch-review-area'), listBox=$('.dispatch-review-list'), resultBox=$('.dispatch-review-result');
  let view,active=false,request,areaProof,scope='',direction='primary',near='same-postal',picked='',selected=new Set();
  let fleetSort='amount',fleetVisible=true;

  function routesForDirection() {
    const {primary,secondary}=view?.routes||{};
    const [source,target]=direction==='primary'?[primary,secondary]:[secondary,primary];
    return {source,target,comparison:source&&target?compareDispatchReview(view.model,target.vehicle,source.vehicle):null};
  }
  function candidatesFor(comparison) {
    const rows=near==='same-postal'?comparison?.samePostalCandidates:comparison?.adjacentCandidates;
    const zip=view?.zip;
    return (rows||[]).filter(row=>Number.isFinite(row.km)&&row.km<=.5&&Number.isSafeInteger(row.amount)&&row.amount>0&&
      (!zip||row.postalCode===zip||near==='adjacent'&&row.nearest?.postalCode===zip));
  }
  const buttons=rows=>rows.map(([key,label,selected])=>'<button type="button" data-review-action="'+key+'" aria-pressed="'+Boolean(selected)+'">'+label+'</button>').join('');

  function renderArea() {
    if(!view?.model){areaBox.textContent='배송일과 호차를 선택하세요.';return;}
    const {source,target,comparison}=routesForDirection();
    const zip=view.zip;
    const same=zip?comparison?.sharedAreaCounts?.find(row=>row.code===zip):null;
    const fixed=areaProof?.area===zip?areaProof:null;
    const fixedInfo=fixed?.ready&&!fixed.failure?groupFixedPostalRoutes(fixed.members,
      code=>bridge.dispatchReferenceFixedVehicle(code)):
      [];
    const fixedCoverage=fixedInfo.reduce((sum,entry)=>sum+entry.count,0);
    const proofDate=bridge.fixedTerritoryMasterState?.()?.checkedAt;
    const proofLabel=Number.isFinite(Date.parse(proofDate))?' · '+fixedClock.format(new Date(proofDate))+' 정상본':'';
    areaBox.innerHTML='<div class="dispatch-review-pair"><b>'+esc(routeLabel(source?.vehicle))+' → '+esc(routeLabel(target?.vehicle))+'</b>'+
      '<button type="button" data-review-action="swap">방향 바꾸기</button></div>'+
      '<div><strong>'+(zip?'우편번호 '+esc(zip):'선택 호차 전체')+'</strong>'+
      '<span>확정배차 '+(same?esc(routeLabel(comparison.target.vehicle))+' '+same.target+'곳 · '+esc(routeLabel(comparison.source.vehicle))+' '+same.source+'곳':
        comparison?comparison.sharedPostalCodes.length+'개 공통 권역':'미확인')+'</span></div>'+
      '<div><strong>기준호차'+esc(proofLabel)+'</strong><span>'+
      (fixedInfo.length?fixedInfo.map(r=>esc(routeLabel(r.vehicle))+' '+r.count+'곳').join(' · ')+(fixed?.complete&&fixedCoverage===fixed.total?'':' · 일부 미확인'):
        zip&&fixed&&!fixed.ready?'확인 중':'확인 자료 없음')+'</span></div>';
  }
  function renderFleet() {
    const rows=[...view.model.vehicles.values()].filter(r=>/\d/.test(r.vehicle)&&r.stops.length);
    rows.sort((a,b)=>fleetSort==='count'?b.stops.length-a.stops.length:(b.amount??-1)-(a.amount??-1));
    listBox.innerHTML='<div class="dispatch-review-head"><strong>전체 호차 '+rows.length+'대</strong>'+
      '<button type="button" data-review-action="fleet-toggle">이관 후보</button>'+
      '<button type="button" data-review-action="fleet-sort">'+(fleetSort==='count'?'착지순':'금액순')+' ▾</button></div>'+
      '<div class="dispatch-review-roster" role="group" aria-label="호차 목록">'+rows.map(r=>
        '<button type="button" data-review-action="route" data-value="'+esc(r.vehicle)+'">'+esc(routeLabel(r.vehicle))+
        '<span>'+r.stops.length+'착</span><b>'+money(r.amount)+'</b></button>').join('')+'</div>';
  }

  function renderCandidates(rows) {
    const activeRow=rows.find(r=>r.customerCode===picked);
    listBox.innerHTML='<div class="dispatch-review-head"><strong>이관 검토 '+rows.length+'착</strong>'+
      (variant==='fleet'?'<button type="button" data-review-action="fleet-toggle">호차 목록</button>':'')+
      '<div class="dispatch-review-segment">'+buttons([['same','같은 우편번호',near==='same-postal'],
        ['near','다른 우편번호 · 500m',near==='adjacent']])+'</div></div>'+
      (rows.length?'<div class="dispatch-review-roster">'+rows.map(r=>
        '<button type="button" data-review-action="pick" data-value="'+esc(r.customerCode)+'" aria-pressed="'+(r.customerCode===picked)+'">'+
        '<strong>'+(selected.has(r.customerCode)?'✓ ':'')+esc(r.customerCode)+'</strong><span>'+esc(r.postalCode||'우편번호 미확인')+' · '+meters(r.km)+'</span><b>'+money(r.amount)+'</b></button>').join('')+'</div>':
        '<p class="dispatch-empty">이 범위의 확인된 후보가 없습니다.</p>')+
      (activeRow?'<button type="button" class="dispatch-review-add" data-review-action="draft">'+
        (selected.has(activeRow.customerCode)?'선택에서 빼기':'가상 이관에 담기')+'</button>':'');
  }

  function renderResult({source,target}) {
    if(!source||!target) {resultBox.textContent='두 호차를 선택하면 가상 이관 결과가 표시됩니다.';return;}
    const entries=[...selected];
    const moves=entries.map(customerCode=>({source:source.vehicle,target:target.vehicle,customerCode,
      mode:near}));
    const verified=entries.length?simulateDispatchReviewMoves(view.model,moves):null;
    const moved=verified?.movedAmount;
    const countChanged=Boolean(verified);
    const totalGapBefore=Math.abs(source.amount-target.amount);
    const totalGapAfter=countChanged?Math.abs((source.amount-moved)-(target.amount+moved)):totalGapBefore;
    const format=(r,amount,stops)=>'<tr><th scope="row">'+esc(routeLabel(r.vehicle))+'</th><td>'+money(r.amount)+' · '+r.stops.length+'착</td><td>'+
      (countChanged?money(amount)+' · '+stops+'착':'—')+'</td></tr>';
    resultBox.innerHTML='<div class="dispatch-review-head"><strong>가상 이관 '+entries.length+'착</strong>'+
      (entries.length?'<button type="button" data-review-action="clear">초기화</button>':'')+'</div>'+
      '<table><thead><tr><th scope="col">호차</th><th scope="col">현재</th><th scope="col">이관 후</th></tr></thead><tbody>'+
      format(source,source.amount-moved,source.stops.length-entries.length)+
      format(target,target.amount+moved,target.stops.length+entries.length)+'</tbody></table>'+
      (countChanged?'<p>금액 격차 '+money(totalGapBefore)+' → '+money(totalGapAfter)+
        (totalGapAfter>totalGapBefore?' · 격차 증가':totalGapAfter<totalGapBefore?' · 격차 감소':' · 동일')+'</p>':
        entries.length?'<p>확인된 이관 금액이 없습니다.</p>':'<p>매장을 담으면 금액과 착지를 비교합니다.</p>')+
      '<small>적재량·배송시간·차량 진입 확인 필요</small>';
  }

  function refreshArea(zip) {
    request?.abort();
    areaProof=null;
    if(!zip||!active)return;
    const controller=request=new AbortController();
    areaProof={area:zip,ready:false};
    void readFixedArea(zip,{signal:controller.signal}).then(data=>{
      if(!controller.signal.aborted)areaProof={area:zip,ready:true,...data};
    },()=>{
      if(!controller.signal.aborted)areaProof={area:zip,ready:true,failure:true};
    }).finally(()=>{
      if(!controller.signal.aborted&&active)renderArea();
    });
  }
  function update(next=view) {
    view=next;
    const key=[view?.model?.date,view?.routes?.primary?.vehicle,view?.routes?.secondary?.vehicle,view?.zip].join(':');
    if(scope!==key) {
      const old=scope;
      scope=key;
      selected=new Set();picked='';
      if(old.split(':').at(-1)!==view?.zip||!areaProof)refreshArea(view?.zip);
    }
    if(!active)return;
    renderArea();
    if(!view?.model){listBox.replaceChildren();resultBox.replaceChildren();return;}
    const routeData=routesForDirection(), rows=candidatesFor(routeData.comparison);
    const chosen=rows.find(row=>row.customerCode===view.selection?.customerCode&&view.selection.vehicle===routeData.source?.vehicle);
    if(chosen&&!(variant==='fleet'&&fleetVisible))picked=chosen.customerCode;
    if(variant==='fleet'&&fleetVisible)renderFleet();
    else renderCandidates(rows);
    renderResult(routeData);
  }
  review.addEventListener('click',event=>{
    const button=event.target.closest('[data-review-action]');
    if(!button||!view)return;
    const {reviewAction:action,value}=button.dataset;
    if(action==='swap'){direction=direction==='primary'?'secondary':'primary';selected.clear();picked='';}
    if(action==='same'||action==='near'){near=action==='same'?'same-postal':'adjacent';selected.clear();picked='';}
    if(action==='fleet-sort')fleetSort=fleetSort==='amount'?'count':'amount';
    if(action==='fleet-toggle'){fleetVisible=!fleetVisible;if(fleetVisible)picked='';}
    if(action==='route'){view.chooseRoute(value);return;}
    if(action==='pick'){picked=value;view.pickStop(value,routesForDirection().source?.vehicle);}
    if(action==='draft'&&picked){
      if(selected.has(picked))selected.delete(picked);else selected.add(picked);
    }
    if(action==='clear')selected.clear();
    update();
  });
  return {
    open(){active=true;review.hidden=false;update();},
    close(){active=false;review.hidden=true;request?.abort();request=null;areaProof=null;view=null;scope='';selected.clear();picked='';update();},
    update,
  };
}
