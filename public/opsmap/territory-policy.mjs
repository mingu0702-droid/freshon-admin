import {prepareAdminBoundaries,matchingAdminFeatures} from './admin-boundaries.mjs';
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function recentTerritoryRange(end){if(!day(end))throw Error('TERRITORY_DATE_REQUIRED');return {startDate:new Date(Date.parse(end)-9*86400000).toISOString().slice(0,10),endDate:end};}
const validPoint=p=>p&&!['CONFLICT','UNVERIFIED','MISSING'].includes(p.coordinateStatus||p.raw?.coordinateStatus)&&p.resolutionStatus!=='ADDRESS_CHANGED_REVIEW_REQUIRED'&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.lat>=33&&p.lat<=39.5&&p.lng>=124&&p.lng<=132;
const referenceCurrentness='VERIFIED_SNAPSHOT_REFRESHING';
function verifiedReference(stores,reference,now){
 const checked=Date.parse(reference?.checkedAt),age=now-checked;
 if(reference?.source!=='FIXED_DISPATCH_PRIMARY'||!/^[a-f0-9]{64}$/.test(reference.version||'')||typeof reference.checkedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(reference.checkedAt)||!Number.isFinite(now)||!Number.isFinite(age)||age<0||age>86400000)return null;
 const rows=stores.filter(r=>r?.baseVehicleState==='VERIFIED_MASTER');
 if(!rows.length||rows.some(r=>r.baseVehicleSource!=='FIXED_DISPATCH_PRIMARY'||r.baseVehicleVersion!==reference.version||r.baseVehicleCheckedAt!==reference.checkedAt||typeof r.baseVehicleStale!=='boolean'))return null;
 return {version:reference.version,checkedAt:reference.checkedAt,source:reference.source};
}
// Fixed territory is a projection of the verified fixed master, never of dated visits.
// The default rejects stale rows. An explicit verified reference retains separate source currentness.
export function buildBaseTerritories(stores,boundaries=null,{referenceMaster=null,now=Date.now()}={}){
 let prepared=null,boundaryReason='ADMIN_BOUNDARIES_UNAVAILABLE';
 if(boundaries){try{prepared=prepareAdminBoundaries(boundaries);boundaryReason=null;}catch{boundaryReason='ADMIN_BOUNDARIES_INVALID';}}
 if(!Array.isArray(stores)||stores.length>15000)throw Error('TERRITORY_LIMIT');
 const reference=verifiedReference(stores,referenceMaster,now);
 const verified=stores.filter(r=>r&&r.baseVehicleState==='VERIFIED_MASTER'&&r.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&(r.baseVehicleStale===false||reference&&r.baseVehicleStale===true)&&typeof r.baseVehicleVersion==='string'&&/^[a-f0-9]{64}$/.test(r.baseVehicleVersion)&&typeof r.baseVehicle==='string'&&r.baseVehicle.length>0&&r.baseVehicle.length<=64);
 const versions=new Set(verified.map(r=>r.baseVehicleVersion));if(versions.size>1)throw Error('TERRITORY_MASTER_CHANGED');
 const byCode=new Map(),conflicts=new Set();
 for(const row of verified){const key=String(row.customerCode||'');if(!/^[A-Z]\d+$/.test(key))continue;const old=byCode.get(key);if(old&&(old.baseVehicle!==row.baseVehicle||old.baseVehicleGroup!==row.baseVehicleGroup||old.lat!==row.lat||old.lng!==row.lng)){conflicts.add(key);continue;}byCode.set(key,row);}
 const groups=new Map();
 for(const [code,row] of byCode){if(conflicts.has(code))continue;const vehicle=row.baseVehicle;if(!groups.has(vehicle))groups.set(vehicle,{vehicle,codes:[],points:[],centers:new Set(),unconfirmedCenter:false});const group=groups.get(vehicle);group.codes.push(code);if(['osan','yeongnam','honam'].includes(row.baseVehicleGroup))group.centers.add(row.baseVehicleGroup);else group.unconfirmedCenter=true;if(validPoint(row))group.points.push({customerCode:code,lat:row.lat,lng:row.lng});}
 const output=[...groups.values()].map(g=>{
  const features=new Map(),joins=[];
  for(const point of g.points){const matches=matchingAdminFeatures(point,prepared);for(const f of matches)features.set(f.properties.adm_cd,f);joins.push({customerCode:point.customerCode,adminCodes:matches.map(f=>f.properties.adm_cd)});}
  const center=!g.unconfirmedCenter&&g.centers.size===1?[...g.centers][0]:null;
  const reason=!center?'CENTER_UNCONFIRMED':boundaryReason||(!g.points.length?'LOCATIONS_REQUIRED':!features.size?'ADMIN_BOUNDARY_NO_MATCH':null);
  return {vehicle:g.vehicle,codes:g.codes,center,storeCount:g.codes.length,locatedCount:g.points.length,matchedCount:joins.filter(j=>j.adminCodes.length).length,points:g.points,boundary:[],features:[...features.values()],joins,state:reason?'unconfirmed':'ready',source:'FIXED_DISPATCH_PRIMARY',reason};
 });
 const responsibilities=new Map();for(const g of output)for(const f of g.features){const code=f.properties.adm_cd;if(!responsibilities.has(code))responsibilities.set(code,new Set());responsibilities.get(code).add(g.vehicle);}
 for(const g of output)g.sharedAdminCodes=g.features.filter(f=>responsibilities.get(f.properties.adm_cd).size>1).map(f=>f.properties.adm_cd);
 return {version:versions.values().next().value||null,currentness:reference?referenceCurrentness:versions.size?'CURRENT_VERIFIED_MASTER':'UNCONFIRMED',referenceMaster:reference,boundaryReason,boundaryMetadata:prepared?.metadata||null,unknownCount:stores.length-output.reduce((n,g)=>n+g.codes.length,0),groups:output.sort((a,b)=>a.vehicle.localeCompare(b.vehicle,'ko',{numeric:true}))};
}
export function buildTerritories(facts,stores,{startDate,endDate}){
 if(!day(startDate)||!day(endDate)||startDate>endDate||Date.parse(endDate)-Date.parse(startDate)!==9*86400000)throw Error('TERRITORY_WINDOW');
 if(!Array.isArray(facts)||facts.length>200000||!Array.isArray(stores)||stores.length>15000)throw Error('TERRITORY_LIMIT');
 const master=new Map(stores.filter(validPoint).map(p=>[p.customerCode,p])),groups=new Map(),latest=new Map();
 for(const r of facts){if(!day(r.deliveryDate)||r.deliveryDate<startDate||r.deliveryDate>endDate||!/^([A-Z]\d+)$/.test(r.customerCode||'')||!/^\d{1,3}$/.test(r.confirmedVehicle||'')||!Number.isSafeInteger(r.count)||r.count<1)continue;
  const old=latest.get(r.customerCode);if(!old||r.deliveryDate>old.date)latest.set(r.customerCode,{date:r.deliveryDate,vehicles:new Set([r.confirmedVehicle])});else if(r.deliveryDate===old.date)old.vehicles.add(r.confirmedVehicle);
 }
 for(const [code,r]of latest)for(const key of r.vehicles){if(!groups.has(key))groups.set(key,{vehicle:key,codes:new Set(),points:new Map(),latestDate:r.date});const g=groups.get(key);g.codes.add(code);if(r.date>g.latestDate)g.latestDate=r.date;const p=master.get(code);if(p&&r.vehicles.size===1)g.points.set(code,{customerCode:code,lat:p.lat,lng:p.lng});}
 return [...groups.values()].map(g=>{const points=[...g.points.values()],boundary=[];return {vehicle:g.vehicle,storeCount:g.codes.size,locatedCount:points.length,latestDate:g.latestDate,points,boundary,state:'unconfirmed',reason:'FIXED_MASTER_AND_ADMIN_BOUNDARIES_REQUIRED'};}).sort((a,b)=>Number(a.vehicle)-Number(b.vehicle));
}
// Reference rendering retains the original source stale flag and verification timestamp.
export function baseTerritoryAvailability(stores,master,model=null,{now=Date.now()}={}){
 if(!Array.isArray(stores)||stores.length>15000)throw Error('TERRITORY_LIMIT');
 const checkedAt=typeof master?.checkedAt==='string'&&/^\d{4}-\d{2}-\d{2}/.test(master.checkedAt)?master.checkedAt:null;
 const reference=model?.currentness===referenceCurrentness&&master?.stale===true&&master.version===model.version&&master.checkedAt===model.referenceMaster?.checkedAt&&verifiedReference(stores,model.referenceMaster,now);
 const reason=!master?.version?'MASTER_UNAVAILABLE':master.stale!==false&&!reference?'MASTER_STALE':!model?.version?'MASTER_UNVERIFIED':master.version!==model.version?'MASTER_VERSION_CHANGED':model.boundaryReason||null;
 const grouped=new Map();for(const row of stores){if(typeof row?.baseVehicle==='string'&&row.baseVehicle){const v=grouped.get(row.baseVehicle)||{vehicle:row.baseVehicle,storeCount:0,locatedCount:0};v.storeCount++;if(validPoint(row))v.locatedCount++;grouped.set(row.baseVehicle,v);}}
 for(const g of model?.groups||[])grouped.set(g.vehicle,{vehicle:g.vehicle,storeCount:g.storeCount,locatedCount:g.locatedCount,matchedCount:g.matchedCount,adminCount:g.features.length,sharedAdminCount:g.sharedAdminCodes.length,state:g.state,reason:g.reason,center:g.center});
 const sourceError=/^FIXED_(?:MASTER|STORE)_[A-Z_]+$/.test(master?.lastError||'')?master.lastError:null;
 return {reason,checkedAt,stale:master?.stale,currentness:reference?referenceCurrentness:reason?'UNCONFIRMED':'CURRENT_VERIFIED_MASTER',referenceMaster:reference?model.referenceMaster:null,version:master?.version||null,sourceError,refresh:typeof master?.refresh==='string'&&/^[A-Z_]+$/.test(master.refresh)?master.refresh:null,vehicles:[...grouped.values()].map(g=>({...g,state:reason?'unconfirmed':g.state||'unconfirmed',reason:reason||g.reason||null})).sort((a,b)=>a.vehicle.localeCompare(b.vehicle,'ko',{numeric:true}))};
}

