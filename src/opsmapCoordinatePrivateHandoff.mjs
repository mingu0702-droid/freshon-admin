import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const copy=value=>structuredClone(value);

// Only caller-injected existing PRIVATE receive + already-prepared map binding.
// Persisted file scope is a single isolated worker, never account-wide storage.
export function createOpsmapCoordinatePrivateHandoff({enabled=false,channel,store,createLocalCoordinateSuccessBoundary,
 createOpsmapCDailyCandidate,verifiedCoordinates=[],addressCoordinateCache=[],now=Date.now,
 syntheticTestProvider=null,syntheticTestPolicy={}}={}){
 if(syntheticTestProvider&&(syntheticTestProvider.kind!=='mock'||typeof syntheticTestProvider.lookup!=='function'))throw Error('SYNTHETIC_MOCK_PROVIDER_REQUIRED');
 const status=Object.freeze({enabled:enabled===true,operational:false,accountWideDurability:false,storageScope:'ISOLATED_LOCAL_FILE',
  externalEnabled:false,maxRequestsPerRun:0,maxDailyCostMicros:0});
 async function receive(date,sequence,prepared){
  if(!status.enabled)return {status:'OFF',applied:false};
  if(typeof channel?.receive!=='function'||typeof store?.transaction!=='function'||typeof createLocalCoordinateSuccessBoundary!=='function'||typeof createOpsmapCDailyCandidate!=='function')throw Error('COORDINATE_PRIVATE_BINDINGS_REQUIRED');
  const delivered=await channel.receive(date,sequence);
  if(delivered?.status!=='DELIVERED')return {status:'HELD',applied:false,reason:delivered?.reason||'PRIVATE_RECEIPT_NOT_DELIVERED'};
  const receipt=delivered.receipt,envelope=prepared?.envelope,result=delivered.customerResult;
  if(syntheticTestProvider&&envelope?.meta?.coordinateInputScope!=='SYNTHETIC_FIXTURE_ONLY')return {status:'SYNTHETIC_INPUT_REQUIRED',applied:false};
  if(receipt?.schema!=='daily-date-change-v3'||receipt.status!=='READBACK_VERIFIED'||receipt.date!==date||receipt.sequence!==sequence||
   receipt.sourceCollectionCompleteness!=='NOT_INFERRED'||!isHash(receipt.runHash)||!Number.isSafeInteger(sequence)||sequence<1||
   !result||!Array.isArray(result.rows)||!prepared||prepared.date!==date||prepared.receiptHash!==hash(receipt)||
   JSON.stringify(prepared.sourceVersions)!==JSON.stringify(receipt.afterVersions)||!isHash(prepared.sourceCandidateHash)||
   envelope?.meta?.sourceCandidateHash!==prepared.sourceCandidateHash||prepared.expectedVisits!==result.rows.length||
   prepared.expectedVisits!==envelope?.meta?.returnedVisits||envelope.meta.date!==date)
   return {status:'SOURCE_BINDING_REJECTED',applied:false};
  // Pin caller objects before awaiting the existing durable lock.
  const pinned={receipt:copy(receipt),result:copy(result),envelope:copy(envelope),prepared:copy(prepared)};
  const deliveryHash=hash({receipt:pinned.receipt,result:pinned.result,sourceCandidateHash:pinned.prepared.sourceCandidateHash,envelope:pinned.envelope});
  try{return await store.transaction(async(state,checkpoint)=>{
   const ledger=state.coordinatePrivateHandoff||{schema:1,days:{}};
   if(ledger.schema!==1||!ledger.days||Object.keys(ledger.days).length>10000)throw Error('COORDINATE_HANDOFF_LEDGER_INVALID');
   const prior=ledger.days[date];
   if(prior&&sequence<prior.sequence)return {status:'STALE_DELIVERY',applied:false};
   if(prior&&sequence===prior.sequence)return {status:deliveryHash===prior.deliveryHash?'DUPLICATE_DELIVERY':'CONFLICTING_DELIVERY',applied:false};
   if(prior&&(sequence!==prior.sequence+1||pinned.receipt.previousHash!==prior.receiptHash))return {status:'RECEIPT_CHAIN_REJECTED',applied:false};
   if(!prior&&(sequence!==1||pinned.receipt.previousHash!==null))return {status:'RECEIPT_BASELINE_REQUIRED',applied:false};
   const projectionPriorCoordinates=Object.fromEntries(pinned.envelope.data.flatMap(tuple=>{
    const row=state.customers[tuple[0]];return row?.status==='READY'&&Number.isFinite(tuple[3])&&Number.isFinite(tuple[4])&&
     Math.abs(tuple[3]-row.lat)<=0.00001&&Math.abs(tuple[4]-row.lng)<=0.00001?
     [[tuple[0],{customerCode:row.customerCode,addressHash:row.addressHash,lat:row.lat,lng:row.lng}]]:[];
   }));
   // Existing zero-provider commits remain atomic with their delivery ledger.
   // Synthetic provider reservations must reach the existing fsync checkpoint
   // BEFORE lookup, including retries; the receipt ledger is committed last.
   let checkpointed=false;
   const transactionStore={transaction:work=>work(state,async next=>{if(next!==state)throw Error('COORDINATE_STATE_REPLACED');checkpointed=true;if(syntheticTestProvider)await checkpoint(next);})};
   const boundary=createLocalCoordinateSuccessBoundary({createOpsmapCDailyCandidate,enabled:true,coordinates:{
    store:transactionStore,verifiedCoordinates,addressCoordinateCache,now},syntheticTestProvider,syntheticTestPolicy});
   const ticket=boundary.begin(date);
   const outcome=await boundary.afterCustomerDailyCollection(pinned.result,{ticket,envelope:pinned.envelope,collectionComplete:true,
    sourceSnapshotHash:pinned.prepared.sourceCandidateHash,expectedVisits:pinned.prepared.expectedVisits});
   if(outcome.applied!==true||!checkpointed)return {status:outcome.status,applied:false};
   ledger.days[date]={sequence,receiptHash:hash(pinned.receipt),deliveryHash,sourceCandidateHash:pinned.prepared.sourceCandidateHash,projectionPriorCoordinates};
   state.coordinatePrivateHandoff=ledger;
   await checkpoint(state);
   return {...outcome,status:'COMMITTED_ISOLATED_PRIVATE',durable:true,accountWideDurability:false};
  });}catch(error){return {status:'PRIVATE_COMMIT_FAILED',applied:false,retryable:true,reason:/^COORDINATE_STORAGE_/.test(error.message)?error.message:'PRIVATE_TRANSACTION_FAILED'};}
 }
 return Object.freeze({status,receive});
}
