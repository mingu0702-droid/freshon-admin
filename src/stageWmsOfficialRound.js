import {freshonWmsVehicle} from './stageFreshonWmsDispatch.js';
import {isStageWmsDay,stageWmsError} from './stageWmsExportIndex.js';

export const WMS_OFFICIAL_ROUND_SOURCE='WMS_CONFIRMED_DISPATCH_OFFICIAL_ROUND';

const warehouse='011';
const rowLimit=10000;
const customerPattern=/^[A-Z]\d{1,20}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const fail=reason=>{throw stageWmsError('WMS_EXPORT_OFFICIAL_'+reason);};
const text=value=>typeof value==='string'||Number.isSafeInteger(value)?String(value).trim():'';
const known=value=>/^(?:null|undefined)$/i.test(text(value))?'':text(value);
const compare=(a,b)=>a<b?-1:a>b?1:0;
const sameDay=(value,date)=>/^\d{8}$|^\d{4}[-.]\d\d[-.]\d\d$/.test(text(value))&&text(value).replace(/[-.]/g,'')===date.replaceAll('-','');
const isWarehouse=value=>text(value).padStart(3,'0')===warehouse;
const roundIdPattern=/^[a-f0-9]{8}(?:[a-f0-9]{24}|(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?$/i;

function money(value) {
  const str=text(value);
  const amount=Number(str.replaceAll(',',''));
  if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(str)||!Number.isSafeInteger(amount))fail('AMOUNT');
  return amount;
}

function sum(a,b) {
  const result=a+b;
  if(!Number.isSafeInteger(result))fail('AMOUNT');
  return result;
}

function route(value) {
  const normalized=known(value);
  const special=normalized.replace(/\s+/g,'').match(/^(용|척|임시)(\d{1,2})$/);
  if(special&&!(special[1]==='임시'&&Number(special[2])===0))
    return special[1]+special[2].padStart(2,'0');
  return freshonWmsVehicle(normalized);
}

function identifier(value) {
  const id=known(value);
  if(id&&!/^[A-Za-z0-9_.:-]{1,90}$/.test(id))fail('IDENTIFIER');
  return id;
}

function capture(part,date) {
  if(!part||part.date!==date||part.warehouse!==warehouse||typeof part.roundId!=='string'||
    !roundIdPattern.test(part.roundId)||
    typeof part.observedAt!=='string'||part.observedAt.length>35||!Number.isFinite(Date.parse(part.observedAt))||
    !Array.isArray(part.rows)||part.rows.length>=rowLimit)fail('SCOPE');
  return {date,warehouse,roundId:part.roundId,observedAt:new Date(part.observedAt).toISOString()};
}

function planRows(rows,date) {
  return rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||
      (known(row.WH_CD)&&!isWarehouse(row.WH_CD))||
      (known(row.DLVRY_DATE)&&!sameDay(row.DLVRY_DATE,date)))fail('PLAN_SCOPE');
    const DISPATCH_NO=identifier(row.DISPATCH_NO), DISPATCH_YN=text(row.DISPATCH_YN);
    const ROUTE_NM=route(row.ROUTE_NM||row.VEHICLE_NO||row.ROUTE_CD), SELL_AMT=money(row.SELL_AMT);
    if(DISPATCH_YN==='N'&&!DISPATCH_NO&&ROUTE_NM==='미배정')return {ROUTE_NM,SELL_AMT,DISPATCH_YN};
    const STOP_LOC_CNT=money(row.STOP_LOC_CNT),ROUTE_CD=identifier(row.ROUTE_CD);
    if(!DISPATCH_NO||ROUTE_NM==='미배정'||STOP_LOC_CNT<0)fail('PLAN');
    return {DISPATCH_NO,ROUTE_NM,ROUTE_CD,SELL_AMT,STOP_LOC_CNT};
  }).sort((a,b)=>compare(a.DISPATCH_NO||'',b.DISPATCH_NO||''));
}

function dispatchRows(rows,date) {
  return rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||!isWarehouse(row.WH_CD)||
      !sameDay(row.DLVRY_DATE,date))fail('DETAIL_SCOPE');
    const DLVRY_NO=identifier(row.DLVRY_NO), CUST_CD=text(row.CUST_CD), CUST_NM=text(row.CUST_NM);
    if(!DLVRY_NO||!customerPattern.test(CUST_CD)||CUST_NM.length>200||/[\x00-\x1f]/.test(CUST_NM)||
      (row.addressHash!=null&&(typeof row.addressHash!=='string'||!digestPattern.test(row.addressHash))))fail('DETAIL');
    return {DLVRY_NO,CUST_CD,CUST_NM,addressHash:row.addressHash??null,WH_CD:warehouse,DLVRY_DATE:date,
      SELL_AMT:money(row.SELL_AMT),DISPATCH_YN:text(row.DISPATCH_YN),DISPATCH_NO:identifier(row.DISPATCH_NO),
      ROUTE_NM:known(row.ROUTE_NM),ROUTE_CD_ORG:known(row.ROUTE_CD_ORG),ROUTE_CD:known(row.ROUTE_CD)};
  }).sort((a,b)=>compare(a.DLVRY_NO,b.DLVRY_NO));
}

function reconcile({date,observedAt,plans,dispatch}) {
  const byDispatch=new Map(),byRoute=new Map(),byCode=new Map();
  let unassignedPlanAmount=null;
  for(const row of plans){
    const {DISPATCH_NO,ROUTE_NM,ROUTE_CD,SELL_AMT,STOP_LOC_CNT}=row;
    if(!DISPATCH_NO){
      if(unassignedPlanAmount!==null)fail('DUPLICATE_PLAN');
      unassignedPlanAmount=SELL_AMT;
      continue;
    }
    if(byDispatch.has(DISPATCH_NO)||byRoute.has(ROUTE_NM))fail('DUPLICATE_PLAN');
    const group={vehicle:ROUTE_NM,amount:SELL_AMT,waypointCount:STOP_LOC_CNT,deliveryCount:0,detailTotal:0,details:new Map()};
    byDispatch.set(DISPATCH_NO,group);
    byRoute.set(ROUTE_NM,group);
    if(ROUTE_CD)byCode.set(ROUTE_CD,byCode.has(ROUTE_CD)?null:group);
  }
  const unassigned={vehicle:'미배정',amount:0,waypointCount:null,deliveryCount:0,detailTotal:0,details:new Map()};
  const seen=new Set();
  for(const row of dispatch){
    if(seen.has(row.DLVRY_NO))fail('DUPLICATE_DELIVERY');
    seen.add(row.DLVRY_NO);
    let group;
    if(row.DISPATCH_YN==='N'&&!row.DISPATCH_NO&&!row.ROUTE_NM&&!row.ROUTE_CD_ORG&&!row.ROUTE_CD)group=unassigned;
    else if(row.DISPATCH_YN==='Y'&&row.DISPATCH_NO){
      group=byDispatch.get(row.DISPATCH_NO);
      const confirmed=row.ROUTE_CD_ORG;
      const byLabel=confirmed&&/^[0-9가-힣 -]{1,24}$/.test(confirmed)?byRoute.get(route(confirmed)):null;
      const assigned=confirmed&&(byLabel||byCode.get(confirmed));
      if(!group||(!confirmed&&!row.ROUTE_NM)||(confirmed&&assigned!==group)||
        (row.ROUTE_NM&&route(row.ROUTE_NM)!==group.vehicle))fail('DISPATCH_MATCH');
    }else fail('DISPATCH_MATCH');
    const {CUST_CD:customerCode,CUST_NM:customerName,addressHash,SELL_AMT:amount}=row;
    const detail=group.details.get(customerCode);
    if(detail&&(detail.addressHash!==addressHash||detail.customerName!==customerName))fail('CUSTOMER_MATCH');
    group.details.set(customerCode,{customerCode,customerName,addressHash,amount:sum(detail?.amount??0,amount)});
    group.deliveryCount++;
    group.detailTotal=sum(group.detailTotal,amount);
  }

  if(unassignedPlanAmount!==null&&unassignedPlanAmount!==unassigned.detailTotal)fail('AMOUNT_MATCH');
  unassigned.amount=unassigned.detailTotal;
  let amount=0,detailAmount=0;
  const groups=[...byRoute.values()].sort((a,b)=>compare(a.vehicle,b.vehicle));
  if(unassigned.deliveryCount)groups.push(unassigned);
  for(const group of groups){
    const {vehicle,waypointCount,details,amount:sales,detailTotal}=group;
    if(vehicle!=='미배정'&&waypointCount!==details.size)fail('STOP_MATCH');
    if((!group.deliveryCount&&sales!==detailTotal)||Math.abs(sales-detailTotal)>10)fail('AMOUNT_MATCH');
    amount=sum(amount,sales);
    detailAmount=sum(detailAmount,detailTotal);
  }
  if(Math.abs(amount-detailAmount)>10)fail('AMOUNT_MATCH');
  const vehicles=groups.map(({details,...group})=>({...group,difference:group.amount-group.detailTotal,details:[...details.values()]}));
  return {date,observedAt,source:WMS_OFFICIAL_ROUND_SOURCE,center:'osan',sourceComplete:true,
    total:amount,deliveryCount:dispatch.length,vehicles};
}

// Each half carries the same metadata from one GAS fetchAll wave. The
// authorized adapter assigns it only after swfRows_/swfReport_ validate both
// WMS responses. The dispatch addressHash is optional evidence from that wave.
function normalizeRound(round,date) {
  const {plan,dispatch}=round??{};
  if(!isStageWmsDay(date))fail('SCOPE');
  const scope=capture(plan,date), detailScope=capture(dispatch,date);
  if(scope.roundId!==detailScope.roundId||scope.observedAt!==detailScope.observedAt)fail('ROUND_MISMATCH');
  return {schema:1,source:WMS_OFFICIAL_ROUND_SOURCE,...scope,
    plans:planRows(plan.rows,date),dispatch:dispatchRows(dispatch.rows,date)};
}

export function encodeWmsOfficialRound(round,date) {
  const pair=normalizeRound(round,date);
  reconcile(pair);
  return Buffer.from(JSON.stringify(pair));
}

export function decodeWmsOfficialRound(bytes,{date,observedAt}) {
  let pair;
  try{pair=JSON.parse(bytes.toString('utf8'));}catch{fail('ARCHIVE');}
  if(pair?.schema!==1||pair.source!==WMS_OFFICIAL_ROUND_SOURCE||pair.observedAt!==observedAt)fail('ARCHIVE');
  const {date:shipDate,warehouse:wh,roundId,observedAt:at}=pair;
  const scope={date:shipDate,warehouse:wh,roundId,observedAt:at};
  const canonical=normalizeRound({plan:{...scope,rows:pair.plans},dispatch:{...scope,rows:pair.dispatch}},date);
  if(!Buffer.from(JSON.stringify(canonical)).equals(bytes))fail('ARCHIVE');
  return {data:reconcile(canonical),roundId};
}
