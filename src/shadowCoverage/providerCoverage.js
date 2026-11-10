import {createHash} from 'node:crypto';
import {cellToLatLng,getResolution,isValidCell,latLngToCell} from 'h3-js';
import {isDay} from './coverageFiles.js';

export const PROVIDERS=Object.freeze(['FRESHON','CJ','NAVER_SHOPPING']);
export const PROVIDER_H3_RESOLUTION=8;
export const PROVIDER_COVERAGE_CONTRACT='opsmap-provider-coverage-v1';
export const MAX_PROVIDER_ROWS=20_000;
const confirmed=['AVAILABLE_CONFIRMED','UNAVAILABLE_CONFIRMED'];
const states=[...confirmed,'NO_DELIVERY_HISTORY','UNVERIFIED'];
const sha=/^[a-f0-9]{64}$/;
const sensitive=/[\u0000-\u001f]|비밀번호|보안키|공동현관|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i;
const indexed=new WeakMap();
const fail=code=>{throw Error(code);};
export const providerDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const isProviderCell=id=>typeof id==='string'&&isValidCell(id)&&getResolution(id)===PROVIDER_H3_RESOLUTION;

function text(value,max) {
  if(value==null||value==='')return null;
  if(typeof value!=='string'||value.length>max||sensitive.test(value))fail('PROVIDER_TEXT_INVALID');
  return value.normalize('NFKC').trim().replace(/\s+/g,' ')||null;
}

function coordinate(value) {
  if(value==null||value==='')return null;
  if(typeof value==='string'&&!/^-?\d+(?:\.\d+)?$/.test(value))fail('PROVIDER_COORDINATE_INVALID');
  if(typeof value!=='string'&&typeof value!=='number')fail('PROVIDER_COORDINATE_INVALID');
  const number=Number(value);
  if(!Number.isFinite(number))fail('PROVIDER_COORDINATE_INVALID');
  return number;
}

function numericId(value,length) {
  if(value==null||value==='')return null;
  if(typeof value!=='string')fail('PROVIDER_LOCATION_INVALID');
  const code=value.normalize('NFKC').trim();
  if(code.length!==length||!/^\d+$/.test(code))fail('PROVIDER_LOCATION_INVALID');
  return code;
}

function customerId(value) {
  if(value==null||value==='')return null;
  if(typeof value!=='string'||value.length>64||/[\u0000-\u001f]/.test(value))fail('PROVIDER_CUSTOMER_LINK_INVALID');
  return value.trim()||null;
}

function normalizeRow(row,provider,asOf) {
  if(!row||typeof row!=='object'||row.provider&&row.provider!==provider)fail('PROVIDER_ROW_INVALID');
  const customerCode=customerId(row.customerCode),internalCustomerCode=customerId(row.internalCustomerCode);
  const address=text(row.address,240),pnu=numericId(row.pnu,19),postalCode=numericId(row.postalCode,5);
  const lat=coordinate(row.lat),lng=coordinate(row.lng);
  if((lat===null)!==(lng===null)||lat!==null&&(lat<33||lat>39.5||lng<124||lng>132))fail('PROVIDER_COORDINATE_INVALID');
  const h3Cell=text(row.h3Cell,15);
  const scope=row.scope||(postalCode&&!address&&!pnu&&lat===null?'POSTAL_CODE':'POINT');
  if(!['POINT','POSTAL_CODE','H3_CELL'].includes(scope)||
      (scope==='H3_CELL'? !isProviderCell(h3Cell):h3Cell!==null)||
      (scope==='POSTAL_CODE'&&!postalCode)||
      (scope==='H3_CELL'&&lat!==null&&latLngToCell(lat,lng,PROVIDER_H3_RESOLUTION)!==h3Cell)||
      !(customerCode||address||pnu||postalCode||h3Cell||lat!==null))fail('PROVIDER_LOCATION_INVALID');
  const matchApproved=[true,'true','TRUE','1',1].includes(row.matchApproved);
  if((matchApproved&&!(address||pnu))||(internalCustomerCode&&!matchApproved))fail('PROVIDER_CUSTOMER_LINK_INVALID');
  const weekdays=Array.isArray(row.weekdays)?row.weekdays:String(row.weekdays||'').split(/[,|]/).map(x=>x.trim()).filter(Boolean).map(Number);
  if(weekdays.some(day=>!Number.isInteger(day)||day<1||day>7))fail('PROVIDER_WEEKDAY_INVALID');
  const validFrom=row.validFrom||asOf,validTo=row.validTo||null;
  const status=row.status||'UNVERIFIED';
  if(!isDay(validFrom)||validTo&&(!isDay(validTo)||validTo<validFrom)||!states.includes(status))fail('PROVIDER_STATUS_INVALID');
  return Object.freeze({provider,customerCode,internalCustomerCode,matchApproved,address,pnu,postalCode,lat,lng,h3Cell,scope,status,
    weekdays:Object.freeze([...new Set(weekdays)].sort()),areaType:text(row.areaType,64),validFrom,validTo,source:text(row.source,128)});
}

export function sealProviderCoverage({provider,asOf,source,kind,records}={}) {
  if(!PROVIDERS.includes(provider)||!isDay(asOf)||!['APPROVED','SYNTHETIC'].includes(kind)||
      !Array.isArray(records)||records.length>MAX_PROVIDER_ROWS)fail('PROVIDER_DATASET_INVALID');
  const origin=text(source,128);
  if(!origin)fail('PROVIDER_DATASET_INVALID');
  const distinct=new Map();
  for(const raw of records) {
    const row=normalizeRow(raw,provider,asOf);
    distinct.set(JSON.stringify(row),row);
  }
  const body={contract:PROVIDER_COVERAGE_CONTRACT,provider,asOf,source:origin,kind,records:Object.freeze([...distinct.values()])};
  return Object.freeze({...body,generation:providerDigest(JSON.stringify(body))});
}

export function parseProviderCoverage(bytes,expectedSha256,provider) {
  if(!sha.test(expectedSha256||'')||providerDigest(bytes)!==expectedSha256)fail('PROVIDER_FILE_DIGEST');
  const raw=JSON.parse(bytes);
  if(raw?.contract!==PROVIDER_COVERAGE_CONTRACT||raw.provider!==provider||raw.kind!=='APPROVED')fail('PROVIDER_APPROVAL_REQUIRED');
  const data=sealProviderCoverage(raw);
  if(raw.generation!==data.generation)fail('PROVIDER_GENERATION_INVALID');
  return data;
}

export function sameApprovedProviderLocation(left,right) {
  if(left?.matchApproved!==true||right?.matchApproved!==true)return false;
  if(left.pnu&&right.pnu)return left.pnu===right.pnu;
  return Boolean(left.address&&right.address&&left.address===right.address);
}

function cellsOf(dataset) {
  let cells=indexed.get(dataset);
  if(cells)return cells;
  cells=new Map();
  for(const row of dataset.records) {
    const id=row.scope==='H3_CELL'?row.h3Cell:row.scope==='POINT'&&row.lat!==null?
      latLngToCell(row.lat,row.lng,PROVIDER_H3_RESOLUTION):null;
    if(!id)continue;
    const rows=cells.get(id)||[];
    rows.push(row);
    cells.set(id,rows);
  }
  indexed.set(dataset,cells);
  return cells;
}

export function providerCellsInBox(inputs, box, at) {
  const [west,south,east,north]=box;
  const middleLat=(south+north)/2, middleLng=(west+east)/2;
  const matches=new Map();
  for(const provider of PROVIDERS){
    const dataset=inputs?.[provider]?.dataset;
    if(dataset?.kind!=='APPROVED'||dataset.provider!==provider||dataset.asOf>at)continue;
    for(const [id,rows] of cellsOf(dataset)){
      if(matches.has(id)||!rows.some(row=>row.scope==='H3_CELL'&&confirmed.includes(row.status)&&row.validFrom<=at&&(!row.validTo||at<=row.validTo)))continue;
      const [lat,lng]=cellToLatLng(id);
      if(lat>=south&&lat<=north&&lng>=west&&lng<=east)matches.set(id,(lat-middleLat)**2+(lng-middleLng)**2);
    }
  }
  const ids=[...matches].sort(([a,distA],[b,distB])=>distA-distB||a.localeCompare(b)).slice(0,64).map(([id])=>id);
  return {ids,truncated:matches.size>ids.length};
}

export function providerCoverageView({inputs={},freshon=null,cells=[],at,kind='APPROVED'}={}) {
  if(!isDay(at)||!['APPROVED','SYNTHETIC'].includes(kind)||!Array.isArray(cells)||cells.length>64||cells.some(id=>!isProviderCell(id))) {
    fail('PROVIDER_COVERAGE_QUERY');
  }
  const providers=Object.fromEntries(PROVIDERS.map(provider=>{
    const input=inputs[provider];
    const data=input?.dataset;
    const active=data?.kind===kind&&data.provider===provider&&data.asOf<=at;
    return [provider,{connection:active||provider==='FRESHON'&&freshon?'CONNECTED':
      input?.state==='UNVERIFIED'||data?'UNVERIFIED':'NOT_CONNECTED',
      generation:active?data.generation:provider==='FRESHON'?freshon?.generation||null:null,
      sourceAsOf:active?data.asOf:provider==='FRESHON'?freshon?.end||null:null,
      source:active?data.source:provider==='FRESHON'&&freshon?'FRESHON_OBSERVED_DELIVERY':null,
      serviceSourceConnected:active}];
  }));
  const data=cells.map(id=>{
    const coverage=Object.fromEntries(PROVIDERS.map(provider=>{
      const input=inputs[provider]?.dataset;
      const matches=providers[provider].serviceSourceConnected?(cellsOf(input).get(id)||[])
        .filter(row=>row.validFrom<=at&&(!row.validTo||at<=row.validTo)):[];
      const explicit=new Set(matches.filter(row=>row.scope==='H3_CELL').map(row=>row.status));
      const pointCounts={available:0,unavailable:0};
      for(const row of matches) {
        if(row.scope!=='POINT')continue;
        if(row.status===confirmed[0])pointCounts.available++;
        if(row.status===confirmed[1])pointCounts.unavailable++;
      }
      const status=explicit.size===1?[...explicit][0]:providers[provider].connection==='NOT_CONNECTED'?'NOT_CONNECTED':'UNVERIFIED';
      const history=provider==='FRESHON'&&freshon?.byCell.get(id);
      const conflict=explicit.has(confirmed[0])&&pointCounts.unavailable>0||
        explicit.has(confirmed[1])&&pointCounts.available>0;
      const resolved=conflict?'UNVERIFIED':status==='UNVERIFIED'&&!explicit.size&&history?.status==='NO_DELIVERY_HISTORY'?
        'NO_DELIVERY_HISTORY':status;
      return [provider,{status:resolved,pointCounts,...(history?{history}:{})}];
    }));
    const available=PROVIDERS.filter(p=>coverage[p].status===confirmed[0]);
    const unavailable=PROVIDERS.filter(p=>coverage[p].status===confirmed[1]);
    const unknown=PROVIDERS.filter(p=>!confirmed.includes(coverage[p].status));
    const status=unknown.length?'NOT_COMPARABLE':
      ['ALL_UNAVAILABLE','ONE_AVAILABLE','TWO_AVAILABLE','ALL_AVAILABLE'][available.length];
    return {id,providers:coverage,overlap:{status,available,unavailable,unknown}};
  });
  return {contract:PROVIDER_COVERAGE_CONTRACT,kind,asOf:at,resolution:PROVIDER_H3_RESOLUTION,
    providers,freshonHistory:freshon?{generation:freshon.generation,start:freshon.start,end:freshon.end,
      missingDates:freshon.missingDates,unverifiedDates:freshon.unverifiedDates,stale:freshon.stale}:null,cells:data};
}
