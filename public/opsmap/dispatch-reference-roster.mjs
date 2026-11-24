import {money} from './dispatch-reference.mjs?v=20261124-wms-totals';

const rowHeight=55;
const bufferRows=5;
const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
export const dispatchVehicleLabel=vehicle=>/^\d+$/.test(vehicle||'')?vehicle+'호':vehicle||'—';
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');

export function matchDispatchStores(entries,query) {
  const terms=String(query??'').trim().split(/\s+/).map(normalize).filter(Boolean);
  return terms.length?entries.filter(({fields})=>terms.every(term=>fields.some(field=>field.includes(term)))).map(({row})=>row):
    entries.map(({row})=>row);
}

export function indexDispatchStores(rows) {
  return rows.map(row=>({row,fields:[row.name,row.customerCode,row.postalCode,row.vehicle,row.vehicle+'호',row.vehicle+'호차'].map(normalize)}));
}

export function summarizeDispatchOverview(model) {
  const assigned=[...model.vehicles.values()].filter(route=>route.stops.length);
  const unique=new Set(), positioned=new Set();
  for (const {stops} of assigned) for (const row of stops) {
    unique.add(row.customerCode);
    if(row.point)positioned.add(row.customerCode);
  }
  return {vehicles:assigned.length,stores:unique.size,located:positioned.size,complete:model.routeVerified,
    deliveries:model.sourceTotals?.deliveryCount??null,amount:model.sourceTotals?.amount??null,unassigned:model.unassigned};
}

export function mountDispatchRoster(list,choose) {
  const track=list.firstElementChild;
  let rows=[], selected='', first=-1,last=-1,frame;

  const queue=()=>{frame??=requestAnimationFrame(render);};
  const observer=new ResizeObserver(queue);
  observer.observe(list);
  function render() {
    if(frame!==undefined)cancelAnimationFrame(frame);
    frame=undefined;
    if(!list.clientHeight)return;
    const from=Math.max(0,Math.floor(list.scrollTop/rowHeight)-bufferRows);
    const to=Math.min(rows.length,Math.ceil((list.scrollTop+list.clientHeight)/rowHeight)+bufferRows);
    if(from===first&&to===last)return;
    first=from;
    last=to;
    const active=track.contains(document.activeElement)?document.activeElement.dataset.rosterKey:null;
    track.innerHTML=rows.slice(from,to).map((row,index)=>{
      const rank=from+index;
      return '<div class="dispatch-roster-entry" role="listitem" aria-posinset="'+(rank+1)+'" aria-setsize="'+rows.length+
        '" style="top:'+rank*rowHeight+'px"><button type="button" data-roster-key="'+escape(row.dispatchKey)+
        '" data-roster-index="'+rank+'" aria-pressed="'+(selected===row.dispatchKey)+'" title="'+escape(row.name)+'">'+
        '<span class="dispatch-roster-first"><b>'+escape(dispatchVehicleLabel(row.vehicle))+'</b><strong>'+escape(row.name)+'</strong></span>'+
        '<span class="dispatch-roster-second"><span>'+escape(row.customerCode)+' · '+escape(row.postalCode||'우편번호 미확인')+
        '</span><b>'+money(row.amount)+'</b></span></button></div>';
    }).join('');
    if(active) [...track.querySelectorAll('button')].find(button=>button.dataset.rosterKey===active)?.focus({preventScroll:true});
  }
  list.addEventListener('scroll',queue,{passive:true});
  list.addEventListener('click',event=>{
    const button=event.target.closest('[data-roster-index]');
    const row=button&&rows[Number(button.dataset.rosterIndex)];
    if(row&&row.dispatchKey===button.dataset.rosterKey) choose(row);
  });
  list.addEventListener('keydown',event=>{
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)||!rows.length||event.ctrlKey||event.metaKey)return;
    const current=Number(event.target.closest('[data-roster-index]')?.dataset.rosterIndex??Math.floor(list.scrollTop/rowHeight));
    const next=event.key==='Home'?0:event.key==='End'?rows.length-1:
      Math.max(0,Math.min(rows.length-1,current+(event.key==='ArrowDown'?1:-1)));
    event.preventDefault();
    const top=next*rowHeight;
    if(top<list.scrollTop||top+rowHeight>list.scrollTop+list.clientHeight)list.scrollTop=top;
    render();
    track.querySelector('[data-roster-index="'+next+'"]')?.focus({preventScroll:true});
  });
  return {
    setRows(next) {
      rows=next;
      first=last=-1;
      list.scrollTop=0;
      track.style.height=rows.length*rowHeight+'px';
      if(!rows.length)track.replaceChildren();
      render();
    },
    select(key) {
      selected=key;
      for (const button of track.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.rosterKey===selected));
    },
    refresh:queue,
  };
}
