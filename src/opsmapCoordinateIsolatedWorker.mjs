import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFileCoordinateStore} from './opsmapCoordinateIngestion.js';
import {createOpsmapCDailyCandidate} from './opsmapCIntegration.js';
import {createLocalCoordinateSuccessBoundary,LOCAL_COORDINATE_POLICY} from './opsmapCoordinateSuccessBoundary.mjs';
import {createOpsmapCoordinatePrivateHandoff} from './opsmapCoordinatePrivateHandoff.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function testPolicy(value={}){
 const policy={};
 for(const [key,fallback,min,max]of [['maxRequestsPerRun',10,0,25],['maxDailyRequests',25,0,100],['maxAttempts',3,1,3],
  ['timeoutMs',1000,1,5000],['minIntervalMs',0,0,60000],['retryBaseMs',1000,1,60000]]){
  const n=value[key]??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('SYNTHETIC_POLICY_INVALID');policy[key]=n;
 }
 return Object.freeze({...policy,externalEnabled:false,externalApproved:false,maxDailyCostMicros:0,unitCostMicros:0});
}

// Composition only: existing PRIVATE consumer, existing C callbacks and existing
// single-worker file store. No account store, network reader, trigger or server.
export function createOpsmapCoordinateIsolatedWorker({enabled=false,isolationRoot,filePath,channel,
 verifiedCoordinates=[],addressCoordinateCache=[],syntheticTestProvider=null,syntheticTestPolicy={},
 inputMode='VERIFIED_ONLY',runTimeoutMs=6000,now=Date.now}={}){
 const status=Object.freeze({enabled:enabled===true,operational:false,accountWideDurability:false,
  storageScope:'ISOLATED_LOCAL_FILE',inputMode,syntheticProviderEnabled:!!syntheticTestProvider,
  externalEnabled:false,paidCalls:0,apiKeyUse:0,sourceWrites:0,triggers:0});
 let store;
 if(status.enabled){
  if(!path.isAbsolute(isolationRoot||'')||!path.isAbsolute(filePath||''))throw Error('ISOLATED_FILE_BINDING_REQUIRED');
  const relative=path.relative(path.resolve(isolationRoot),path.resolve(filePath));
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('ISOLATED_FILE_OUTSIDE_ROOT');
  if(typeof channel?.receive!=='function')throw Error('EXISTING_PRIVATE_READER_REQUIRED');
  if(!Number.isSafeInteger(runTimeoutMs)||runTimeoutMs<1||runTimeoutMs>30000)throw Error('ISOLATED_DEADLINE_INVALID');
  store=createFileCoordinateStore({filePath});
 }
 if(syntheticTestProvider&&(inputMode!=='SYNTHETIC_FIXTURE_ONLY'||syntheticTestProvider.kind!=='mock'||typeof syntheticTestProvider.lookup!=='function'))throw Error('SYNTHETIC_MOCK_PROVIDER_REQUIRED');
 const policy=testPolicy(syntheticTestPolicy);
 const metrics={syntheticCalls:0,externalCalls:0,paidCalls:0,apiKeyUse:0};
 async function afterPreparedDailyCollection({date,sequence,prepared}={}){
  if(!status.enabled)return {status:'OFF',applied:false};
  if(syntheticTestProvider&&prepared?.envelope?.meta?.coordinateInputScope!=='SYNTHETIC_FIXTURE_ONLY')return {status:'SYNTHETIC_INPUT_REQUIRED',applied:false};
  const until=performance.now()+runTimeoutMs;
  let runCalls=0;
  const provider=syntheticTestProvider?{kind:'mock',async lookup(request){
   const remaining=Math.floor(until-performance.now());
   if(remaining<1)throw Object.assign(Error('SYNTHETIC_DEADLINE'),{code:'TIMEOUT'});
   if(runCalls>=policy.maxRequestsPerRun)throw Error('SYNTHETIC_REQUEST_CAP');
   runCalls++;metrics.syntheticCalls++;
   let rejectAbort;
   const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
   const controller=new AbortController(),abort=()=>{controller.abort();rejectAbort(Object.assign(Error('SYNTHETIC_ABORT'),{code:'TIMEOUT'}));};
   request.signal.addEventListener('abort',abort,{once:true});
   if(request.signal.aborted)abort();
   let timer;
   try{return await Promise.race([aborted,syntheticTestProvider.lookup({...request,signal:controller.signal}),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('SYNTHETIC_DEADLINE'),{code:'TIMEOUT'}));},remaining);})]);}
   finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);}
  }}:null;
  const handoff=createOpsmapCoordinatePrivateHandoff({enabled:true,channel,store,createLocalCoordinateSuccessBoundary,
   createOpsmapCDailyCandidate,verifiedCoordinates,addressCoordinateCache,now,syntheticTestProvider:provider,syntheticTestPolicy:policy});
  return handoff.receive(date,sequence,prepared);
 }
 async function requeryPreparedDay({date,sequence,prepared}={}){
  if(!status.enabled)return {status:'OFF',applied:false};
  const delivered=await channel.receive(date,sequence);
  if(delivered?.status!=='DELIVERED')return {status:'HELD',applied:false};
  return store.transaction(async state=>{
   const ledger=state.coordinatePrivateHandoff?.days?.[date];
   const deliveryHash=hash({receipt:delivered.receipt,result:delivered.customerResult,sourceCandidateHash:prepared?.sourceCandidateHash,envelope:prepared?.envelope});
   if(!ledger||ledger.sequence!==sequence||ledger.deliveryHash!==deliveryHash||ledger.receiptHash!==hash(delivered.receipt))return {status:'REQUERY_BINDING_REJECTED',applied:false};
   // Existing C projector on a private clone; no persistence/provider on a read.
   const snapshot=structuredClone(state),candidate=createOpsmapCDailyCandidate({coordinates:{
    store:{transaction:work=>work(snapshot,async()=>{})},verifiedCoordinates,addressCoordinateCache,now,
    geocoder:null,policy:LOCAL_COORDINATE_POLICY}});
   const run=await candidate.afterCustomerDailyCollection(delivered.customerResult,{date,collectionComplete:true,
    businessCoverageVerified:false,sourceSnapshotHash:prepared.sourceCandidateHash,expectedVisits:prepared.expectedVisits});
   run.previousCoordinates={...run.previousCoordinates,...ledger.projectionPriorCoordinates};
   return {status:'REQUERIED_ISOLATED_PRIVATE',applied:true,envelope:candidate.projectDayEnvelope(prepared.envelope,run),
    durable:true,accountWideDurability:false,providerCalls:0};
  });
 }
 return Object.freeze({status,metrics,afterPreparedDailyCollection,requeryPreparedDay});
}
