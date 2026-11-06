import {createHash,randomUUID} from 'node:crypto';
import {createApprovedRoadBudgetPolicy,supportedRoadApis} from './roadBudgetPolicy.js';
// Reuse the existing private GitHub CAS transaction store. Approval and the
// already-consumed account usage must be provisioned by the operator; never
// create/reset a budget when a server starts or a ledger is missing.
export function createStoreRoadBudget({store,accountHash,env=process.env,now=Date.now}={}){
 const fail=code=>{throw Object.assign(Error(code),{code});};
 const {validate,stateStatus}=createApprovedRoadBudgetPolicy({accountHash,requireExplicitApis:true});
 const validateStage=(state,time)=>{
  if(!state?.roadBudget)fail('ROAD_BUDGET_LEDGER_MISSING');
  const key=String(env.KAKAO_MOBILITY_REST_API_KEY||env.KAKAO_REST_API_KEY||'').trim();
  if(!key||createHash('sha256').update(key).digest('hex')!==accountHash)fail('ROAD_BUDGET_ACCOUNT_MISMATCH');
  return validate(state,time);
 };
 const durable=typeof store?.transaction==='function';
 return {kind:'STAGE_PRIVATE_GITHUB_CAS',durable,inspectWhenDisabled:true,async status(){
  if(!durable)fail('ROAD_BUDGET_STORE_CONFIG');
  return store.transaction(async state=>{const time=now();return stateStatus(validateStage(state,time),time);});
 },async reserve({cost,provider,api}){
  if(!durable||cost!==1||provider!=='kakao-directions'||!supportedRoadApis.includes(api))fail('ROAD_BUDGET_INVALID_RESERVATION');
  return store.transaction(async(state,commit)=>{
   const time=now(),b=validateStage(state,time),status=stateStatus(b,time);
   if(!status.approvedApis.includes(api))fail('ROAD_BUDGET_API_UNVERIFIED');
   if(!status.remaining||!status.apiRemaining[api])fail('QUOTA_EXCEEDED');
   b.used++;b.apis[api].used++;b.lastReservation=randomUUID();b.updatedAt=new Date(time).toISOString();
   if(b.monthlyApproval){
    b.monthlyApproval.dailyUsage[status.usageDate]??={directions:0,waypoints:0};
    b.monthlyApproval.dailyUsage[status.usageDate][api]++;
   }
   await commit(state);
   const confirmedAt=now(),confirmed=stateStatus(validateStage(state,confirmedAt),confirmedAt);
   if(confirmed.usageDate!==status.usageDate)fail('ROAD_BUDGET_RESERVATION_DAY_CHANGED');
   return {reserved:true,...confirmed};
  });
 }};
}
export function createHubRoadBudget({callHub}={}){
 if(typeof callHub!=='function')throw TypeError('callHub required');
 let verification='UNVERIFIED';
 return {durable:true,get verification(){return verification;},async status(){
  const result=await callHub('mapRoadBudgetStatus',{}, {useCache:false,privateRead:true,maxResponseBytes:4096,deadline:Date.now()+8000});
  const d=result.data;if(d?.durable!==true||d.scope!=='CUMULATIVE_APPROVED_ACCOUNT'||!Number.isSafeInteger(d.remaining)||d.remaining<0)throw Error('ROAD_BUDGET_INVALID');verification='VERIFIED';return d;
 },async reserve({cost,provider}){
  try{const result=await callHub('mapRoadBudgetReserve',{reservationId:randomUUID(),cost,provider},{useCache:false,privateRead:true,maxResponseBytes:4096,deadline:Date.now()+8000});
   if(result.data?.reserved!==true||result.data.scope!=='CUMULATIVE_APPROVED_ACCOUNT'||!Number.isSafeInteger(result.data.remaining)||result.data.remaining<0)throw Error('ROAD_BUDGET_INVALID');verification='VERIFIED';return result.data;
  }catch(e){verification='UNVERIFIED';throw Object.assign(Error('ROAD_BUDGET_UNAVAILABLE'),{code:/EXHAUSTED/.test(e?.code||e?.message||'')?'QUOTA_EXCEEDED':'CALL_POLICY_BLOCKED'});}
 }};
}
