const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function recentTerritoryRange(end){if(!day(end))throw Error('TERRITORY_DATE_REQUIRED');return {startDate:new Date(Date.parse(end)-9*86400000).toISOString().slice(0,10),endDate:end};}
const validPoint=p=>p&&p.coordinateStatus!=='CONFLICT'&&p.currentMasterStatus!=='UNAVAILABLE'&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.lat>=33&&p.lat<=39.5&&p.lng>=124&&p.lng<=132;
const cross=(a,b,c)=>(b.lng-a.lng)*(c.lat-a.lat)-(b.lat-a.lat)*(c.lng-a.lng);
function hull(points){const p=[...new Map(points.map(p=>[p.lat+','+p.lng,p])).values()].sort((a,b)=>a.lng-b.lng||a.lat-b.lat);if(p.length<3)return [];const half=rows=>{const out=[];for(const p of rows){while(out.length>1&&cross(out.at(-2),out.at(-1),p)<=1e-10)out.pop();out.push(p);}return out;};const a=half(p),b=half(p.toReversed());const h=a.slice(0,-1).concat(b.slice(0,-1));return h.length>=3?h:[];}
export function buildTerritories(facts,stores,{startDate,endDate}){
 if(!day(startDate)||!day(endDate)||startDate>endDate||Date.parse(endDate)-Date.parse(startDate)!==9*86400000)throw Error('TERRITORY_WINDOW');
 if(!Array.isArray(facts)||facts.length>200000||!Array.isArray(stores)||stores.length>15000)throw Error('TERRITORY_LIMIT');
 const master=new Map(stores.filter(validPoint).map(p=>[p.customerCode,p])),groups=new Map(),latest=new Map();
 for(const r of facts){if(!day(r.deliveryDate)||r.deliveryDate<startDate||r.deliveryDate>endDate||!/^([A-Z]\d+)$/.test(r.customerCode||'')||!/^\d{1,3}$/.test(r.confirmedVehicle||'')||!Number.isSafeInteger(r.count)||r.count<1)continue;
  const old=latest.get(r.customerCode);if(!old||r.deliveryDate>old.date)latest.set(r.customerCode,{date:r.deliveryDate,vehicles:new Set([r.confirmedVehicle])});else if(r.deliveryDate===old.date)old.vehicles.add(r.confirmedVehicle);
 }
 for(const [code,r]of latest)for(const key of r.vehicles){if(!groups.has(key))groups.set(key,{vehicle:key,codes:new Set(),points:new Map(),latestDate:r.date});const g=groups.get(key);g.codes.add(code);if(r.date>g.latestDate)g.latestDate=r.date;const p=master.get(code);if(p&&r.vehicles.size===1)g.points.set(code,{customerCode:code,lat:p.lat,lng:p.lng});}
 return [...groups.values()].map(g=>{const points=[...g.points.values()],boundary=hull(points);return {vehicle:g.vehicle,storeCount:g.codes.size,locatedCount:points.length,latestDate:g.latestDate,points,boundary,state:boundary.length?'ready':'unconfirmed',reason:points.length<3?'LOCATIONS_REQUIRED':'NON_COLLINEAR_LOCATIONS_REQUIRED'};}).sort((a,b)=>Number(a.vehicle)-Number(b.vehicle));
}

