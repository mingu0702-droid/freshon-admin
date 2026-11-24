import {money} from './dispatch-reference.mjs?v=20261124-wms-totals';
import {compareDispatchReview,groupFixedPostalRoutes,simulateDispatchReviewMoves} from './dispatch-reference-review-model.mjs?v=20261125-comparison';

const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const format=new Intl.NumberFormat('ko-KR');
const plus=new Intl.NumberFormat('ko-KR',{signDisplay:'exceptZero'});
const label=value=>/^\d+$/.test(value||'')?value+'호':value||'—';
const meters=km=>Number.isFinite(km)?format.format(Math.round(km*1000))+'m':'미확인';
const stops=value=>Number.isSafeInteger(value)?format.format(value)+'착':'미확인';
const fixedClock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric'});

export function createDispatchScreenReview({bridge,readFixedArea}) {
  const nearby=document.createElement('section');
  nearby.className='dispatch-compare-nearby';
  const drafts=new Map(), comparisons=new Map();
  let panel,view,active=false,areaProof,areaRequest,sharedLocation=[],sourceDetailsOpen=false,draftsOpen=false;

  function attach({choices,detail}) {
    panel=detail;
    choices.append(nearby);
    nearby.addEventListener('click',event=>{
      const button=event.target.closest('[data-compare-vehicle]');
      if(button) view?.chooseRoute(button.dataset.compareVehicle);
    });
    panel.addEventListener('click',handleAction);
  }

  function updateNearby(items,{hasAnchor}) {
    if (!active) return;
    const selected=view?.routes?.secondary?.vehicle;
    const adjacent=items.filter(item=>item.minimumKm!==null&&item.minimumKm<=.5);
    const postal=items.filter(item=>!adjacent.includes(item));
    const list=rows=>'<div class="dispatch-compare-near-list">'+rows.map(({source,sharedPostalCodes,minimumKm})=>{
          const vehicle=escape(source.vehicle);
          return '<button type="button" data-compare-vehicle="'+vehicle+'" aria-label="'+escape(label(source.vehicle))+' 비교" aria-pressed="'+
            (selected===source.vehicle)+'"><span class="dispatch-compare-near-top"><strong>'+escape(label(source.vehicle))+
            '</strong><span>'+money(source.amount)+'<b>'+stops(source.storeCount)+'</b></span></span>'+
            '<span class="dispatch-compare-near-proof"><span>공통 우편번호 <b>'+sharedPostalCodes.length+'곳</b></span>'+
            '<span>최근접 직선 <b>'+meters(minimumKm)+'</b></span></span></button>';
    }).join('')+'</div>';
    nearby.innerHTML='<h3>인접 호차'+(hasAnchor?'<span>'+adjacent.length+'대</span>':'')+'</h3>'+
      (!hasAnchor?'<p>비교 기준 호차를 선택하세요.</p>':adjacent.length?list(adjacent):'<p>500m 이내 매장이 확인된 호차가 없습니다.</p>')+
      (postal.length?'<h3>우편번호만 공통 <span>'+postal.length+'대</span></h3>'+list(postal):'');
  }

  function findMove(row) {
    const comparison=comparisons.get(row?.vehicle);
    const candidate=comparison?.nearbyCandidates.find(stop=>stop.customerCode===row.customerCode);
    if (!candidate || !Number.isSafeInteger(candidate.amount) || candidate.amount<0) return null;
    const move={source:row.vehicle,target:comparison.target.vehicle,customerCode:row.customerCode,mode:'nearby'};
    return simulateDispatchReviewMoves(view.model,[move])?{...move,candidate}:null;
  }

  function renderRoute(route,title,side) {
    return '<section class="dispatch-compare-total '+side+'"><span>'+title+'</span><strong>'+escape(label(route?.vehicle))+'</strong>'+
      '<b>'+money(route?.amount)+'</b><span class="dispatch-compare-stop-count">'+stops(route?.storeCount)+'</span></section>';
  }

  function renderPostcodes() {
    const first=view.routes?.primary,second=view.routes?.secondary;
    if(!first||!second)return '';
    const common=comparisons.get(first.vehicle)?.sharedPostalCodes||[];
    const zip=view.zip;
    const proof=areaProof?.area===zip?areaProof:null;
    const checked=bridge.fixedTerritoryMasterState?.()?.checkedAt;
    const date=Number.isFinite(Date.parse(checked))?' · '+fixedClock.format(new Date(checked)):'';
    const fixed=proof?.members?groupFixedPostalRoutes(proof.members,code=>bridge.dispatchReferenceFixedVehicle(code)):[];
    const pair=fixed.filter(entry=>[first.vehicle,second.vehicle].includes(entry.vehicle));
    const fixedText=pair.length?pair.map(r=>escape(label(r.vehicle))+' '+r.count+'착').join(' · ')+
      (proof.complete&&fixed.reduce((sum,r)=>sum+r.count,0)===proof.total?'':' · 일부 미확인'):
      proof?.loading?'확인 중':'해당 호차 확인 자료 없음';
    return '<section class="dispatch-compare-postal"><h3>확정배차 공통 우편번호 <span>'+common.length+'곳</span></h3>'+
      (common.length?'<div class="dispatch-compare-chips">'+common.map(code=>
        '<button type="button" data-compare-action="postal" data-code="'+code+'" aria-pressed="'+(zip===code)+'">'+code+'</button>').join('')+'</div>':'')+
      (zip?'<p>등록 매장 기준호차'+escape(date)+' · '+fixedText+'</p>':'')+'</section>';
  }

  function renderSelected() {
    const row=view.selection;
    const route=view.routes?.[row?.dispatchSide];
    const other=view.routes?.[row?.dispatchSide==='primary'?'secondary':'primary'];
    const move=row&&findMove(row);
    const nearest=move?{stop:move.candidate.nearest,km:move.candidate.km}:row&&other?view.nearest(row,other):null;
    const activeDraft=move&&drafts.has(move.customerCode);
    view.showDistance(nearest?{point:row.point,nearest:nearest.stop,km:nearest.km}:null);
    const shared=sharedLocation.length?'<div class="dispatch-compare-location">'+sharedLocation.map(stop=>
      '<button type="button" data-compare-action="store" data-code="'+escape(stop.customerCode)+'" data-vehicle="'+escape(stop.vehicle)+'">'+
      escape(label(stop.vehicle)+' '+stop.name)+' · '+escape(stop.customerCode)+'</button>').join('')+'</div>':'';
    if(!row) return '<section class="dispatch-compare-selection"><h3>이관할 매장</h3>'+
      '<p>지도 핀 또는 이관 후보 목록에서 매장을 선택하세요.</p>'+shared+'</section>';
    const address=bridge.dispatchReferenceRegisteredAddress?.(row.customerCode,row.point);
    const stopAmount=route?.displayAmounts?.get(row.customerCode);
    const hint=!other?'비교호차를 선택하세요.':!view.model.sameWmsExport||!route?.detail||!other.detail||!Number.isSafeInteger(stopAmount)?
      '검증된 상세 금액이 필요합니다.':!nearest?'비교호차 매장 거리를 확인할 수 없습니다.':
      nearest.km>.5?'500m 이내 이관 후보가 아닙니다.':!move?'복수 호차에 배정됐거나 이관 금액을 대조할 수 없습니다.':'';
    return '<section class="dispatch-compare-selection"><h3>이관할 매장</h3>'+shared+
      '<strong class="dispatch-compare-store-name">'+escape(row.name)+'</strong><p>'+escape(row.customerCode)+' · '+escape(address||'등록 주소 미확인')+'</p>'+
      '<dl><div><dt>배송금액</dt><dd>'+money(stopAmount)+'</dd></div><div><dt>확정호차 → 이관 대상</dt><dd>'+
      escape(label(route?.vehicle))+' → '+escape(label(other?.vehicle))+'</dd></div><div><dt>상대 호차 최근접</dt><dd>'+
      (nearest?escape(nearest.stop.name)+' · <strong>'+meters(nearest.km)+'</strong> 직선':'미확인')+'</dd></div></dl>'+
      (move?'<button class="dispatch-compare-add" type="button" data-compare-action="draft" aria-pressed="'+Boolean(activeDraft)+'">'+
        (activeDraft?'이관 목록에서 빼기':'이관 목록에 담기')+'</button>':hint?'<p>'+hint+'</p>':'')+'</section>';
  }

  function renderSimulation(first,second) {
    if(!first||!second)return '';
    const entries=[...drafts.values()];
    const result=entries.length?simulateDispatchReviewMoves(view.model,entries):null;
    const rows=[first,second].flatMap(route=>{
      const projected=result?.vehicles.get(route.vehicle)??route;
      return [[label(route.vehicle)+' 금액',route.amount,projected.amount,money,'원'],
        [label(route.vehicle)+' 착지',route.storeCount,projected.storeCount,stops,'착']];
    });
    const table='<table><thead><tr><th scope="col">항목</th><th scope="col">이관 전</th><th scope="col">이관 후</th>'+
      '<th scope="col">증감</th></tr></thead><tbody>'+rows.map(([heading,before,after,show,unit])=>
        '<tr><th scope="row">'+escape(heading)+'</th><td>'+show(before)+'</td><td>'+show(after)+'</td><td>'+
        (Number.isSafeInteger(before)&&Number.isSafeInteger(after)?plus.format(after-before)+unit:'—')+'</td></tr>').join('')+'</tbody></table>';
    const beforeGap=Math.abs(first.amount-second.amount);
    const afterGap=result&&Math.abs(result.vehicles.get(first.vehicle).amount-result.vehicles.get(second.vehicle).amount);
    const status=result?'<p role="status">금액 격차 <strong>'+money(beforeGap)+' → '+money(afterGap)+'</strong> · '+
      (afterGap===beforeGap?'동일':afterGap>beforeGap?'증가':'감소')+'</p>'+
      '<p>두 호차 합산 금액 <strong>'+money(first.amount+second.amount)+'</strong> · 이관 전후 일치</p>':
      entries.length?'<p role="status">이관 결과를 대조할 수 없습니다. 선택한 매장을 확인하세요.</p>':'';
    return '<section class="dispatch-compare-simulation"><div class="dispatch-compare-heading"><h3>가상 이관 '+entries.length+'착</h3>'+
      (entries.length?'<button type="button" data-compare-action="clear">초기화</button>':'')+'</div>'+
      (entries.length?'<details class="dispatch-compare-drafts"'+(draftsOpen?' open':'')+'><summary>선택한 매장 '+entries.length+'곳</summary><ul>'+
        entries.map(({candidate,customerCode,source,target})=>'<li><span>'+escape(candidate.name)+' · '+
          escape(label(source))+' → '+escape(label(target))+'</span><button type="button" data-compare-action="remove" data-code="'+escape(customerCode)+
          '" aria-label="'+escape(candidate.name)+' 이관 취소">취소</button></li>').join('')+'</ul></details>':'')+
      table+status+'<p>이관 참고용 · 실제 동선·적재량·시간은 별도 확인</p></section>';
  }

  function renderCandidates() {
    if(comparisons.size!==2)return '';
    const rows=[...comparisons.values()].flatMap(({source,nearbyCandidates})=>nearbyCandidates.map(row=>({...row,vehicle:source.vehicle})))
      .sort((a,b)=>a.km-b.km||a.customerCode.localeCompare(b.customerCode));
    const displayed=view.zip?rows.filter(row=>row.postalCode===view.zip||row.nearest?.postalCode===view.zip):rows;
    return '<details class="dispatch-compare-candidates"'+(sourceDetailsOpen?' open':'')+'><summary>500m 이내 매장 '+displayed.length+'곳</summary>'+
      displayed.map(row=>'<button type="button" data-compare-action="store" data-code="'+escape(row.customerCode)+'" data-vehicle="'+escape(row.vehicle)+'">'+
        '<b>'+escape(label(row.vehicle))+' · '+escape(row.name)+'</b><span>'+meters(row.km)+' · '+money(row.amount)+'</span></button>').join('')+'</details>';
  }

  function render() {
    if (!active||!panel) return;
    const {model,routes}=view||{};
    const first=routes?.primary,second=routes?.secondary;
    const focus=panel.contains(document.activeElement)?document.activeElement:null;
    sourceDetailsOpen=panel.querySelector('.dispatch-compare-candidates')?.open??sourceDetailsOpen;
    draftsOpen=panel.querySelector('.dispatch-compare-drafts')?.open??draftsOpen;
    const totals=model?.sourceTotals;
    const gap=Number.isSafeInteger(first?.amount)&&Number.isSafeInteger(second?.amount)?money(Math.abs(first.amount-second.amount)):'미확인';
    panel.innerHTML='<h2>호차 비교 및 가상 이관</h2>'+
      (totals?'<p class="dispatch-compare-source">오산 WMS '+money(totals.amount)+' · 배송 '+format.format(totals.deliveryCount)+'건</p>':'')+
      '<div class="dispatch-compare-totals">'+renderRoute(first,'비교 기준','primary')+renderRoute(second,'비교 호차','secondary')+'</div>'+
      (first&&second?'<p class="dispatch-compare-gap">현재 차이 <strong>'+gap+'</strong> · '+
        (Number.isSafeInteger(first.storeCount)&&Number.isSafeInteger(second.storeCount)?stops(Math.abs(first.storeCount-second.storeCount)):'착지 미확인')+'</p>':'')+
      (model?renderPostcodes()+renderSelected()+renderSimulation(first,second)+renderCandidates():'');
    view?.highlightMoves([...drafts.values()]);
    if (focus?.dataset.compareAction) {
      const replacement=[...panel.querySelectorAll('[data-compare-action]')].find(button=>
        ['compareAction','code','vehicle'].every(key=>button.dataset[key]===focus.dataset[key]));
      replacement?.focus({preventScroll:true});
    }
  }

  function loadArea(zip) {
    areaRequest?.abort();
    areaProof=null;
    if (!zip) return;
    areaProof={area:zip,loading:true};
    const request=areaRequest=new AbortController();
    void readFixedArea(zip,{signal:request.signal}).then(data=>{
      if(!request.signal.aborted){areaProof={area:zip,...data};render();}
    }).catch(()=>{
      if(!request.signal.aborted){areaProof={area:zip};render();}
    });
  }

  function update(next) {
    if (!next?.model || next.model!==view?.model || next.routes?.primary!==view?.routes?.primary ||
      next.routes?.secondary!==view?.routes?.secondary) {
      sharedLocation=[];
      drafts.clear();
      comparisons.clear();
      if (next?.routes?.primary&&next.routes.secondary) {
        const a=next.routes.primary.vehicle,b=next.routes.secondary.vehicle;
        for(const [from,to] of [[a,b],[b,a]]) {
          const comparison=compareDispatchReview(next.model,to,from);
          if(comparison)comparisons.set(from,comparison);
        }
      }
      if (!next?.model) nearby.replaceChildren();
    }
    if (next?.selection&&next.selection!==view?.selection) sharedLocation=[];
    if (next?.zip!==view?.zip) loadArea(next?.zip);
    view=next;
    render();
  }

  function handleAction(event) {
    const button=event.target.closest('[data-compare-action]');
    if(!button||!view?.model)return;
    const {compareAction:action,code,vehicle}=button.dataset;
    if(action==='postal'){view.choosePostal(view.zip===code?'':code);return;}
    if(action==='store'){view.pickStop(code,vehicle);return;}
    if(action==='draft'){
      const move=findMove(view.selection);
      if(!move)return;
      if(drafts.has(move.customerCode)) drafts.delete(move.customerCode);
      else drafts.set(move.customerCode,move);
    }
    if(action==='remove')drafts.delete(code);
    if(action==='clear')drafts.clear();
    render();
  }

  return {attach,update,updateNearby,showSharedLocation(members){sharedLocation=members;render();},
    open(){active=true;render();},
    close(){active=false;areaRequest?.abort();areaProof=null;view=null;sharedLocation=[];drafts.clear();comparisons.clear();
      sourceDetailsOpen=draftsOpen=false;nearby.replaceChildren();panel.replaceChildren();},
  };
}
