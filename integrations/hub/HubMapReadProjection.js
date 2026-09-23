/** Read-only, allowlisted operational metadata. Never fetches external collectors. */
function hubMapCollectionStatus_(){
  const sh=SpreadsheetApp.openById(HUB_DEFAULT_SOURCE_ID).getSheetByName('복구현황');
  if(!sh)return {freshon:null,delivery:null,completedAt:null,checkedAt:null,proof:'DASHBOARD_UNAVAILABLE'};
  const rows=sh.getRange(55,1,14,2).getDisplayValues(),values={};
  rows.forEach(function(r){values[String(r[0])]=String(r[1]||'');});
  function date(key){const value=values[key]||'';return /^\d{4}-\d{2}-\d{2}$/.test(value)?value:null;}
  return {freshon:date('Freshon 최근 완료일'),delivery:date('Delivery 최근 완료일'),completedAt:values['마지막 수집 완료 시각']||null,
    checkedAt:values['수집 진단 갱신']||null,proof:'EXISTING_CUSTOMER_COMPLETION_DASHBOARD'};
}
function hubMapBaseVehicleProjection_(params){
  hubMapHttpValidateOnlyKeys_(params,[]);
  const sh=SpreadsheetApp.openById(HUB_DEFAULT_SOURCE_ID).getSheetByName('delivery_admin_raw');
  if(!sh)throw new Error('MODEL_BASE_SOURCE_UNAVAILABLE');
  const last=sh.getLastRow(),width=sh.getLastColumn();if(width<1||width>64)throw new Error('MODEL_BASE_SOURCE_CONTRACT');
  const headers=sh.getRange(1,1,1,width).getValues()[0].map(String);
  const names=['deliveryDate','customerCode','baseVehicle'],cols=names.map(function(n){return headers.indexOf(n);});
  if(cols.some(function(c){return c<0;})||last>150000)throw new Error('MODEL_BASE_SOURCE_CONTRACT');
  const deadline=Date.now()+210000,byCode={};let latest='';
  for(let start=2;start<=last;start+=1000){
    if(Date.now()>deadline)throw new Error('MODEL_BASE_SOURCE_TIMEOUT');
    const count=Math.min(1000,last-start+1),values=hubStageModelReadColumns_({id:HUB_DEFAULT_SOURCE_ID},sh,headers,start,count,names);
    for(let i=0;i<count;i++){
      const date=hubStaffDetailDate_(values[i].deliveryDate),code=String(values[i].customerCode||'').trim(),base=String(values[i].baseVehicle||'').trim().replace(/호(?:차)?$/,'');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^[A-Z]\d+$/.test(code))continue;
      if(date>latest)latest=date;
      const previous=byCode[code];
      if(!previous||date>previous.baseVehicleDate)byCode[code]={customerCode:code,baseVehicle:base,baseVehicleDate:date,baseVehicleSource:'Delivery.carrier.basedNo → Customer.delivery_admin_raw',baseVehicleState:base?'VERIFIED_STORED':'UNKNOWN'};
      else if(date===previous.baseVehicleDate&&base!==previous.baseVehicle){previous.baseVehicle='';previous.baseVehicleState='CONFLICT';}
    }
  }
  if(sh.getLastRow()!==last||sh.getLastColumn()!==width)throw new Error('MODEL_BASE_SOURCE_CHANGED');
  return {data:Object.keys(byCode).sort().map(function(k){return byCode[k];}),cached:false,meta:{source:'Customer.delivery_admin_raw',sourceLatest:latest,scope:'CURRENT_STORED_ROWS',temporalBasis:'LATEST_STORED_PER_CUSTOMER_NOT_HISTORICAL_OVERRIDE',complete:false,readOnly:true}};
}
