(() => {
  'use strict';
  const bridge=window.MapUiLocalBridge,$=s=>document.querySelector(s),list=$('#vehicleList'),query=$('#vehicleQuery');
  if(!bridge||!list||!query)return;
  const names={osan:'오산센터',yeongnam:'영남센터',honam:'호남센터','':'센터 미확인'};
  const body=document.createElement('section');body.className='vehiclePickerControls';body.setAttribute('aria-label','호차 검색과 선택');
  const search=document.createElement('div');search.className='vehicleSearchLine';
  query.type='search';query.placeholder='호차번호 검색 (101, 202, 용34)';query.setAttribute('aria-label','호차번호 검색');query.autocomplete='off';
  const reset=document.createElement('button');reset.type='button';reset.textContent='초기화';reset.setAttribute('aria-label','호차 검색 초기화');search.append(query,reset);
  const actions=document.createElement('div');actions.className='vehiclePickerActions';
  const count=document.createElement('span');count.id='vehiclePickerSelectedCount';count.setAttribute('role','status');
  const selectAll=$('#selectAllVehicles'),clear=$('#clearVehicles');selectAll.textContent='전체 선택';actions.append(selectAll,clear,count);
  const note=document.createElement('p');note.id='vehicleEvidenceNote';note.className='hint';
  body.append(search,actions,note,list);$('#baseVehiclePicker').append(body);
  const openGroups=new Map();let catalogKey='',groups=[];
  function rememberGroups(){for(const item of list.querySelectorAll('details[data-vehicle-group]'))openGroups.set(item.dataset.vehicleGroup,item.open);}
  function createGroup(key,title,labels,{nested=false}={}){
    const details=document.createElement('details');details.dataset.vehicleGroup=key;details.className=nested?'vehicleRegionGroup':'vehicleCenterGroup';details.open=openGroups.get(key)??true;
    const summary=document.createElement('summary'),name=document.createElement('span'),total=document.createElement('small');name.textContent=title;total.dataset.groupCount='';summary.append(name,total);details.append(summary);
    const actions=document.createElement('div');actions.className='vehicleGroupActions';
    for(const [label,checked] of [['전체 선택',true],['해제',false]]){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-label',title+' '+label);
      button.onclick=()=>{const values=labels.filter(node=>!node.hidden).map(node=>node.querySelector('input').value);if(values.length)bridge.selectVehicleGroup(values,checked);};actions.append(button);
    }
    details.append(actions);groups.push({details,labels,total});return details;
  }
  function syncSelection(){
    const all=bridge.vehicleSelectionScope?.()==='all',inputs=[...list.querySelectorAll('input[type="checkbox"]')];
    if(all)for(const input of inputs)input.checked=true;
    const selected=all?inputs.length:inputs.filter(input=>input.checked).length;
    count.textContent=(all?'전체 ':'')+selected+' / '+inputs.length+'개 선택';
    for(const {details,labels,total} of groups){const shown=labels.filter(node=>!node.hidden).length;details.hidden=!shown;total.textContent=shown===labels.length?shown+'대':shown+' / '+labels.length+'대';}
  }
  function filter(){
    const center=bridge.state.mode==='BASE_60D'?bridge.state.centerFilter:'';
    for(const label of list.querySelectorAll('.vehicleItem')){
      label.style.removeProperty('display');label.hidden=!Phase2bUi.vehicleMatches(query.value,label.querySelector('input').value)||(!!center&&label.dataset.group!==center);
    }
    syncSelection();
  }
  function rebuild(){
    const catalog=bridge.vehicleCatalog?.()||[],labels=[...list.querySelectorAll('.vehicleItem')];
    const key=JSON.stringify([bridge.state.mode,catalog]);
    if(key===catalogKey&&labels.every(node=>node.closest('details[data-vehicle-group]'))){filter();return;}
    catalogKey=key;rememberGroups();groups=[];
    const byVehicle=new Map(labels.map(node=>[node.querySelector('input').value,node])),records=[];
    for(const item of catalog){const label=byVehicle.get(item.vehicle);if(!label)continue;label.dataset.group=item.center||'';
      label.title=item.conflict?'담당 센터 충돌':item.verified?(item.stale?'이전 확인값':'기준호차 확인값')+(item.checkedAt?' · '+item.checkedAt:''):'담당 센터 미확인';
      const area=label.querySelector('.vehicleArea');if(area)area.textContent='';records.push({...item,label});}
    list.replaceChildren();
    for(const center of ['osan','yeongnam','honam','']){
      const items=records.filter(row=>(row.center||'')===center);if(!items.length)continue;
      const centerGroup=createGroup('center:'+center,names[center],items.map(row=>row.label));
      const regions=[...new Set(items.map(row=>row.region||''))].sort((a,b)=>a?b?a.localeCompare(b,'ko'): -1:1);
      for(const region of regions){const rows=items.filter(row=>(row.region||'')===region).sort((a,b)=>Phase2bUi.compareVehicles(a.vehicle,b.vehicle));
        const regionGroup=createGroup('region:'+center+':'+region,region||'권역 미확인',rows.map(row=>row.label),{nested:true});
        const checks=document.createElement('div');checks.className='vehicleGroupChecks';for(const row of rows)checks.append(row.label);regionGroup.append(checks);centerGroup.append(regionGroup);}
      list.append(centerGroup);
    }
    const dates=[...new Set(records.filter(row=>row.stale).map(row=>row.checkedAt).filter(Boolean))].sort();
    note.textContent=bridge.state.mode==='DATE_ROUTE'?'선택한 배송일의 확정호차입니다. 센터·권역은 확인된 원천만 표시합니다.':records.some(row=>row.stale)?'기준호차 이전 확인값'+(dates.length?' · '+dates.join(', '):'')+' · 최신 권역은 미확인입니다.':'센터·권역은 확인된 기준호차 자료만 표시합니다.';
    filter();
  }
  query.oninput=filter;query.onkeydown=event=>{if(event.key==='Enter')event.preventDefault();};reset.onclick=()=>{query.value='';filter();query.focus();};
  window.addEventListener('map-vehicle-catalog',rebuild);window.addEventListener('map-vehicle-selection',filter);
  window.addEventListener('map-navigation-logout',()=>{query.value='';catalogKey='';groups=[];list.replaceChildren();count.textContent='';note.textContent='';});
  window.MapVehiclePicker=Object.freeze({element:body,refresh:rebuild,filter});rebuild();
})();
