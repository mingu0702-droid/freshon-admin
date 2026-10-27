(function(root){
 'use strict';
 const fail=code=>{throw Object.assign(Error(code),{code});};
 const coordinate=p=>{if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||p.lat<33||p.lat>39.5||p.lng<124||p.lng>132)fail('INVALID_COORDINATE');return {x:p.lng,y:p.lat};};
 // Collapse only adjacent equal coordinates for the provider request. Keep a
 // map back to EVERY original visit/leg, including separate shops in a building.
 function routePlan(body){
  if(!body||body.mode!=='MANUAL_WAYPOINTS'||!Array.isArray(body.waypoints)||body.waypoints.length>30)fail('WAYPOINT_LIMIT');
  const original=[body.origin,...body.waypoints,body.destination].map(coordinate),points=[original[0]],providerLegs=[],stationaryLegs=[];
  for(let i=0;i<original.length-1;i++){
   const a=original[i],b=original[i+1];
   if(a.x===b.x&&a.y===b.y)stationaryLegs.push(i);
   else {providerLegs.push(i);points.push(b);}
  }
  return {original,points,providerLegs,stationaryLegs};
 }
 function plan(body,{api}={}){
  const {points}=routePlan(body);
  if(points.length===1)return {method:'NONE',path:null,zeroDistance:true};
  api=api||(points.length-2>5?'waypoints':'directions');
  if(!['directions','waypoints'].includes(api)||points.length-2>(api==='directions'?5:30))fail('WAYPOINT_LIMIT');
  const options={priority:'RECOMMEND',alternatives:false,road_details:false,summary:false};
  if(api==='waypoints')return {method:'POST',path:'/v1/waypoints/directions',body:{origin:points[0],destination:points.at(-1),waypoints:points.slice(1,-1),...options}};
  return {method:'GET',path:'/v1/directions',query:{origin:points[0].x+','+points[0].y,destination:points.at(-1).x+','+points.at(-1).y,waypoints:points.slice(1,-1).map(p=>p.x+','+p.y).join('|'),...options}};
 }
 function fromProvider(payload,body){
  const {providerLegs,stationaryLegs}=routePlan(body),totalLegs=body.waypoints.length+1;
  const legs=Array.from({length:totalLegs},(_,index)=>({index,distanceMeters:0,durationSeconds:0,...(stationaryLegs.includes(index)?{stationary:true}:{})}));
  const base={mode:body.mode,requestId:body.requestId,source:providerLegs.length?'kakao-directions':'stationary-stops',isGpsActual:false,totalLegs,stationaryLegs};
  if(!providerLegs.length)return {...base,state:'success',complete:true,noDrivingRequired:true,coveredLegs:totalLegs,distanceMeters:0,durationSeconds:0,legs,chunks:[{state:'success',startLeg:0,endLeg:totalLegs-1,geometry:[]}]};
  const route=payload?.routes?.[0];
  if(!Array.isArray(payload?.routes)||payload.routes.length!==1||!route||!Number.isInteger(route.result_code))fail('INVALID_ROAD_ROUTE_RESPONSE');
  if(route.result_code!==0)return {...base,state:'error',error:'NO_ROAD_ROUTE',complete:false,coveredLegs:0,chunks:[]};
  const distance=route.summary?.distance,duration=route.summary?.duration;
  if(![distance,duration].every(n=>Number.isSafeInteger(n)&&n>=0)||distance>=1500000||!Array.isArray(route.sections)||route.sections.length!==providerLegs.length)fail('INVALID_ROAD_ROUTE_RESPONSE');
  let vertices=0,sumDistance=0,sumDuration=0;const geometry=[];
  route.sections.forEach((section,providerIndex)=>{
   const index=providerLegs[providerIndex];
   if(![section.distance,section.duration].every(n=>Number.isSafeInteger(n)&&n>=0)||!Array.isArray(section.roads)||!section.roads.length||section.roads.length>10000)fail('INVALID_ROAD_GEOMETRY');
   sumDistance+=section.distance;sumDuration+=section.duration;
   legs[index]={index,distanceMeters:section.distance,durationSeconds:section.duration};
   for(const road of section.roads){const v=road.vertexes;if(!Array.isArray(v)||v.length<4||v.length%2||vertices+v.length/2>100000)fail('INVALID_ROAD_GEOMETRY');
    const latLngs=[];for(let i=0;i<v.length;i+=2){coordinate({lng:v[i],lat:v[i+1]});latLngs.push([v[i+1],v[i]]);}vertices+=latLngs.length;geometry.push({legOffset:index,latLngs});
   }
  });
  if(Math.abs(sumDistance-distance)>providerLegs.length||Math.abs(sumDuration-duration)>providerLegs.length)fail('INCOMPLETE_ROAD_ROUTE');
  return {...base,state:'success',complete:true,coveredLegs:totalLegs,distanceMeters:distance,durationSeconds:duration,legs,chunks:[{state:'success',startLeg:0,endLeg:totalLegs-1,geometry}]};
 }
 const httpError=status=>status===401?'STAFF_LOGIN_REQUIRED':status===403?'PERMISSION_DENIED':status===429?'QUOTA_EXCEEDED':status===504?'TIMEOUT':status>=500?'PROVIDER_UNAVAILABLE':status===404?'FEATURE_DISABLED':'ROAD_ROUTE_FAILED';
 async function responseError(response){
  const allowed=new Set(['STAFF_LOGIN_REQUIRED','ORIGIN_REJECTED','STAGE_VERIFICATION_READ_ONLY','AUTHENTICATION_FAILED','PERMISSION_DENIED','QUOTA_EXCEEDED','CALL_POLICY_BLOCKED','CALL_POLICY_UNCONFIRMED','PERSISTENT_BUDGET_REQUIRED','FEATURE_DISABLED','KEY_MISSING','TIMEOUT','PROVIDER_UNAVAILABLE','NO_ROAD_ROUTE','INVALID_MANUAL_ROUTE','WAYPOINT_LIMIT','ROAD_ROUTE_FAILED','RECORDED_ORDER_REQUIRED','STOP_COORDINATES_MISSING']);
  try{
   const reader=response.body?.getReader();if(!reader)return httpError(response.status);
   const parts=[];let count=0;try{for(;;){const r=await reader.read();if(r.done)break;count+=r.value.byteLength;if(count>4096)throw Error();parts.push(r.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
   const bytes=new Uint8Array(count);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
   const body=JSON.parse(new TextDecoder().decode(bytes));const code=typeof body.error==='string'?body.error:body.error?.code;
   if(allowed.has(code))return code;
  }catch{}return httpError(response.status);
 }
 root.KakaoDirectionsAdapter=Object.freeze({plan,routePlan,fromProvider,httpError,responseError,coordinate});
})(typeof window==='object'?window:globalThis);
