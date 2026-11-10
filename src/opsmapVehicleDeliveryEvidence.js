import {SYNC_CENTERS, SYNC_DELIVERY_SOURCES} from './opsmapSyncPolicy.js';
import {datesFor} from './shadowCoverage/coverageFiles.js';

export const VEHICLE_DELIVERY_FILE = 'vehicle-delivery.json';
export const MAX_VEHICLE_DELIVERY_BYTES = 2 * 1024 * 1024;
const contract = 'opsmap-vehicle-delivery-v1';
const vehiclePattern = /^(?:[용척]?\d{1,4})(?:-\d{1,3})?$/;
const sourceIds = Object.values(SYNC_DELIVERY_SOURCES);
const maxRows = 50_000;

export function collectOpsmapVehicleDelivery(end, addressHashes) {
  const dates = datesFor(end,90);
  const positions = new Map(dates.map((date,index)=>[date,index]));
  const rows = new Map();
  const completeSources = Object.fromEntries(sourceIds.map(id=>[id,[]]));
  return {
    add(day) {
      const index=positions.get(day.date);
      if(index===undefined||day.planningOnly)return;
      if(day.proof==='VERIFIED_COMPLETE_DAY') {
        for(const id of day.completeSources||[]) completeSources[id]?.push(day.date);
      }
      for(const [,code,vehicle,center,addressHash] of day.visits) {
        if(!vehiclePattern.test(vehicle)||!SYNC_CENTERS.includes(center)||!addressHash||addressHashes.get(code)!==addressHash)continue;
        const key=[code,vehicle,center].join('|');
        const row=rows.get(key)||[code,vehicle,center,[]];
        if(row[3].at(-1)!==index)row[3].push(index);
        rows.set(key,row);
      }
    },
    finish(generation,observedDates) {
      return {contract,generation,start:dates[0],end,observedDates,completeSources,rows:[...rows.values()]};
    }
  };
}

export function readOpsmapVehicleDelivery(bytes,{generation,registry,window}) {
  const evidence=JSON.parse(bytes);
  if(evidence.contract!==contract||evidence.generation!==generation||evidence.start!==window.start||evidence.end!==window.end||
      JSON.stringify(evidence.observedDates)!==JSON.stringify(window.observedDates)||!Array.isArray(evidence.rows)||
      evidence.rows.length>maxRows||Object.keys(evidence.completeSources||{}).length!==sourceIds.length) {
    throw Error('OPSMAP_VEHICLE_DELIVERY_SCOPE');
  }
  for(const [name,id] of Object.entries(SYNC_DELIVERY_SOURCES)) {
    const dates=evidence.completeSources[id];
    const observed=window.observedDates[name==='osanColdStorage'?'osan':name];
    if(!Array.isArray(dates)||dates.some((date,i)=>!observed.includes(date)||i>0&&date<=dates[i-1])) {
      throw Error('OPSMAP_VEHICLE_DELIVERY_COMPLETENESS');
    }
  }
  const identities=new Set();
  for(const row of evidence.rows) {
    if(!Array.isArray(row)||row.length!==4)throw Error('OPSMAP_VEHICLE_DELIVERY_ROW');
    const [code,vehicle,center,positions]=row;
    const key=[code,vehicle,center].join('|');
    if(!registry.get(code)?.hasPoint||!vehiclePattern.test(vehicle)||!SYNC_CENTERS.includes(center)||identities.has(key)||
        !Array.isArray(positions)||!positions.length||positions.some((index,i)=>!Number.isInteger(index)||
          index<0||index>=90||i>0&&index<=positions[i-1]))throw Error('OPSMAP_VEHICLE_DELIVERY_ROW');
    identities.add(key);
  }
  return evidence;
}

export function opsmapVehicleDeliveryPage(evidence,registry,{center='all',vehicle='',offset=0,limit=200,box}={}) {
  if(!['all',...SYNC_CENTERS].includes(center)||typeof vehicle!=='string'||vehicle&&!vehiclePattern.test(vehicle)||
      !Number.isInteger(offset)||offset<0||offset>maxRows||!Number.isInteger(limit)||limit<1||limit>250) {
    throw Error('OPSMAP_VEHICLE_DELIVERY_QUERY');
  }
  if(box!==undefined&&(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)||
      box[0]<-180||box[1]<-90||box[2]>180||box[3]>90||box[0]>=box[2]||box[1]>=box[3])) {
    throw Error('OPSMAP_VEHICLE_DELIVERY_QUERY');
  }
  const dates=datesFor(evidence.end,90);
  const matches=evidence.rows.filter(([code,actual,region])=>{
    if((center!=='all'&&center!==region)||(vehicle&&vehicle!==actual))return false;
    if(!box)return true;
    const {lat,lng}=registry.get(code);
    return lng>=box[0]&&lat>=box[1]&&lng<=box[2]&&lat<=box[3];
  });
  const rows=matches.slice(offset,offset+limit).map(([customerCode,actualVehicle,region,positions])=>{
    const {lat,lng}=registry.get(customerCode);
    const deliveryDates=positions.map(index=>dates[index]);
    const deliveryWeekdays=[...new Set(deliveryDates.map(date=>new Date(date).getUTCDay()||7))].sort((a,b)=>a-b);
    return {customerCode,actualVehicle,center:region,lat,lng,deliveryDates,deliveryWeekdays,lastDeliveredOn:deliveryDates.at(-1)};
  });
  const {rows:_,...meta}=evidence;
  return {...meta,rows,total:matches.length,nextOffset:offset+rows.length<matches.length?offset+rows.length:null};
}
