// Read-only, page-memory print projection. No directions, geocoding or persistence.
export const PRINT_CENTERS=Object.freeze({osan:'오산',yeongnam:'영남',honam:'호남'});
export const PRINT_UNPROVIDED_CENTER='unprovided';
const unprovidedCenterLabel='센터 미구분(원천 미제공)';
const centerCodes={'011':'osan','012':'yeongnam','013':'honam',osanColdStorage:'osan','오산':'osan','오산센터':'osan','영남':'yeongnam','영남센터':'yeongnam','호남':'honam','호남센터':'honam'};
const text=value=>String(value??'').trim();
const vehicle=value=>text(value).replace(/호(?:차)?$/,'');
export const validPrintDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function centerOf(row,fixed){
 const source=(fixed?[row.baseVehicleGroup]:[row.vehicleGroup,row.dispatchCenterCode,row.centerCode,row.center,row.centerName]).filter(v=>text(v));
 if(!fixed&&!source.length)return PRINT_UNPROVIDED_CENTER;
 const values=source.map(v=>PRINT_CENTERS[v]?v:centerCodes[text(v)]).filter(Boolean);
 return new Set(values).size===1?values[0]:'';
}
export function datedPrintCenter({center,date,selectedVehicle,rows}){
 const selected=Object.hasOwn(PRINT_CENTERS,center)?center:Object.hasOwn(centerCodes,center)?centerCodes[center]:'';
 if(selected)return selected;
 const wanted=vehicle(selectedVehicle);
 const scopes=new Set(rows.map(row=>row.raw||row).filter(row=>row.deliveryDate===date&&
  (!wanted||vehicle(row.confirmedVehicle||row.vehicle)===wanted)).map(row=>centerOf(row,false)));
 return scopes.size===1?[...scopes][0]:'';
}
const verifiedFixed=(row,master)=>row.baseVehicleState==='VERIFIED_MASTER'&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&/^[a-f0-9]{64}$/.test(row.baseVehicleVersion||'')&&row.baseVehicleVersion===master?.version&&row.baseVehicleCheckedAt===master?.checkedAt;
const orderOf=row=>{const value=row.order??row.sequence??row.stopOrder??row.savedOrder;return value!==null&&value!==''&&Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;};
const safePoint=row=>!['CONFLICT','UNVERIFIED','MISSING'].includes(row.coordinateStatus)&&row.resolutionStatus!=='ADDRESS_CHANGED_REVIEW_REQUIRED'&&Number.isFinite(row.lat)&&Number.isFinite(row.lng)&&row.lat>=33&&row.lat<=39.5&&row.lng>=124&&row.lng<=132;

export function validateDatedPrintResponse(payload,date){
 if(payload?.ok!==true||!Array.isArray(payload.data)||payload.data.length>20000||payload.meta?.date!==date||payload.meta?.complete!==true||payload.meta?.hasMore===true||payload.meta?.truncated===true||payload.data.some(r=>r?.deliveryDate!==date))throw Error('DATE_UNVERIFIED');
 return payload.data;
}

const addressKey=row=>text(row?.address||row?.customerAddress).normalize('NFKC').replace(/\s+/g,' ');
const hash=row=>text(row?.currentAddressHash||row?.originalAddressHash||row?.addressHash);
const conflictingPoint=row=>{const bound=row?.coordinateAddressHash||row?.manualPinAddressHash||row?.originalAddressHash;return row?.addressChanged===true||row?.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED'||row?.coordinateStatus==='CONFLICT'||Boolean(row?.currentAddressHash&&bound&&row.currentAddressHash!==bound);};
function buildingPoint(row){
 const binding=hash(row);
 const building=row.coordinateSource==='BUILDING_VERIFIED'&&row.coordinateEvidence==='BUILDING_LOCATION'&&row.coordinateAccuracy==='BUILDING';
 const address=row.coordinateSource==='ADDRESS_REPRESENTATIVE'&&row.coordinateEvidence==='ADDRESS_LOCATION'&&row.coordinateAccuracy==='ADDRESS_APPROXIMATE';
 return (building||address)&&
  /^[a-f0-9]{64}$/.test(binding)&&[row.currentAddressHash,row.originalAddressHash,row.coordinateAddressHash,row.addressHash].filter(Boolean).every(value=>value===binding);
}
const savedPoint=row=>safePoint(row)&&!conflictingPoint(row)&&row.coordinateStatus!=='APPROXIMATE'&&(buildingPoint(row)||
 ['MANUAL_PIN','RAW_GPS','DELIVERY_RECORDED','VERIFIED_STORE_POINT'].includes(row.coordinateSource)&&
 (row.coordinateSource==='MANUAL_PIN'?row.resolutionStatus==='MANUAL_CONFIRMED':/^[a-f0-9]{64}$/.test(hash(row))||row.coordinateStatus==='CONFIRMED'));

export function mergeDatedPrintCoordinates(rows,snapshotRows){
 const known=new Map();
 for(const row of snapshotRows){
  const code=text(row.customerCode||row.code);if(!/^[A-Z]\d+$/.test(code))continue;
  if(!known.has(code))known.set(code,row);else known.set(code,null);
 }
 return rows.map(row=>{
  const current=known.get(text(row.customerCode||row.code));if(!current)return row;
  const historicAddress=addressKey(row),currentAddress=addressKey(current);
  const historicHash=hash(row), currentHash=hash(current);
  const changed=historicAddress&&currentAddress&&historicAddress!==currentAddress||historicHash&&currentHash&&historicHash!==currentHash;
  const addressMatched=Boolean(historicAddress&&historicAddress===currentAddress||/^[a-f0-9]{64}$/.test(historicHash)&&historicHash===currentHash);
  const projection={...row,customerName:row.customerName||current.customerName,address:row.address||row.customerAddress||current.address||current.customerAddress};
  if(changed||conflictingPoint(current)||conflictingPoint(row))return {...projection,coordinateStatus:'CONFLICT'};
  if(row.lat==null&&row.lng==null&&addressMatched&&row.coordinateStatus!=='UNVERIFIED'&&savedPoint(current))
   return {...projection,lat:current.lat,lng:current.lng,coordinateStatus:'CONFIRMED',
    coordinateSource:current.coordinateSource,coordinateAccuracy:current.coordinateAccuracy,coordinateEvidence:current.coordinateEvidence};
  return projection;
 });
}

export function buildVehiclePrintModel({basis,date,center,selectedVehicle,rows,master=null,nowDate=today()}){
 if(!['FIXED','DATED'].includes(basis)||!validPrintDate(date)||date>nowDate||!(PRINT_CENTERS[center]||basis==='DATED'&&center===PRINT_UNPROVIDED_CENTER)||!vehicle(selectedVehicle)||vehicle(selectedVehicle).length>64||!Array.isArray(rows))throw Error('SELECTION_REQUIRED');
 const fixed=basis==='FIXED',wanted=vehicle(selectedVehicle),conflicts=new Set(),seen=new Map();
 if(fixed&&(!master?.version||!master.checkedAt||!Number.isFinite(Date.parse(master.checkedAt))))throw Error('MASTER_UNVERIFIED');
 if(!fixed&&rows.some(r=>r?.deliveryDate!==date))throw Error('DATE_UNVERIFIED');
 for(const row of rows){
  const code=text(row.customerCode||row.code);if(!/^[A-Z]\d+$/.test(code))continue;
  const id=fixed?code:code+'|'+vehicle(row.vehicle||row.confirmedVehicle),identity=JSON.stringify([vehicle(fixed?row.baseVehicle:row.vehicle||row.confirmedVehicle),centerOf(row,fixed),row.address||'',fixed?null:orderOf(row),row.lat,row.lng,row.coordinateStatus]);
  if(!fixed&&row.vehicle&&row.confirmedVehicle&&vehicle(row.vehicle)!==vehicle(row.confirmedVehicle))conflicts.add(code);
  if(seen.has(id)&&seen.get(id)!==identity)conflicts.add(code);else seen.set(id,identity);
 }
 const output=new Map();
 for(const row of rows){
  const code=text(row.customerCode||row.code);
  if(!/^[A-Z]\d+$/.test(code)||conflicts.has(code)||vehicle(fixed?row.baseVehicle:row.vehicle||row.confirmedVehicle)!==wanted||centerOf(row,fixed)!==center||fixed&&!verifiedFixed(row,master))continue;
  // Explicit allowlist: raw objects, contact/access details and credentials never enter the print model.
  output.set(code,{customerCode:code,customerName:text(row.customerName||row.name),address:text(row.address||row.customerAddress),order:fixed?null:orderOf(row),lat:safePoint(row)?row.lat:null,lng:safePoint(row)?row.lng:null});
 }
 const stores=[...output.values()].sort((a,b)=>(a.order??Infinity)-(b.order??Infinity)||a.customerCode.localeCompare(b.customerCode,'ko',{numeric:true}));
 return {basis,date,center,centerName:center===PRINT_UNPROVIDED_CENTER?unprovidedCenterLabel:PRINT_CENTERS[center],vehicle:wanted,checkedAt:fixed?master.checkedAt:null,stale:fixed&&master.stale!==false,stores,
  locatedCount:stores.filter(r=>r.lat!==null).length,unlocatedCount:stores.filter(r=>r.lat===null).length,
  basisLabel:fixed?'현재 기준호차 매장 목록':'해당일 저장 배차 매장 목록',
  note:fixed?'기준일은 출력 기준일입니다. 과거 배차·과거 기준호차를 복원한 자료가 아니며 방문 순서는 미확정입니다.':(center===PRINT_UNPROVIDED_CENTER?'배차 원천에 센터가 제공되지 않은 매장만 포함합니다. 현재 기준호차 센터로 추정하지 않았습니다. ':'')+'해당 배송일이 검증된 저장 배차입니다. 방문 순서는 원천에 기록된 값만 표시하며 실제 주행 경로·완료 순서를 뜻하지 않습니다.'};
}

export function buildVehiclePrintBatch({selectedVehicles,rows,...scope}) {
 const selected=Array.isArray(selectedVehicles)?selectedVehicles.map(vehicle):[];
 if(!selected.length||selected.some(value=>!value)||new Set(selected).size!==selected.length||!Array.isArray(rows))throw Error('SELECTION_REQUIRED');
 const fixed=scope.basis==='FIXED';
 if(!fixed&&rows.some(row=>row?.deliveryDate!==scope.date))throw Error('DATE_UNVERIFIED');
 const routes=new Map(selected.map(label=>[label,[]]));
 for(const row of rows) {
  if(!row||centerOf(row,fixed)!==scope.center)continue;
  const labels=fixed?[vehicle(row.baseVehicle)]:new Set([vehicle(row.vehicle),vehicle(row.confirmedVehicle)]);
  for(const label of labels)routes.get(label)?.push(row);
 }
 return selected.map(selectedVehicle=>{
  const source=routes.get(selectedVehicle);
  const result=buildVehiclePrintModel({...scope,selectedVehicle,rows:source});
  const expected=new Set(source.map(row=>text(row.customerCode||row.code)));
  if(!result.stores.length||result.stores.length!==expected.size)
   throw Object.assign(Error('BATCH_INCOMPLETE'),{vehicle:selectedVehicle});
  return result;
 });
}

const css=`
#vehiclePrintButton{white-space:nowrap;flex:none}
#vehiclePrintDialog{width:min(1120px,calc(100vw - 24px));max-width:1120px;max-height:calc(100dvh - 24px);box-sizing:border-box;padding:18px;border:1px solid #cbd5e1;border-radius:12px;color:#172033;background:white;overflow:auto;box-shadow:0 12px 70px #0005}
#vehiclePrintDialog::backdrop{background:#0f172a80}
#vehiclePrintDialog .print-controls{display:flex;flex-wrap:wrap;align-items:end;gap:10px;margin-bottom:12px}
#vehiclePrintDialog label{display:grid;gap:4px;font-size:12px}#vehiclePrintDialog select,#vehiclePrintDialog input,#vehiclePrintDialog button{min-height:36px;box-sizing:border-box;font:inherit;padding:6px;border:1px solid #cbd5e1;border-radius:6px;background:white;color:inherit}
#vehiclePrintDialog .print-controls select{max-width:200px}#vehiclePrintDialog button{cursor:pointer}#vehiclePrintDialog button:disabled{opacity:.5;cursor:default}
#vehiclePrintDialog .print-controls [hidden],#vehiclePrintBatchVehicles[hidden]{display:none}
#vehiclePrintBatchVehicles{border:1px solid #cbd5e1;border-radius:6px;margin:0 0 12px;padding:6px 10px 10px}
#vehiclePrintBatchVehicles legend{font-size:12px}
#vehiclePrintDialog .print-vehicle-choices{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:4px 12px;max-height:148px;overflow:auto}
#vehiclePrintDialog .print-vehicle-choices label{display:flex;align-items:center;gap:6px;min-height:32px}
#vehiclePrintDialog .print-vehicle-choices input{width:16px;min-height:0;margin:0}
#vehiclePrintPreview .print-vehicle+.print-vehicle{margin-top:18px;padding-top:8px;border-top:1px solid #cbd5e1}
#vehiclePrintDialog h2{font-size:21px;margin:10px 0}#vehiclePrintDialog p{font-size:12px;line-height:1.5;margin:7px 0;overflow-wrap:anywhere}
#vehiclePrintDialog .print-map{height:360px;position:relative;overflow:hidden;background:#eef2f6;border:1px solid #b9c6d4;break-inside:avoid}
#vehiclePrintDialog .print-map svg{width:100%;height:100%}#vehiclePrintDialog .print-map-note{font-size:11px;color:#475569}
#vehiclePrintDialog table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px;table-layout:fixed}#vehiclePrintDialog th,#vehiclePrintDialog td{border:1px solid #cbd5e1;padding:6px;text-align:left;overflow-wrap:anywhere}#vehiclePrintDialog th{background:#eef2f6}#vehiclePrintDialog th:first-child{width:30px}#vehiclePrintDialog th:nth-child(2){width:56px}#vehiclePrintDialog th:nth-child(3){width:85px}#vehiclePrintDialog th:nth-child(4){width:23%}#vehiclePrintDialog tr{break-inside:avoid}#vehiclePrintDialog thead{display:table-header-group}
#vehiclePrintDialog .print-route-header{display:none}
#vehiclePrintDialog .print-vehicle-cols col:first-child{width:42px}
#vehiclePrintDialog .print-vehicle-cols col:nth-child(2){width:68px}
#vehiclePrintDialog .print-vehicle-cols col:nth-child(3){width:97px}
#vehiclePrintDialog .print-vehicle-cols col:nth-child(4){width:23%}
#vehiclePrintStatus{min-height:18px}#vehiclePrintPreview[hidden]{display:none}
@media(max-width:600px){#vehiclePrintDialog{padding:10px}#vehiclePrintDialog .print-controls{gap:7px}#vehiclePrintDialog label{flex:1 1 130px;min-width:0}#vehiclePrintDialog label>*{width:100%;min-width:0}#vehiclePrintDialog .print-map{height:280px}#vehiclePrintDialog table{font-size:10px}#vehiclePrintDialog th:first-child{width:20px}#vehiclePrintDialog th:nth-child(2){width:36px}#vehiclePrintDialog th:nth-child(3){width:56px}#vehiclePrintDialog td,#vehiclePrintDialog th{padding:4px}}
@page{size:A4 landscape;margin:10mm}
@media print{body:has(>#vehiclePrintDialog[open]):not(.map-vehicle-printing)>*{display:none!important}body.map-vehicle-printing{display:block!important;overflow:visible!important;height:auto!important;margin:0!important;background:white!important}body.map-vehicle-printing>:not(#vehiclePrintDialog){display:none!important}body.map-vehicle-printing #vehiclePrintDialog{display:block!important;position:static!important;width:auto!important;max-width:none!important;height:auto!important;max-height:none!important;overflow:visible!important;border:0!important;border-radius:0!important;box-shadow:none!important;padding:0!important;margin:0!important}#vehiclePrintDialog::backdrop{display:none}#vehiclePrintDialog .print-controls,#vehiclePrintBatchVehicles,#vehiclePrintStatus{display:none!important}#vehiclePrintDialog .print-map{height:105mm}#vehiclePrintPreview .print-vehicle+.print-vehicle{break-before:page;margin:0;padding:0;border:0}#vehiclePrintDialog h2{font-size:18px}#vehiclePrintDialog p{font-size:10px}#vehiclePrintDialog table{font-size:10px}#vehiclePrintDialog th,#vehiclePrintDialog td{padding:4px}#vehiclePrintDialog *{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
@media print{#vehiclePrintDialog .print-route-header{display:table-row}#vehiclePrintDialog .print-route-header th{width:auto;background:white}#vehiclePrintDialog .print-vehicle-batch :is(th,td){padding:3px 4px}}
`;

export function mountVehiclePrintUi({win=window,doc=document,bridge=win.MapUiLocalBridge}={}){
 if(!bridge||doc.getElementById('vehiclePrintDialog'))return null;
 const make=(tag,content,parent)=>{const node=doc.createElement(tag);if(content!==undefined)node.textContent=content;parent?.append(node);return node;};
 const style=make('style',css,doc.head),trigger=make('button','호차별 인쇄',doc.querySelector('#sourceFooterLinks')||doc.querySelector('#mapDateBar')||doc.querySelector('#mapModeBar'));trigger.id='vehiclePrintButton';trigger.type='button';
 const dialog=make('dialog',undefined,doc.body);dialog.id='vehiclePrintDialog';dialog.setAttribute('aria-label','호차별 지도 인쇄 미리보기');
 const controls=make('div',undefined,dialog);controls.className='print-controls';
 const field=(label,tag,id)=>{const wrap=make('label',label,controls),node=make(tag,undefined,wrap);node.id=id;return node;};
 const basis=field('출력 기준','select','vehiclePrintBasis');for(const [v,l] of [['FIXED','현재 기준호차'],['DATED','일자별 저장 배차']]){const o=make('option',l,basis);o.value=v;}
 const mode=field('인쇄 범위','select','vehiclePrintMode');
 for(const [value,label] of [['single','개별 호차'],['batch','여러 호차']])make('option',label,mode).value=value;
 const date=field('기준일 / 배송일','input','vehiclePrintDate');date.type='date';date.max=today();
 const center=field('센터','select','vehiclePrintCenter');for(const [v,l] of Object.entries(PRINT_CENTERS)){const o=make('option',l,center);o.value=v;}
 const car=field('호차','select','vehiclePrintVehicle');
 const loadBatch=make('button','호차 목록 불러오기',controls);loadBatch.type='button';loadBatch.hidden=true;
 const preview=make('button','미리보기',controls),print=make('button','인쇄 / PDF 저장',controls),close=make('button','닫기',controls);for(const b of [preview,print,close])b.type='button';print.disabled=true;
 const batchFields=make('fieldset',undefined,dialog);batchFields.id='vehiclePrintBatchVehicles';batchFields.hidden=true;
 make('legend','인쇄할 호차',batchFields);
 const batchChoices=make('div',undefined,batchFields);batchChoices.className='print-vehicle-choices';
 const status=make('p','센터와 호차를 선택한 뒤 미리보기를 눌러 주세요.',dialog);status.id='vehiclePrintStatus';status.setAttribute('role','status');
 const section=make('section',undefined,dialog);section.id='vehiclePrintPreview';section.hidden=true;
 let epoch=0,controller=null,models=[],batchData=null,printTitle=null;
 const activeMaps=new Set();
 const isBatch=()=>mode.value==='batch';
 const checkedVehicles=()=>[...batchChoices.querySelectorAll('input:checked')].map(input=>input.value);
 const syncBatchControls=()=>{
  car.parentElement.hidden=isBatch();
  loadBatch.hidden=!isBatch();
  loadBatch.disabled=Boolean(batchData)||Boolean(controller);
  batchFields.hidden=!isBatch()||!batchData;
  preview.disabled=Boolean(controller)||isBatch()&&(!batchData||!checkedVehicles().length);
 };
 const resetBatch=()=>{batchData=null;batchChoices.replaceChildren();};
 const cancel=()=>{
  epoch++;
  controller?.abort();controller=null;
  print.disabled=true;models=[];
  for(const clear of activeMaps)clear();
  section.replaceChildren();section.hidden=true;
 };
 const restore=()=>{doc.body.classList.remove('map-vehicle-printing');if(printTitle!==null){doc.title=printTitle;printTitle=null;}};
 const refreshCars=()=>{
  const old=car.value,wanted=bridge.state.selectedVehicles?.length===1?vehicle(bridge.state.selectedVehicles[0]):'',fixed=bridge.fixedTerritoryStores?.()||[];
  const daily=basis.value==='DATED'?(bridge.stores?.()||[]).map(row=>row.raw||row).filter(row=>row.deliveryDate===date.value):[];
  const centerKey=center.value;
  const broadScope=!centerKey||centerKey===PRINT_UNPROVIDED_CENTER;
  const master=bridge.fixedTerritoryMasterState?.();
  const fixedVehicles=fixed.filter(row=>broadScope?verifiedFixed(row,master):centerOf(row,true)===centerKey).map(row=>vehicle(row.baseVehicle));
  const datedVehicles=daily.filter(row=>!centerKey||centerOf(row,false)===centerKey).map(row=>vehicle(row.confirmedVehicle||row.vehicle));
  const currentVehicle=basis.value==='DATED'&&date.value===bridge.state.selectedDate?wanted:'';
  const values=[...new Set([...fixedVehicles,...datedVehicles,currentVehicle].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}));
  car.replaceChildren();const blank=make('option','호차를 선택하세요',car);blank.value='';for(const v of values){const o=make('option',v+'호차',car);o.value=v;}car.value=values.includes(old)?old:values.includes(wanted)?wanted:'';
 };
 const syncCenterOptions=()=>{
  const existing=center.querySelector('option[value="'+PRINT_UNPROVIDED_CENTER+'"]');
  if(basis.value==='DATED'){
   if(!existing){const option=make('option',unprovidedCenterLabel,center);option.value=PRINT_UNPROVIDED_CENTER;}
   if(!center.querySelector('option[value=""]')){const blank=make('option','센터를 선택하세요');blank.value='';center.prepend(blank);}
  }
  else{
   const selected=center.value;
   existing?.remove();center.querySelector('option[value=""]')?.remove();
   center.value=PRINT_CENTERS[selected]?selected:PRINT_CENTERS[bridge.state.centerFilter]?bridge.state.centerFilter:'osan';
  }
 };
 const drawCoordinatePlot=(host,data,points,note)=>{
  const ns='http://www.w3.org/2000/svg',svg=doc.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 1000 340');svg.setAttribute('role','img');svg.setAttribute('aria-label','선택 호차 매장 좌표 분포도');host.append(svg);
  const south=Math.min(...points.map(r=>r.lat)),north=Math.max(...points.map(r=>r.lat)),west=Math.min(...points.map(r=>r.lng)),east=Math.max(...points.map(r=>r.lng));
  for(const [i,row] of data.stores.entries()){if(row.lat===null)continue;const x=east===west?500:40+(row.lng-west)/(east-west)*920,y=north===south?170:300-(row.lat-south)/(north-south)*260,c=doc.createElementNS(ns,'circle'),t=doc.createElementNS(ns,'text');c.setAttribute('cx',x);c.setAttribute('cy',y);c.setAttribute('r','10');c.setAttribute('fill','#1d4ed8');t.setAttribute('x',x+12);t.setAttribute('y',y+4);t.setAttribute('font-size','13');t.textContent=String(i+1);svg.append(c,t);}
  note.textContent='좌표 분포도 · 배경 지도 연결 안 됨 · 핀 번호는 목록 번호입니다. 저장 방문 순서는 별도 열을 확인해 주세요. 거리·도로 경로를 나타내지 않습니다.';
 };
 const drawMap=(host,data,note,batch,onReady)=>{
  const points=data.stores.filter(row=>row.lat!==null);
  if(!points.length){
   make('p','검증된 위치가 있는 매장이 없습니다. 주소는 아래 목록을 확인해 주세요.',host);
   note.textContent='위치 미확인 매장은 임의 좌표에 표시하지 않습니다.';
   onReady();return;
  }
  const sdk=win.kakao?.maps;
  if(sdk?.Map&&sdk?.CustomOverlay&&sdk?.LatLngBounds&&sdk?.event){
   let map,timer,loaded=false;
   const markers=[];
   const settle=(listOnly=false)=>{
    if(loaded)return;
    loaded=true;win.clearTimeout(timer);onReady(listOnly);
   };
   const tilesReady=()=>settle();
   const clear=()=>{
    activeMaps.delete(clear);win.clearTimeout(timer);
    if(map)sdk.event.removeListener(map,'tilesloaded',tilesReady);
    for(const marker of markers)marker.setMap(null);
   };
   activeMaps.add(clear);
   try{
    map=new sdk.Map(host,{center:new sdk.LatLng(points[0].lat,points[0].lng),level:8,draggable:false,scrollwheel:false,disableDoubleClickZoom:true});
    const bounds=new sdk.LatLngBounds();
    for(const [i,row] of data.stores.entries()){
     if(row.lat===null)continue;
     const point=new sdk.LatLng(row.lat,row.lng);bounds.extend(point);
     const pin=make('span',String(i+1));pin.style.cssText='display:block;min-width:24px;padding:4px 5px;border:2px solid white;border-radius:20px;background:#1d4ed8;color:white;text-align:center;font-weight:bold;font-size:12px;box-shadow:0 1px 4px #0006';
     pin.title=row.customerCode+' '+row.customerName;
     markers.push(new sdk.CustomOverlay({map,position:point,content:pin,yAnchor:1}));
    }
    note.textContent='선택 호차 매장 위치 · 핀 번호는 목록 번호입니다. 저장 방문 순서는 별도 열을 확인해 주세요. 도로 경로는 조회하지 않습니다.';
    sdk.event.addListener(map,'tilesloaded',tilesReady);
    timer=win.setTimeout(()=>{
     if(batch){clear();host.replaceChildren();drawCoordinatePlot(host,data,points,note);}
     settle(!batch);
    },4000);
    map.setBounds(bounds,35,35,35,35);
    return;
   }catch{clear();host.replaceChildren();}
  }
  drawCoordinatePlot(host,data,points,note);onReady();
 };
 const render=(data,batch,onReady)=>{
  const page=make('article',undefined,section);
  page.className=batch?'print-vehicle print-vehicle-batch':'print-vehicle';page.dataset.vehicle=data.vehicle;
  const routeTitle=data.centerName+(data.center===PRINT_UNPROVIDED_CENTER?'':'센터')+' '+data.vehicle+'호차';
  make('h2',routeTitle+' 지도·매장 목록',page);
  make('p','기준일 '+data.date+' · '+data.basisLabel+' · 매장 '+data.stores.length+'곳 · 위치 '+data.locatedCount+'곳 / 미확인 '+data.unlocatedCount+'곳',page);
  make('p',data.note+(data.checkedAt?' 기준호차 확인시각 '+data.checkedAt+(data.stale?' · 이전 확인값, 현재 기준 미확인':''):'')+' 주소·매장명은 현재 확인된 매장정보를 포함합니다.',page);
  const host=make('div',undefined,page);host.className='print-map';const note=make('p','지도 준비 중',page);note.className='print-map-note';
  make('p','일부 주소 위치 © OpenStreetMap contributors · https://www.openstreetmap.org/copyright',page);
  const table=make('table',undefined,page);
  if(batch){
   const columns=make('colgroup',undefined,table);columns.className='print-vehicle-cols';
   for(let i=0;i<5;i++)make('col',undefined,columns);
  }
  const head=make('thead',undefined,table);
  if(batch){
   const routeHeader=make('tr',undefined,head);routeHeader.className='print-route-header';
   make('th',routeTitle+' · '+data.date,routeHeader).colSpan=5;
  }
  const hr=make('tr',undefined,head);
  for(const value of ['목록','방문 순서','고객코드','매장명','주소'])make('th',value,hr);
  const body=make('tbody',undefined,table);for(const [i,row] of data.stores.entries()){const tr=make('tr',undefined,body);for(const v of [i+1,row.order??'미확정',row.customerCode,row.customerName||'매장명 미확인',row.address||'주소 미확인'])make('td',v,tr);}
  drawMap(host,data,note,batch,onReady);
 };
 const readData=async(selection,signal)=>{
  if(selection.basis==='FIXED'){
   if(!bridge.fixedTerritoryMasterState?.()?.version)await bridge.refreshFixedTerritoryMaster?.();
   if(signal.aborted)throw new DOMException('Print scope changed','AbortError');
   const master=bridge.fixedTerritoryMasterState?.();
   if(!master?.version||!Number.isFinite(Date.parse(master.checkedAt)))throw Error('MASTER_UNVERIFIED');
   return {rows:bridge.fixedTerritoryStores?.()||[],master};
  }
  const response=await win.fetch('/api/map-phase2b/preview/assignments?date='+encodeURIComponent(selection.date),{
   credentials:'same-origin',cache:'no-store',signal,headers:{Accept:'application/json'}
  });
  if(!response.ok)throw Error(response.status===401||response.status===403?'AUTH_REQUIRED':'SOURCE_UNAVAILABLE');
  const rows=validateDatedPrintResponse(await response.json(),selection.date);
  return {rows:mergeDatedPrintCoordinates(rows,bridge.printCoordinateStores?.()||bridge.navigationStores?.('BASE_60D')||[])};
 };
 const showBatchVehicles=(selection,data)=>{
  const fixed=selection.basis==='FIXED',available=new Set();
  for(const row of data.rows){
   if(centerOf(row,fixed)!==selection.center||fixed&&!verifiedFixed(row,data.master))continue;
   const label=vehicle(fixed?row.baseVehicle:row.confirmedVehicle||row.vehicle);
   if(label&&label.length<=64)available.add(label);
  }
  if(!available.size)throw Error('EMPTY');
  batchData={...selection,...data};
  const previous=new Set((bridge.state.selectedVehicles||[]).map(vehicle));
  for(const label of [...available].sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}))){
   const item=make('label',undefined,batchChoices);
   const check=make('input',undefined,item);check.type='checkbox';check.value=label;check.checked=previous.has(label);
   make('span',label+'호차',item);
  }
  status.textContent='인쇄할 호차를 선택한 뒤 미리보기를 눌러 주세요.';
 };
 const present=(next,id,batch)=>{
  models=next;section.hidden=false;
  status.textContent=batch?'호차별 인쇄 페이지를 준비하고 있습니다.':'선택 호차 '+models[0].stores.length+'곳 · 미리보기를 확인해 주세요.';
  let remaining=next.length;
  const ready=listOnly=>{
   if(id!==epoch||!dialog.open||--remaining)return;
   print.disabled=false;
   status.textContent=batch?next.length+'개 호차 미리보기가 준비됐습니다. 인쇄 창에서 A4 가로 또는 PDF 저장을 선택하세요.':
    listOnly?'목록 인쇄가 준비됐습니다. 배경 지도가 보이는지 확인한 뒤 인쇄해 주세요.':
     '미리보기가 준비됐습니다. 인쇄 창에서 A4 가로 또는 PDF 저장을 선택하세요.';
  };
  for(const item of next)render(item,batch,ready);
 };
 const run=async(listOnly)=>{
  cancel();
  if(listOnly)resetBatch();
  const id=epoch,batch=isBatch();
  const selection={basis:basis.value,date:date.value,center:center.value};
  const ownController=new AbortController();controller=ownController;
  syncBatchControls();
  status.textContent=listOnly?'선택한 날짜와 센터의 호차를 확인하는 중입니다.':'선택 호차 자료를 확인하는 중입니다.';
  const timeout=win.setTimeout(()=>ownController.abort(),45000);
  try{
   if(!validPrintDate(selection.date)||selection.date>today()||!selection.center||!batch&&!car.value)
    throw Error('SELECTION_REQUIRED');
   const data=batch&&!listOnly?batchData:await readData(selection,ownController.signal);
   if(id!==epoch||!dialog.open)return;
   if(listOnly){showBatchVehicles(selection,data);return;}
   if(batch){
    if(!data||Object.keys(selection).some(key=>data[key]!==selection[key]))throw Error('SELECTION_REQUIRED');
    present(buildVehiclePrintBatch({...selection,...data,selectedVehicles:checkedVehicles()}),id,true);
   }else{
    const single=buildVehiclePrintModel({...selection,...data,selectedVehicle:car.value});
    if(!single.stores.length)throw Error('EMPTY');
    present([single],id,false);
   }
  }catch(error){
   if(id!==epoch)return;
   cancel();
   if(listOnly)resetBatch();
   status.textContent=({
    AUTH_REQUIRED:'직원 로그인을 확인한 뒤 다시 조회해 주세요.',
    DATE_UNVERIFIED:'선택일 전체 배차의 날짜·완전성을 확인하지 못했습니다.',
    MASTER_UNVERIFIED:'검증된 기준호차 자료를 먼저 불러와 주세요.',
    SELECTION_REQUIRED:'유효한 날짜·센터·호차를 선택해 주세요.',
    EMPTY:'선택 센터·호차에 검증된 매장이 없습니다. 해당일 센터정보도 확인해 주세요.',
    BATCH_INCOMPLETE:error.vehicle+'호차 자료를 확인하지 못했습니다. 선택을 확인해 주세요.',
    SOURCE_UNAVAILABLE:'선택일 자료를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.'
   })[error.message]||(error.name==='AbortError'?'조회 시간이 초과됐거나 취소되었습니다.':'인쇄 자료를 확인하지 못했습니다.');
  }finally{
   win.clearTimeout(timeout);
   if(controller===ownController)controller=null;
   syncBatchControls();
  }
 };
 const dismiss=()=>{cancel();resetBatch();restore();dialog.close();};
 trigger.onclick=()=>{
  cancel();resetBatch();mode.value='single';basis.value=bridge.state.mode==='DATE_ROUTE'?'DATED':'FIXED';
  date.value=validPrintDate(bridge.state.selectedDate)&&basis.value==='DATED'?bridge.state.selectedDate:today();
  syncCenterOptions();
  const selectedVehicle=bridge.state.selectedVehicles?.length===1?bridge.state.selectedVehicles[0]:'';
  center.value=basis.value==='DATED'?datedPrintCenter({center:bridge.state.centerFilter,date:date.value,selectedVehicle,rows:bridge.stores?.()||[]}):
   PRINT_CENTERS[bridge.state.centerFilter]?bridge.state.centerFilter:'osan';
  car.value='';refreshCars();syncBatchControls();status.textContent='센터와 호차를 선택한 뒤 미리보기를 눌러 주세요.';dialog.showModal();
 };
 for(const control of [basis,mode,date,center,car])control.onchange=()=>{
  cancel();resetBatch();
  if(control===basis)syncCenterOptions();
  if(control!==car)refreshCars();
  syncBatchControls();
  status.textContent=isBatch()?'날짜와 센터를 선택한 뒤 호차 목록을 불러오세요.':'조건이 변경되었습니다. 미리보기를 다시 눌러 주세요.';
 };
 batchChoices.onchange=()=>{
  cancel();syncBatchControls();
  status.textContent='호차 선택이 변경되었습니다. 미리보기를 다시 눌러 주세요.';
 };
 loadBatch.onclick=()=>void run(true);
 preview.onclick=()=>void run(false);close.onclick=dismiss;dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
 const preparePrint=()=>{
  if(!models.length||print.disabled||!dialog.open)return false;
  if(printTitle===null)printTitle=doc.title;
  const first=models[0];
  const label=models.length===1?first.vehicle+'호차':'일괄_'+models.length+'호차';
  doc.title=`${first.date}_${first.centerName}_${label}`;doc.body.classList.add('map-vehicle-printing');return true;
 };
 print.onclick=()=>{if(!preparePrint())return;try{win.print();}finally{restore();}};
 win.addEventListener('beforeprint',preparePrint);
 win.addEventListener('afterprint',restore);
 const unregister=win.MapStaffEntry?.registerPurge?.(()=>{cancel();resetBatch();restore();if(dialog.open)dialog.close();});
 return {open:()=>trigger.click(),dispose(){cancel();resetBatch();restore();unregister?.();win.removeEventListener('beforeprint',preparePrint);win.removeEventListener('afterprint',restore);trigger.remove();dialog.remove();style.remove();}};
}

if(typeof window!=='undefined'&&typeof document!=='undefined')window.MapVehiclePrintUi=mountVehiclePrintUi();
