// Local candidate: only a dedicated Stage branch/path of an already-private repo.
// No credential, repository or branch is created and no request is retried.
import crypto from 'node:crypto';
const fail=(code,status=503)=>{throw Object.assign(new Error(code),{code,status});};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function createManualPinGithubStore({repo,token,branch,productionBranch='main',fetchImpl=fetch}={}){
 if(!/^[-\w.]+\/[-\w.]+$/.test(repo||'')||!token||branch!=='stage/opsmap-manual-pins'||branch===productionBranch)fail('MANUAL_PIN_GITHUB_CONFIG');
 const root='https://api.github.com/repos/'+repo,api=root+'/contents/opsmap-stage/manual-pins-v1.json',headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'opsmap-manual-pin-stage'};
 async function request(url,options={}){try{return await fetchImpl(url,{...options,headers,signal:AbortSignal.timeout(12000)});}catch{fail(options.method==='PUT'?'MANUAL_PIN_WRITE_OUTCOME_UNKNOWN':'MANUAL_PIN_GITHUB_NETWORK');}}
 async function read(){
  const r=await request(root);if(!r.ok)fail('MANUAL_PIN_GITHUB_PERMISSION');const repoInfo=await r.json();if(repoInfo.private!==true||repoInfo.permissions?.push!==true)fail('MANUAL_PIN_GITHUB_PRIVATE_WRITE_REQUIRED');
  const v=await request(api+'?ref='+encodeURIComponent(branch));if(v.status===404)fail('MANUAL_PIN_GITHUB_FILE_OR_BRANCH_MISSING');if(!v.ok)fail('MANUAL_PIN_GITHUB_READ');const m=await v.json();
  if(!/^[a-f0-9]{40}$/.test(m.sha||'')||m.encoding!=='base64'||typeof m.content!=='string')fail('MANUAL_PIN_GITHUB_FORMAT');
  const b=Buffer.from(m.content,'base64');if(b.length>512000)fail('MANUAL_PIN_GITHUB_SIZE');let value;try{value=JSON.parse(b.toString('utf8'));}catch{fail('MANUAL_PIN_GITHUB_FORMAT');}
  return {sha:m.sha,value};
 }
 function safeBytes(value){
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>512000)fail('MANUAL_PIN_GITHUB_SIZE');
  // Addresses, notes and authentication data cannot enter this repository file.
  if(/"(?:originalAddress|correctedSearchAddress|detailAddress|password|token|cookie|secret|accessInfo|deliveryMemo)"\s*:/i.test(text))fail('MANUAL_PIN_GITHUB_PRIVATE_FIELD');
  return Buffer.from(text,'utf8');
 }
 // The previous private Git commit is the backup; each new state also carries
 // the complete per-customer audit chain. No second file is written.
 return {kind:'github-stage-cas-v1',backupStore:{async transaction(work){return work(null,async()=>{});}},async transaction(work){const old=await read(),state=structuredClone(old.value);let wrote=false;
  return work(state,async next=>{if(wrote)fail('MANUAL_PIN_GITHUB_SINGLE_WRITE');wrote=true;const bytes=safeBytes(next);
   const response=await request(api,{method:'PUT',body:JSON.stringify({message:'Update isolated Stage manual pins',branch,sha:old.sha,content:bytes.toString('base64')})});
   if([409,422].includes(response.status))fail('MANUAL_PIN_GITHUB_CONFLICT',409);if(!response.ok)fail('MANUAL_PIN_GITHUB_WRITE');
   let saved;try{saved=await read();}catch{fail('MANUAL_PIN_GITHUB_READBACK_UNKNOWN');}if(hash(Buffer.from(JSON.stringify(saved.value),'utf8'))!==hash(bytes))fail('MANUAL_PIN_GITHUB_READBACK_UNKNOWN');
  });
 }};
}
