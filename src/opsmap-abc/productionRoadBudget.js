import {createHash,randomUUID} from 'node:crypto';

// Existing private Production auth branch, separate file. Never create a repo,
// branch or ledger, infer approval, reset counters, refund or retry a reservation.
const repo='mingu0702-droid/freshon-cache',branch='production/opsmap-auth';
const root='https://api.github.com/repos/'+repo,file=root+'/contents/opsmap-production/road-budget-v1.json';
const fail=(code='ROAD_BUDGET_UNAVAILABLE')=>{throw Object.assign(Error(code),{code});};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
// Official daily free ceilings, checked 2026-11-04:
// https://developers.kakaomobility.com/price/
const dailyLimits=Object.freeze({directions:10000,waypoints:5000});
const supportedApis=Object.keys(dailyLimits);
const kst=value=>new Date(value+9*3600000).toISOString().slice(0,10);
export const productionRoadRouteFlag=env=>env.OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED==='1'?'1':'0';
export function createProductionRoadBudget({env=process.env,token,fetchImpl=fetch,now=Date.now}={}){
 if(env.OPSMAP_ROAD_BUDGET_STORE_ENABLED!=='1')return null;
 const key=String(env.KAKAO_MOBILITY_REST_API_KEY||env.KAKAO_REST_API_KEY||'').trim();
 const accountHash=createHash('sha256').update(key).digest('hex');
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
  return {state,sha:data.sha};
 }
 function validate(state,time){
  const b=state?.roadBudget;
  if(state?.schema!==1||!b||b.accountHash!==accountHash||b.scope!=='CUMULATIVE_APPROVED_ACCOUNT')fail('ROAD_BUDGET_ACCOUNT_MISMATCH');
  if(b.policy!=='FREE_ONLY'||b.providerPaidDisabled!==true||b.servicePermissionVerified!==true||!/^[-A-Za-z0-9_]{8,100}$/.test(b.approvalId||''))fail('ROAD_BUDGET_APPROVAL_REQUIRED');
  if(b.approvedApis!==undefined&&(!Array.isArray(b.approvedApis)||!b.approvedApis.length||new Set(b.approvedApis).size!==b.approvedApis.length||b.approvedApis.some(api=>!supportedApis.includes(api))))fail('ROAD_BUDGET_APPROVAL_REQUIRED');
  const observed=b.providerDailyUsedAtApproval;
  if(observed!==undefined&&(!b.approvedApis||!observed||typeof observed!=='object'||Array.isArray(observed)||
   Object.keys(observed).length!==b.approvedApis.length||b.approvedApis.some(api=>!integer(observed[api])||
    observed[api]+b.apis?.[api]?.freeRemainingAtApproval>dailyLimits[api])))fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  const verified=Date.parse(b.verifiedAt),expires=Date.parse(b.expiresAt);
  if(!Number.isFinite(verified)||!Number.isFinite(expires)||verified>time||expires<=time||expires<=verified)fail('ROAD_BUDGET_APPROVAL_EXPIRED');
  if(b.monthlyApproval){
   const m=b.monthlyApproval,period=kst(verified).slice(0,7);
   // Basic Directions refuses overage under a verified free-only approval.
   // The ledger reserves local calls; the provider still enforces shared use.
   const hardFreeLimit=m.providerRejectsFreeOverage===true&&b.approvedApis?.length===1&&b.approvedApis[0]==='directions'&&integer(observed?.directions);
   if(m.period!==period||kst(time).slice(0,7)!==period||kst(expires-1).slice(0,7)!==period||
      (m.exclusiveDirectionsUsage!==true&&!hardFreeLimit))fail('ROAD_BUDGET_MONTHLY_APPROVAL_REQUIRED');
   if(!m.dailyUsage||typeof m.dailyUsage!=='object'||Array.isArray(m.dailyUsage)||Object.keys(m.dailyUsage).length>31)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   for(const [day,counts]of Object.entries(m.dailyUsage)){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||day.slice(0,7)!==period||day>kst(time))fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
    for(const [api,max]of Object.entries(dailyLimits))if(!integer(counts?.[api])||counts[api]>max)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   }
  }else if(expires-verified>86400000||kst(verified)!==kst(time)||kst(verified)!==kst(expires-1))fail('ROAD_BUDGET_APPROVAL_EXPIRED');
  if(!integer(b.limit)||b.limit<1||b.limit>30000||!integer(b.used)||b.used>b.limit||!integer(b.monthlyFreeRemainingAtApproval)||b.monthlyFreeRemainingAtApproval>3000000||b.limit>b.monthlyFreeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  let total=0;
  for(const [api,max]of Object.entries(dailyLimits)){
   const entry=b.apis?.[api];
   if(!entry||!integer(entry.freeRemainingAtApproval)||entry.freeRemainingAtApproval>max||!integer(entry.used)||!b.monthlyApproval&&entry.used>entry.freeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   if(b.monthlyApproval){
    const m=b.monthlyApproval,prior=m.usedBeforeWindow?.[api];
    if(!integer(prior)||prior+Object.values(m.dailyUsage).reduce((sum,counts)=>sum+counts[api],0)!==entry.used||(m.dailyUsage[kst(verified)]?.[api]||0)>entry.freeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   }
   total+=entry.used;
  }
  if(total!==b.used)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  return b;
 }
 function stateStatus(b,time){
  const day=kst(time),approvalDay=kst(Date.parse(b.verifiedAt));
  // Earlier verified ledgers covered both endpoints. A scoped approval stays
  // scoped across daily rollover and still accounts for prior calls to either.
  const approved=b.approvedApis??supportedApis;
  const apis=Object.fromEntries(supportedApis.map(api=>{
   if(!approved.includes(api))return [api,0];
   const value=b.apis[api];
   const remaining=b.monthlyApproval?(day===approvalDay?value.freeRemainingAtApproval:dailyLimits[api])-(b.monthlyApproval.dailyUsage[day]?.[api]||0):value.freeRemainingAtApproval-value.used;
   return [api,Math.max(0,remaining)];
  }));
  return {durable:true,scope:b.scope,remaining:Math.max(0,Math.min(b.limit-b.used,b.monthlyFreeRemainingAtApproval-b.used,apis.directions+apis.waypoints)),apiRemaining:apis,freeOnly:true,approvalExpiresAt:b.expiresAt,approvalWindow:b.monthlyApproval?'KST_MONTH':'KST_DAY',usageDate:day};
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
