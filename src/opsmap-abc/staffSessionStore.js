import crypto from 'node:crypto';

// Production-only authentication scope; never uses the Stage repository or pin file.
// Stores only HMAC session identifiers, signed expiry metadata and credential revision.
export function createProductionStaffSessionStore({env=process.env,fetchImpl=fetch,now=Date.now}={}){
  if(env.OPSMAP_PRODUCTION_SESSION_ENABLED!=='1')return undefined;
  if(!/^[-\w.]+\/[-\w.]+$/.test(env.GITHUB_CACHE_REPO||'')||env.GITHUB_CACHE_REPO==='mingu0702-droid/freshon-cache'||!env.GITHUB_TOKEN||env.OPSMAP_MANUAL_PIN_GITHUB_BRANCH!=='production/opsmap-auth'||!env.MAP_STAFF_SESSION_SECRET)throw Error('STAFF_SESSION_STORE_CONFIG');
  const root='https://api.github.com/repos/'+env.GITHUB_CACHE_REPO;
  const branch='production/opsmap-auth',file=root+'/contents/opsmap-production/staff-sessions-v1.json';
  const headers={Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'opsmap-production-staff-session'};
  const fail=()=>{throw Error('STAFF_SESSION_STORE_UNAVAILABLE');};
  const mac=value=>crypto.createHmac('sha256',env.MAP_STAFF_SESSION_SECRET).update('staff-session-v1:'+JSON.stringify(value)).digest('hex');
  async function request(url,options={}){try{return await fetchImpl(url,{...options,headers,redirect:'error',signal:AbortSignal.timeout(10000)});}catch{fail();}}
  async function read(){
    const info=await request(root);if(!info.ok)fail();const repo=await info.json();if(repo.private!==true||repo.permissions?.push!==true)fail();
    const r=await request(file+'?ref='+encodeURIComponent(branch));if(r.status===404)return {sha:null,state:{schema:1,sessions:{}}};if(!r.ok)fail();
    const data=await r.json();if(data.encoding!=='base64'||! /^[a-f0-9]{40}$/.test(data.sha||'')||data.size>512000)fail();
    let state;try{const bytes=Buffer.from(data.content,'base64');if(bytes.length>512000)fail();state=JSON.parse(bytes.toString('utf8'));}catch{fail();}
    if(state.schema!==1||!state.sessions||Array.isArray(state.sessions)||Object.keys(state.sessions).length>1000)fail();
    return {sha:data.sha,state};
  }
  function valid(key,entry){
    if(!entry||! /^[a-f0-9]{64}$/.test(key))return false;
    const {signature,...body}=entry;const expected=mac({key,...body});
    return /^[a-f0-9]{64}$/.test(signature||'')&&crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))&&Number.isFinite(entry.expiresAt)&&Number.isFinite(entry.idleExpiresAt)&&entry.idleExpiresAt<=entry.expiresAt;
  }
  let pendingRead=null,writeTail=Promise.resolve();
  async function sharedRead(){if(!pendingRead){const p=read();pendingRead=p;try{return await p;}finally{if(pendingRead===p)pendingRead=null;}}return pendingRead;}
  async function write(key,entry,requireExisting=false){
    const work=writeTail.catch(()=>{}).then(async()=>{
      pendingRead=null;const {sha,state}=await read();
      for(const [id,value]of Object.entries(state.sessions))if(!valid(id,value)||now()>=value.expiresAt||now()>=value.idleExpiresAt)delete state.sessions[id];
      if(requireExisting&&(!valid(key,state.sessions[key])||state.sessions[key].fingerprint!==entry.fingerprint||state.credentialFingerprint!==entry.fingerprint))return false;
      if(entry){if(state.credentialFingerprint!==entry.fingerprint){state.sessions={};state.credentialFingerprint=entry.fingerprint;}if(Object.keys(state.sessions).length>=1000&&!state.sessions[key])fail();state.sessions[key]={...entry,signature:mac({key,...entry})};}else delete state.sessions[key];
      const bytes=Buffer.from(JSON.stringify(state));if(bytes.length>512000)fail();
      const result=await request(file,{method:'PUT',body:JSON.stringify({message:'Update isolated Production staff session metadata',branch,...(sha?{sha}:{}),content:bytes.toString('base64')})});if(!result.ok)fail();
      pendingRead=null;const saved=await read();if(JSON.stringify(saved.state.sessions[key]||null)!==JSON.stringify(state.sessions[key]||null))fail();
      return true;
    });writeTail=work;return work;
  }
  return {kind:'PRIVATE_GITHUB_CAS',async get(key,fingerprint){await writeTail.catch(()=>{});const {state}=await sharedRead(),entry=state.sessions[key];if(state.credentialFingerprint!==fingerprint||!valid(key,entry)||entry.fingerprint!==fingerprint)return null;return {expiresAt:entry.expiresAt,idleExpiresAt:entry.idleExpiresAt};},set:(key,session,fingerprint)=>write(key,{...session,fingerprint}),touch:(key,session,fingerprint)=>write(key,{...session,fingerprint},true),delete:key=>write(key,null)};
}
