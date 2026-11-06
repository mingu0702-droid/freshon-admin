import {createHash,randomUUID} from 'node:crypto';
import {createApprovedRoadBudgetPolicy,supportedRoadApis} from './roadBudgetPolicy.js';

// Existing private Production auth branch, separate file. Never create a repo,
// branch or ledger, infer approval, reset counters, refund or retry a reservation.
const repo='mingu0702-droid/freshon-cache',branch='production/opsmap-auth';
const root='https://api.github.com/repos/'+repo,file=root+'/contents/opsmap-production/road-budget-v1.json';
const fail=(code='ROAD_BUDGET_UNAVAILABLE')=>{throw Object.assign(Error(code),{code});};
const supportedApis=supportedRoadApis;
export const productionRoadRouteFlag=env=>env.OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED==='1'?'1':'0';
export function createProductionRoadBudget({env=process.env,token,fetchImpl=fetch,now=Date.now}={}){
 if(env.OPSMAP_ROAD_BUDGET_STORE_ENABLED!=='1')return null;
 const key=String(env.KAKAO_MOBILITY_REST_API_KEY||env.KAKAO_REST_API_KEY||'').trim();
 const accountHash=createHash('sha256').update(key).digest('hex');
 const {validate,stateStatus}=createApprovedRoadBudgetPolicy({accountHash});
 const configured=env.OPSMAP_AUTH_STORE_REPO===repo&&env.OPSMAP_AUTH_STORE_BRANCH===branch&&typeof token==='string'&&!!token&&!!key;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'opsmap-production-road-budget'};
 let tail=Promise.resolve();
 async function request(url,options={}){
  try{return await fetchImpl(url,{...options,headers,redirect:'error',signal:AbortSignal.timeout(10000)});}
  catch{fail(options.method==='PUT'?'ROAD_BUDGET_WRITE_OUTCOME_UNKNOWN':'ROAD_BUDGET_NETWORK');}
 }
 async function read(){
  if(!configured)fail('ROAD_BUDGET_STORE_CONFIG');
  const info=await request(root);if(!info.ok)fail('ROAD_BUDGET_STORE_PERMISSION');
  const permission=await info.json();if(permission.private!==true||permission.permissions?.push!==true)fail('ROAD_BUDGET_PRIVATE_WRITE_REQUIRED');
  const response=await request(file+'?ref='+encodeURIComponent(branch));
  if(response.status===404)fail('ROAD_BUDGET_LEDGER_MISSING');if(!response.ok)fail('ROAD_BUDGET_READ');
  const data=await response.json();
  if(data.encoding!=='base64'||!/^[a-f0-9]{40}$/.test(data.sha||'')||typeof data.content!=='string'||data.content.length>45000)fail('ROAD_BUDGET_FORMAT');
  let state;try{const bytes=Buffer.from(data.content,'base64');if(bytes.length>32768)fail();state=JSON.parse(bytes.toString('utf8'));}catch{fail('ROAD_BUDGET_FORMAT');}
  if(state?.schema!==1)fail('ROAD_BUDGET_ACCOUNT_MISMATCH');
  return {state,sha:data.sha};
 }
 function transaction(work){const task=tail.catch(()=>{}).then(async()=>work(await read()));tail=task;return task;}
 return {kind:'PRODUCTION_PRIVATE_GITHUB_CAS',durable:configured,inspectWhenDisabled:true,
  status:()=>transaction(async({state})=>{
   const time=now();return stateStatus(validate(state,time),time);
  }),
  reserve:({cost,provider,api})=>transaction(async({state,sha})=>{
   if(cost!==1||provider!=='kakao-directions'||!supportedApis.includes(api))fail('ROAD_BUDGET_INVALID_RESERVATION');
   const time=now(),b=validate(state,time),status=stateStatus(b,time);
   if(b.approvedApis&&!b.approvedApis.includes(api))fail('ROAD_BUDGET_API_UNVERIFIED');
   if(!status.remaining||!status.apiRemaining[api])fail('QUOTA_EXCEEDED');
   b.used++;b.apis[api].used++;b.lastReservation=randomUUID();b.updatedAt=new Date(time).toISOString();
   if(b.monthlyApproval){const day=status.usageDate;b.monthlyApproval.dailyUsage[day]||={directions:0,waypoints:0};b.monthlyApproval.dailyUsage[day][api]++;}
   // Write only the quota ledger; never serialize unrelated/session/customer fields.
   const clean={schema:1,roadBudget:Object.fromEntries(['accountHash','scope','policy','providerPaidDisabled','servicePermissionVerified','approvalId','verifiedAt','expiresAt','limit','used','monthlyFreeRemainingAtApproval','lastReservation','updatedAt'].map(k=>[k,b[k]]))};
   if(b.approvedApis)clean.roadBudget.approvedApis=b.approvedApis.slice();
   if(b.providerDailyUsedAtApproval)clean.roadBudget.providerDailyUsedAtApproval={...b.providerDailyUsedAtApproval};
   clean.roadBudget.apis=Object.fromEntries(supportedApis.map(api=>[api,{freeRemainingAtApproval:b.apis[api].freeRemainingAtApproval,used:b.apis[api].used}]));
   if(b.monthlyApproval)clean.roadBudget.monthlyApproval={
    period:b.monthlyApproval.period,
    ...(b.monthlyApproval.exclusiveDirectionsUsage===true?{exclusiveDirectionsUsage:true}:{providerRejectsFreeOverage:true}),
    usedBeforeWindow:{directions:b.monthlyApproval.usedBeforeWindow.directions,waypoints:b.monthlyApproval.usedBeforeWindow.waypoints},
    dailyUsage:structuredClone(b.monthlyApproval.dailyUsage)
   };
   const bytes=Buffer.from(JSON.stringify(clean));if(bytes.length>32768)fail('ROAD_BUDGET_FORMAT');
   const response=await request(file,{method:'PUT',body:JSON.stringify({message:'Reserve approved Production free Directions call',branch,sha,content:bytes.toString('base64')})});
   if([409,422].includes(response.status))fail('ROAD_BUDGET_CONFLICT');if(!response.ok)fail('ROAD_BUDGET_WRITE');
   const saved=await read();if(JSON.stringify(saved.state)!==JSON.stringify(clean))fail('ROAD_BUDGET_READBACK_UNKNOWN');
   // A verified reservation is usable only on the KST day it was charged.
   // Keep an already committed reservation if readback crosses midnight.
   const confirmedAt=now(),confirmedStatus=stateStatus(validate(saved.state,confirmedAt),confirmedAt);
   if(confirmedStatus.usageDate!==status.usageDate)fail('ROAD_BUDGET_RESERVATION_DAY_CHANGED');
   return {reserved:true,...confirmedStatus};
  })};
}
