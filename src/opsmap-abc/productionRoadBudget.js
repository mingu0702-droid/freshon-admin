import {createHash,randomUUID} from 'node:crypto';

// Existing private Production auth branch, separate file. Never create a repo,
// branch or ledger, infer approval, reset counters, refund or retry a reservation.
const repo='mingu0702-droid/freshon-cache',branch='production/opsmap-auth';
const root='https://api.github.com/repos/'+repo,file=root+'/contents/opsmap-production/road-budget-v1.json';
const fail=(code='ROAD_BUDGET_UNAVAILABLE')=>{throw Object.assign(Error(code),{code});};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
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
 function validate(state){
  const b=state?.roadBudget;
  if(state?.schema!==1||!b||b.accountHash!==accountHash||b.scope!=='CUMULATIVE_APPROVED_ACCOUNT')fail('ROAD_BUDGET_ACCOUNT_MISMATCH');
  if(b.policy!=='FREE_ONLY'||b.providerPaidDisabled!==true||b.servicePermissionVerified!==true||!/^[-A-Za-z0-9_]{8,100}$/.test(b.approvalId||''))fail('ROAD_BUDGET_APPROVAL_REQUIRED');
  const verified=Date.parse(b.verifiedAt),expires=Date.parse(b.expiresAt),time=now();
  if(!Number.isFinite(verified)||!Number.isFinite(expires)||verified>time||expires<=time||expires<=verified||expires-verified>86400000)fail('ROAD_BUDGET_APPROVAL_EXPIRED');
  // No automatic daily rollover: the operator's evidence expires before the
  // next KST date and must be rechecked instead of replenishing free quota.
  const kst=value=>new Date(value+9*3600000).toISOString().slice(0,10);
  if(kst(verified)!==kst(time)||kst(verified)!==kst(expires-1))fail('ROAD_BUDGET_APPROVAL_EXPIRED');
  if(!integer(b.limit)||b.limit<1||b.limit>30000||!integer(b.used)||b.used>b.limit||!integer(b.monthlyFreeRemainingAtApproval)||b.monthlyFreeRemainingAtApproval>3000000||b.limit>b.monthlyFreeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  let total=0;
  for(const [api,max]of [['directions',10000],['waypoints',5000]]){
   const entry=b.apis?.[api];
   if(!entry||!integer(entry.freeRemainingAtApproval)||entry.freeRemainingAtApproval>max||!integer(entry.used)||entry.used>entry.freeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   total+=entry.used;
  }
  if(total!==b.used)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  return b;
 }
 function stateStatus(b){
  const apis=Object.fromEntries(Object.entries(b.apis).filter(([api])=>['directions','waypoints'].includes(api)).map(([api,value])=>[api,Math.max(0,value.freeRemainingAtApproval-value.used)]));
  return {durable:true,scope:b.scope,remaining:Math.max(0,Math.min(b.limit-b.used,b.monthlyFreeRemainingAtApproval-b.used,apis.directions+apis.waypoints)),apiRemaining:apis,freeOnly:true,approvalExpiresAt:b.expiresAt};
 }
 function transaction(work){const task=tail.catch(()=>{}).then(async()=>work(await read()));tail=task;return task;}
 return {kind:'PRODUCTION_PRIVATE_GITHUB_CAS',durable:configured,inspectWhenDisabled:true,
  status:()=>transaction(async({state})=>stateStatus(validate(state))),
  reserve:({cost,provider,api})=>transaction(async({state,sha})=>{
   if(cost!==1||provider!=='kakao-directions'||!['directions','waypoints'].includes(api))fail('ROAD_BUDGET_INVALID_RESERVATION');
   const b=validate(state),status=stateStatus(b);if(!status.remaining||!status.apiRemaining[api])fail('QUOTA_EXCEEDED');
   b.used++;b.apis[api].used++;b.lastReservation=randomUUID();b.updatedAt=new Date(now()).toISOString();
   // Write only the quota ledger; never serialize unrelated/session/customer fields.
   const clean={schema:1,roadBudget:Object.fromEntries(['accountHash','scope','policy','providerPaidDisabled','servicePermissionVerified','approvalId','verifiedAt','expiresAt','limit','used','monthlyFreeRemainingAtApproval','lastReservation','updatedAt'].map(k=>[k,b[k]]))};
   clean.roadBudget.apis=Object.fromEntries(['directions','waypoints'].map(api=>[api,{freeRemainingAtApproval:b.apis[api].freeRemainingAtApproval,used:b.apis[api].used}]));
   const bytes=Buffer.from(JSON.stringify(clean));if(bytes.length>32768)fail('ROAD_BUDGET_FORMAT');
   const response=await request(file,{method:'PUT',body:JSON.stringify({message:'Reserve approved Production free Directions call',branch,sha,content:bytes.toString('base64')})});
   if([409,422].includes(response.status))fail('ROAD_BUDGET_CONFLICT');if(!response.ok)fail('ROAD_BUDGET_WRITE');
   const saved=await read();if(JSON.stringify(saved.state)!==JSON.stringify(clean))fail('ROAD_BUDGET_READBACK_UNKNOWN');
   return {reserved:true,...stateStatus(validate(saved.state))};
  })};
}
