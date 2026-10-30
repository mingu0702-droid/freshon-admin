// Allowlisted Hub HEAD update; preserve every unrelated remote source exactly.
const fs=require('node:fs'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const baseline=process.argv.find(v=>v.startsWith('--baseline='))?.split('=')[1];
if(baseline&&!/^[a-f0-9]{7,40}$/.test(baseline))throw Error('INVALID_BASELINE');
const id='1QCfJSuAIHwGcDxlCQhCGART40D2ULlmP2KmD7GuA0c7KIoFFRC9qOBbP';
const names=process.argv.includes('--checkpoint-only')?['HubProductionCheckpoint']:process.argv.includes('--coordinates-only')?['HubProductionCoordinates']:['HubProductionRestoreRecovery','HubProductionCheckpoint','HubStaffDetail','HubMapIncremental','HubMapAutomation','HubProductionCoordinates','HubProductionCoordinateStore','HubMapHttpApi'];
const norm=x=>x.replace(/\r\n/g,'\n'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fingerprint=files=>hash(JSON.stringify(files.map(f=>[f.name,f.type,f.source]).sort((a,b)=>a[0].localeCompare(b[0]))));
(async()=>{
 const a=JSON.parse(fs.readFileSync('C:/Users/SFN/.clasprc.json','utf8')).tokens.default;
 const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:a.client_id,client_secret:a.client_secret,refresh_token:a.refresh_token,grant_type:'refresh_token'})});
 if(!tokenResponse.ok)throw Error('AUTH_HTTP_'+tokenResponse.status);const token=(await tokenResponse.json()).access_token;
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},url='https://script.googleapis.com/v1/projects/'+id+'/content';
 const read=async()=>{const r=await fetch(url,{headers});if(!r.ok)throw Error('READ_HTTP_'+r.status);return(await r.json()).files;};
 const before=await read(),files=before.map(f=>({name:f.name,type:f.type,source:f.source})),changes=[];
 for(const name of names){
  const local=fs.readFileSync('integrations/hub/'+name+'.js','utf8'),remote=files.find(f=>f.name===name);
  if(remote&&norm(remote.source)===norm(local))continue;
  if(remote){const reference='../hub-production-coldstart-20260924/'+name+'.js';const frozen=baseline?norm(remote.source)===norm(execFileSync('git',['show',baseline+':integrations/hub/'+name+'.js'],{encoding:'utf8'})):{HubProductionCheckpoint:'63ef06fe00533c9c0ec2f939c63cd1aa341a4c6013a05bff2cb0e432b979bb43',HubProductionRestoreRecovery:'bbad12cbb0cafa59605b452091201a1c683aa4a5eb0b4ee18089859506e90286',HubProductionCoordinates:'471fdc4939080ad83c9093ff7620128595cb74157b28e1585d083f7753b0d827'}[name]===hash(remote.source);if(!frozen&&(!fs.existsSync(reference)||norm(remote.source)!==norm(fs.readFileSync(reference,'utf8'))))throw Error('REMOTE_SOURCE_CONFLICT');remote.source=local;}
  else {if(!['HubProductionCheckpoint','HubMapAutomation','HubProductionCoordinates','HubProductionCoordinateStore'].includes(name))throw Error('REMOTE_SOURCE_MISSING');files.push({name,type:'SERVER_JS',source:local});}
  changes.push(name);
 }
 console.log(JSON.stringify({mode:process.argv.includes('--apply')?'APPLY':'CHECK',changes,unrelatedPreserved:true}));
 if(!process.argv.includes('--apply')||!changes.length)return;
 if(fingerprint(await read())!==fingerprint(before))throw Error('REMOTE_CHANGED');
 const r=await fetch(url,{method:'PUT',headers,body:JSON.stringify({files})});if(!r.ok)throw Error('UPDATE_HTTP_'+r.status);
 if(fingerprint(await read())!==fingerprint(files))throw Error('VERIFY_FAILED');
 console.log(JSON.stringify({http:r.status,remoteVerified:true,unrelatedChanged:0,deployment:0,execution:0}));
})().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'SAFE_UPDATE_FAILED');process.exitCode=1;});
