import {randomUUID} from 'node:crypto';
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
