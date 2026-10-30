import {randomUUID} from 'node:crypto';
// Reuse the existing private GitHub CAS transaction store. Approval and the
// already-consumed account usage must be provisioned by the operator; never
// create/reset a budget when a server starts or a ledger is missing.
export function createStoreRoadBudget({store,accountHash}={}){
 const fail=()=>{throw Object.assign(Error('ROAD_BUDGET_UNAVAILABLE'),{code:'CALL_POLICY_BLOCKED'});};
 const validate=state=>{
  const b=state?.roadBudget;
  if(!/^[a-f0-9]{64}$/.test(accountHash||'')||!b||b.accountHash!==accountHash||b.scope!=='CUMULATIVE_APPROVED_ACCOUNT'||
   !/^[-A-Za-z0-9_]{8,100}$/.test(b.approvalId||'')||!Number.isSafeInteger(b.limit)||b.limit<1||b.limit>30000||
   !Number.isSafeInteger(b.used)||b.used<0||b.used>b.limit)fail();
  return b;
 };
 return {durable:true,async status(){
  if(!store?.transaction)fail();
  return store.transaction(async state=>{const b=validate(state);return {durable:true,scope:b.scope,remaining:b.limit-b.used};});
 },async reserve({cost,provider}){
  if(!store?.transaction||cost!==1||provider!=='kakao-directions')fail();
  return store.transaction(async(state,commit)=>{
   const b=validate(state);
   if(b.used>=b.limit)throw Object.assign(Error('QUOTA_EXCEEDED'),{code:'QUOTA_EXCEEDED'});
   b.used++;b.lastReservation=randomUUID();b.updatedAt=new Date().toISOString();
   await commit(state);return {reserved:true,scope:b.scope,remaining:b.limit-b.used};
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
