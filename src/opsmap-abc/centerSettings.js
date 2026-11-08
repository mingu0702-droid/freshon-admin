export const REGISTERED_OSAN_CENTER=Object.freeze({
  id:'osan',
  verified:true,
  sourceVersion:'operator-confirmed:2026-11-07',
  lat:37.1420107,
  lng:127.0794408,
  address:'경기도 오산시 동부대로 446'
});

export function registeredOsanCenter(setting){
  if(setting===undefined)return REGISTERED_OSAN_CENTER;
  if(typeof setting!=='string'||setting.length>2048)return null;
  let row;
  try{row=JSON.parse(setting);}catch{return null;}
  if(row?.verified!==true||(row.id!==undefined&&row.id!=='osan')||
    !Number.isFinite(row.lat)||row.lat<33||row.lat>39.5||
    !Number.isFinite(row.lng)||row.lng<124||row.lng>132||
    typeof row.sourceVersion!=='string'||!row.sourceVersion.trim()||row.sourceVersion.length>100||
    typeof row.address!=='string'||!row.address.trim()||row.address.length>200)return null;
  return {id:'osan',verified:true,sourceVersion:row.sourceVersion.trim(),lat:row.lat,lng:row.lng,address:row.address.trim()};
}
