// Local candidate: only a dedicated Stage branch/path of an already-private repo.
// No credential, repository or branch is created and no request is retried.
import crypto from 'node:crypto';
const fail=(code,status=503)=>{throw Object.assign(new Error(code),{code,status});};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const geocodeLedger=Symbol('stage-geocode-ledger');
// The Stage repository lease is bounded from the checked GET and never extended by a write receipt.
const geocodeReadLeaseMs=5000;
export function createStageGeocodeBudgetStore(options){
 const store=createManualPinGithubStore({...options,[geocodeLedger]:true});let tail=Promise.resolve();
 return {...store,durable:true,transaction(work,options){const result=tail.then(()=>store.transaction(work,options));tail=result.catch(()=>{});return result;}};
}
export function createManualPinGithubStore({repo,token,branch,productionBranch='main',fetchImpl=fetch,clock=()=>performance.now(),[geocodeLedger]:geocode=false}={}){
 if(!/^[-\w.]+\/[-\w.]+$/.test(repo||'')||!token||branch!=='stage/opsmap-manual-pins'||branch===productionBranch)fail('MANUAL_PIN_GITHUB_CONFIG');
 const root='https://api.github.com/repos/'+repo;
 const filePath='opsmap-stage/'+(geocode?'geocode-budget-v1.json':'manual-pins-v1.json');
 const api=root+'/contents/'+filePath;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'opsmap-manual-pin-stage'};
 let committedLedger=null,repositoryUntil=0,ledgerUntil=0;
 async function request(url,options,onRequest){
  onRequest?.(options?.method||'GET');
  try{return await fetchImpl(url,{...options,headers,signal:AbortSignal.timeout(12000)});}
  catch{fail(options?.method==='PUT'?'MANUAL_PIN_WRITE_OUTCOME_UNKNOWN':'MANUAL_PIN_GITHUB_NETWORK');}
 }
 async function verifyPrivateWritePermission(reuse,onRequest){
  const started=clock();
  if(reuse&&started<repositoryUntil)return;
  repositoryUntil=0;
  const response=await request(root,undefined,onRequest);
  if(!response.ok)fail('MANUAL_PIN_GITHUB_PERMISSION');
  const info=await response.json();
  if(info.private!==true||info.permissions?.push!==true)fail('MANUAL_PIN_GITHUB_PRIVATE_WRITE_REQUIRED');
  if(geocode)repositoryUntil=started+geocodeReadLeaseMs;
 }
 async function readFile(onRequest){
  const v=await request(api+'?ref='+encodeURIComponent(branch),undefined,onRequest);if(v.status===404)fail('MANUAL_PIN_GITHUB_FILE_OR_BRANCH_MISSING');if(!v.ok)fail('MANUAL_PIN_GITHUB_READ');const m=await v.json();
  if(!/^[a-f0-9]{40}$/.test(m.sha||'')||m.encoding!=='base64'||typeof m.content!=='string')fail('MANUAL_PIN_GITHUB_FORMAT');
  const b=Buffer.from(m.content,'base64');if(b.length>512000)fail('MANUAL_PIN_GITHUB_SIZE');let value;try{value=JSON.parse(b.toString('utf8'));}catch{fail('MANUAL_PIN_GITHUB_FORMAT');}
  return {sha:m.sha,value};
 }
 async function read({reservation=false,status=false,onRequest}={}){
  if(!geocode){await verifyPrivateWritePermission(false,onRequest);return readFile(onRequest);}
  const started=clock();
  const cached=committedLedger&&(reservation||status&&started<ledgerUntil);
  const [,state]=await Promise.all([
   verifyPrivateWritePermission(reservation||status,onRequest),cached?committedLedger:readFile(onRequest)
  ]);
  committedLedger=state;
  if(!cached)ledgerUntil=started+geocodeReadLeaseMs;
  return state;
 }
 async function githubWriteReceipt(response,bytes){
  let receipt;
  try{receipt=await response.json();}catch{return null;}
  const gitBlobSha=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(receipt?.content?.type!=='file'||receipt.content.path!==filePath||receipt.content.sha!==gitBlobSha||
    !/^[a-f0-9]{40}$/.test(receipt.commit?.sha||''))return null;
  return {sha:gitBlobSha,value:JSON.parse(bytes.toString('utf8'))};
 }
 function safeBytes(value){
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>512000)fail('MANUAL_PIN_GITHUB_SIZE');
  // Addresses, notes and authentication data cannot enter this repository file.
  if(/"(?:originalAddress|correctedSearchAddress|detailAddress|password|token|cookie|secret|accessInfo|deliveryMemo)"\s*:/i.test(text))fail('MANUAL_PIN_GITHUB_PRIVATE_FIELD');
  if(geocode&&/"(?:lat|lng|latitude|longitude|address|documents|matchedAddress)"\s*:/i.test(text))fail('GEOCODE_RESULT_RETENTION_FORBIDDEN');
  return Buffer.from(text,'utf8');
 }
 // The previous private Git commit is the backup; each new state also carries
 // the complete per-customer audit chain. No second file is written.
 return {kind:'github-stage-cas-v1',backupStore:{async transaction(work){return work(null,async()=>{});}},async transaction(work,options={}){
  const {reservation=false,onRequest}=options;
  const useCommittedLedger=geocode&&reservation;
  const old=await read(options),state=structuredClone(old.value);let wrote=false;
  return work(state,async next=>{if(wrote)fail('MANUAL_PIN_GITHUB_SINGLE_WRITE');wrote=true;const bytes=safeBytes(next);
   // The expected blob SHA rejects stale reservations, including after another instance writes.
   committedLedger=null;
   try{
    if(useCommittedLedger&&clock()>=repositoryUntil)await verifyPrivateWritePermission(false,onRequest);
    const response=await request(api,{method:'PUT',body:JSON.stringify({message:geocode?'Reserve Stage geocode request count':'Update isolated Stage manual pins',branch,sha:old.sha,content:bytes.toString('base64')})},onRequest);
    if([409,422].includes(response.status))fail('MANUAL_PIN_GITHUB_CONFLICT',409);
    if(!response.ok)fail('MANUAL_PIN_GITHUB_WRITE');
    if(useCommittedLedger){
     committedLedger=await githubWriteReceipt(response,bytes);
     if(committedLedger){ledgerUntil=clock()+geocodeReadLeaseMs;return;}
    }
    let saved;
    try{saved=await (geocode?readFile(onRequest):read({onRequest}));}catch{fail('MANUAL_PIN_GITHUB_READBACK_UNKNOWN');}
    if(hash(Buffer.from(JSON.stringify(saved.value),'utf8'))!==hash(bytes))fail('MANUAL_PIN_GITHUB_READBACK_UNKNOWN');
    if(geocode){committedLedger=saved;ledgerUntil=clock()+geocodeReadLeaseMs;}
   }catch(error){
    repositoryUntil=ledgerUntil=0;
    throw error;
   }
  });
 }};
}
