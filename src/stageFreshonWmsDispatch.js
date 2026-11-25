import {createRequire} from 'node:module';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {isStageWmsDay,stageWmsError} from './stageWmsExportIndex.js';

export const FRESHON_JSON_WMS_SOURCE='WMS_CONFIRMED_DISPATCH_FRESHON_JSON';
const require=createRequire(import.meta.url);
const pageSize=3000, warehouse='011';
const customerPattern=/^[A-Z]\d{1,20}$/;
const text=value=>typeof value==='string'?value.trim():Number.isSafeInteger(value)?String(value):'';
const fail=code=>{throw stageWmsError('WMS_EXPORT_FRESHON_'+code);};
function field(value,limit) {
  if(value==null)return '';
  if(typeof value!=='string'||value.length>limit||/[\x00-\x1f]/.test(value))fail('CUSTOMER_FIELD');
  return value.trim();
}

function exactInteger(value) {
  const raw=text(value);
  if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(raw))fail('INTEGER');
  const numeric=Number(raw.replaceAll(',',''));
  if(!Number.isSafeInteger(numeric))fail('INTEGER');
  return numeric;
}

function add(left,right) {
  const sum=left+right;
  if(!Number.isSafeInteger(sum))fail('INTEGER');
  return sum;
}

export function freshonWmsVehicle(value) {
  if(value!=null&&typeof value!=='string'&&!Number.isSafeInteger(value))fail('VEHICLE');
  const normalized=text(value).replace(/호(?:차)?$/,'').trim();
  if(!normalized||normalized==='미배정')return '미배정';
  if(!/^[0-9가-힣 -]{1,24}$/.test(normalized)||['-','소계','합계'].includes(normalized))fail('VEHICLE');
  return normalized;
}

function freshonWmsDetail(route,base,customer,amount,count) {
  const code=text(customer).toUpperCase();
  const deliveries=exactInteger(count);
  if(!customerPattern.test(code)||deliveries<1)fail('DETAIL');
  return [freshonWmsVehicle(route),code,freshonWmsVehicle(base),exactInteger(amount),deliveries];
}

export function collectFreshonWmsDispatch(payload,date) {
  // One explicitly counted complete page is the only provider contract verified for XLSX parity.
  if(!Array.isArray(payload?.data)||!payload.data.length||payload.data.length>=pageSize)fail('PAGE');
  if(!isStageWmsDay(date))fail('SCOPE');
  const target=date.replaceAll('-',''), lines=new Set(), routes=new Map(), deliveryRows=[];
  let current=null,declared=null,sum=0,count=0,groups=0;
  for(const row of payload.data){
    if(!row||typeof row!=='object'||Array.isArray(row)||!(row.isSum===false||row.isSum==='false')||
      (row.logCd!=null&&!['','011','11',11].includes(row.logCd)))fail('ROW');
    const stamp=text(row.stockDate);
    // isSum=false is present on both detail and subtotal rows in the observed provider response.
    if(/^\d{8}$|^\d{4}-\d\d-\d\d$|^\d{4}\.\d\d\.\d\d$/.test(stamp)&&stamp.replace(/[-.]/g,'')===target){
      const entry=freshonWmsDetail(row.confirmCarSeq,row.carSeq,row.estCd,row.maechul,row.baesongCnt);
      const [route,,,amount,deliveries]=entry;
      const total=exactInteger(row.totalCnt), key=JSON.stringify(entry);
      if(total<1||total>=pageSize||lines.has(key)||routes.has(route))fail('DETAIL');
      if(declared===null)declared=total;
      if(total!==declared||current&&current.route!==route)fail('DETAIL');
      current??={route,amount:0,deliveries:0};
      current.amount=add(current.amount,amount);
      current.deliveries=add(current.deliveries,deliveries);
      lines.add(key);
      deliveryRows.push([entry,field(row.estName,200),field(row.address,500)]);
      continue;
    }
    if(![null,undefined,''].includes(row.stockDate)||![null,undefined,''].includes(row.estCd)||!current||
      exactInteger(row.totalCnt)!==0||exactInteger(row.maechul)!==current.amount||
      exactInteger(row.baesongCnt)!==current.deliveries)fail('SUBTOTAL');
    const subtotalRoute=text(row.confirmCarSeq);
    if(subtotalRoute&&subtotalRoute!=='-'&&subtotalRoute!=='소계'&&freshonWmsVehicle(subtotalRoute)!==current.route)fail('SUBTOTAL');
    groups++;
    sum=add(sum,current.amount);
    count=add(count,current.deliveries);
    routes.set(current.route,[current.amount,current.deliveries]);
    current=null;
  }
  if(current||declared!==lines.size||groups!==routes.size||lines.size+groups!==payload.data.length)fail('COUNT');
  return {lines,routes,sum,count,deliveryRows};
}

export function verifiedFreshonWmsWorkbookLines(bytes,date) {
  const XLSX=require('xlsx');
  const book=XLSX.read(bytes,{type:'buffer',sheetRows:12001,cellFormula:false,cellText:false});
  const [header,...rows]=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:'',blankrows:false});
  const required=['입고요청일','확정호차','고객','매출금액','배송건수','기준호차'];
  const columns=required.map(name=>{
    const positions=header.flatMap((value,index)=>text(value)===name?[index]:[]);
    if(positions.length!==1)fail('WORKBOOK_FIELDS');
    return positions[0];
  });
  const [day,route,code,amount,count,base]=columns;
  const lines=new Set();
  for(const row of rows){
    if(text(row[day]).replace(/[-.]/g,'')!==date.replaceAll('-',''))continue;
    const key=JSON.stringify(freshonWmsDetail(row[route],row[base],row[code],row[amount],row[count]));
    if(lines.has(key))fail('WORKBOOK_DETAIL');
    lines.add(key);
  }
  return lines;
}


export function encodeFreshonWmsDispatch(date,source) {
  const compare=(left,right)=>left<right?-1:left>right?1:0;
  const groups=[...source.routes].sort((a,b)=>compare(a[0],b[0]));
  const rows=[...source.deliveryRows].sort((a,b)=>compare(JSON.stringify(a[0]),JSON.stringify(b[0])));
  return Buffer.from(JSON.stringify({schema:1,source:FRESHON_JSON_WMS_SOURCE,warehouse,date,groups,rows}));
}

export function decodeFreshonWmsDispatch(bytes,{date,observedAt}) {
  let payload;
  try{payload=JSON.parse(bytes.toString('utf8'));}catch{fail('ARCHIVE');}
  if(!isStageWmsDay(date)||!Number.isFinite(Date.parse(observedAt))||payload?.schema!==1||
    payload.source!==FRESHON_JSON_WMS_SOURCE||payload.warehouse!==warehouse||payload.date!==date||
    !Array.isArray(payload.rows)||!Array.isArray(payload.groups)||!payload.rows.length||
    payload.rows.length+payload.groups.length>=pageSize)fail('ARCHIVE');
  const rowsByVehicle=new Map();
  for(const tuple of payload.rows){
    if(!Array.isArray(tuple)||tuple.length!==3||!Array.isArray(tuple[0])||tuple[0].length!==5)fail('ARCHIVE');
    const [[confirmCarSeq,estCd,carSeq,maechul,baesongCnt],estName,address]=tuple;
    const entries=rowsByVehicle.get(confirmCarSeq)||[];
    entries.push({stockDate:date,totalCnt:payload.rows.length,isSum:false,logCd:warehouse,
      confirmCarSeq,estCd,carSeq,maechul,baesongCnt,estName,address});
    rowsByVehicle.set(confirmCarSeq,entries);
  }
  const reconstructed=[];
  for(const group of payload.groups){
    if(!Array.isArray(group)||group.length!==2||!Array.isArray(group[1])||group[1].length!==2||
      !rowsByVehicle.has(group[0]))fail('ARCHIVE');
    const [confirmCarSeq,[maechul,baesongCnt]]=group;
    reconstructed.push(...rowsByVehicle.get(confirmCarSeq),
      {stockDate:'',totalCnt:0,isSum:false,confirmCarSeq,maechul,baesongCnt});
    rowsByVehicle.delete(confirmCarSeq);
  }
  if(rowsByVehicle.size)fail('ARCHIVE');
  const proof=collectFreshonWmsDispatch({data:reconstructed},date);
  if(!encodeFreshonWmsDispatch(date,proof).equals(bytes))fail('ARCHIVE');
  const customers=new Map();
  for(const [[route,customerCode,base,amount],customerName,address] of proof.deliveryRows){
    if(!customers.has(route))customers.set(route,new Map());
    const group=customers.get(route), prior=group.get(customerCode);
    const addressHash=coordinateAddressHash(address);
    if(prior){
      if(route==='미배정'||!addressHash||addressHash!==prior.addressHash||!customerName||
        customerName!==prior.customerName||base==='미배정'||prior.bases.has('미배정')||prior.bases.has(base))fail('CUSTOMER_SPLIT');
      prior.amount=add(prior.amount,amount);prior.bases.add(base);
    }else group.set(customerCode,{customerCode,amount,addressHash,customerName,bases:new Set([base])});
  }
  const vehicles=[...proof.routes].map(([vehicle,[amount,deliveryCount]])=>({vehicle,amount,deliveryCount,
    detailTotal:amount,difference:0,details:[...customers.get(vehicle).values()].map(({bases,...entry})=>entry)}));
  return {data:{date,source:FRESHON_JSON_WMS_SOURCE,center:'osan',observedAt:new Date(observedAt).toISOString(),
    sourceComplete:true,total:proof.sum,deliveryCount:proof.count,vehicles},proof};
}
