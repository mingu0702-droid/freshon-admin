import {distance} from '../public/opsmap/dispatch-reference.mjs';

export const DISPATCH_PERIODS = [7,30,60,90];
const dayMs = 86_400_000;
const postalCode = /^\d{5}$/;
const areaLimitKm = .5;
const cellSize = .006;

export function dispatchPeriodDates(end,days) {
  return Array.from({length:days},(_,index)=>new Date(Date.parse(end)-(days-1-index)*dayMs).toISOString().slice(0,10));
}

function nearbyRoutes(points) {
  const cells=new Map(), pairs=new Map();
  for (const point of points) {
    const y=Math.floor(point.lat/cellSize), x=Math.floor(point.lng/cellSize);
    const key=y+','+x;
    for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
      for (const other of cells.get((y+dy)+','+(x+dx))||[]) {
        if (other.vehicle===point.vehicle||other.code===point.code) continue;
        const km=distance(point,other);
        if (km>areaLimitKm) continue;
        const [a,b]=[other.vehicle,point.vehicle].sort();
        const pair=a+'|'+b;
        const current=pairs.get(pair);
        if (current===undefined||km<current.km) pairs.set(pair,{a,b,km});
      }
    }
    if (!cells.has(key)) cells.set(key,[]);
    cells.get(key).push(point);
  }
  return [...pairs.values()].map(({a,b,km})=>[a,b,Math.round(km*1000)]);
}

function summarizeRoutes(rows) {
  const routes=new Map(), points=[];
  for (const row of rows) {
    if (!routes.has(row.vehicle)) routes.set(row.vehicle,{areas:new Map(),unknown:0,count:0});
    const truck=routes.get(row.vehicle);
    truck.count++;
    const point=row.coordinateVerified&&Number.isFinite(row.lat)&&Number.isFinite(row.lng)
      ? {lat:row.lat,lng:row.lng,vehicle:row.vehicle,code:row.customerCode} : null;
    if (point) points.push(point);
    if (!postalCode.test(row.postalCode??'')) {truck.unknown++;continue;}
    const entry=truck.areas.get(row.postalCode)||{count:0,point:null};
    entry.count++;
    if (point&&!entry.point) entry.point=[point.lat,point.lng];
    truck.areas.set(row.postalCode,entry);
  }
  const output=Object.fromEntries([...routes].map(([vehicle,{count,unknown,areas}])=>[vehicle,[count,unknown,
    [...areas].map(([zip,area])=>[zip,area.count,area.point])]]));
  return {routes:output,neighbors:nearbyRoutes(points)};
}

export function projectDispatchPeriodDay(value) {
  const {date,route,amounts}=value;
  const wmsVerified=amounts?.date===date&&amounts.state==='VERIFIED'&&Array.isArray(amounts.vehicles);
  const evidence={date,wmsVerified,
    amounts:wmsVerified?amounts.vehicles.filter(({amount,vehicle})=>vehicle!=='미배정'&&Number.isSafeInteger(amount))
      .map(({vehicle,amount})=>[vehicle,amount]):[]};
  const completed=Array.isArray(route?.completedRows)&&
    (route.completedCoverage!=='PARTIAL'||route.completedRows.length>0)
    ? {completed:{...summarizeRoutes(route.completedRows),coverage:route.completedCoverage??'VERIFIED'}} : {};
  if (route?.state!=='VERIFIED') return {...evidence,state:route?.state==='PARTIAL'?'PARTIAL':'UNAVAILABLE',...completed};
  const dispatchScope=['WMS_CONFIRMED_DISPATCH_EXPORT','WMS_CONFIRMED_DISPATCH_FRESHON_JSON','WMS_CONFIRMED_DISPATCH_OFFICIAL_ROUND'].includes(route.source)?'WMS_EXPORT':
    ['PUBLISHED_DELIVERY_ARCHIVE','DATED_DELIVERY_SOURCE'].includes(route.source)?'OSAN_SOURCE':null;
  return {...evidence,state:'VERIFIED',dispatchScope,...summarizeRoutes(route.rows),...completed};
}
