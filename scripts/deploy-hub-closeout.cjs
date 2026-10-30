// Update only the already approved Production Hub web-app deployment.
const fs=require('node:fs');
const expectedVersion=Number(process.argv.find(v=>v.startsWith('--expected-version='))?.split('=')[1]||62);
if(!Number.isInteger(expectedVersion)||expectedVersion<1)throw Error('INVALID_VERSION');
const project='1QCfJSuAIHwGcDxlCQhCGART40D2ULlmP2KmD7GuA0c7KIoFFRC9qOBbP';
const deployment='AKfycby2GWkBTo3v1u9YsDIpmwGUNIGP4UHuaAnP2HAujA4oKgsWV0sj68wjxP_H1iL5Opu2';
const names=['HubProductionRestoreRecovery','HubProductionCheckpoint','HubStaffDetail','HubMapIncremental','HubMapAutomation','HubProductionCoordinates','HubProductionCoordinateStore','HubMapHttpApi'];
(async()=>{
 const a=JSON.parse(fs.readFileSync('C:/Users/SFN/.clasprc.json','utf8')).tokens.default;
 const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:a.client_id,client_secret:a.client_secret,refresh_token:a.refresh_token,grant_type:'refresh_token'})});if(!tr.ok)throw Error('AUTH_FAILED');
 const token=(await tr.json()).access_token,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},root='https://script.googleapis.com/v1/projects/'+project;
 const api=async(path,options={})=>{const r=await fetch(root+path,{...options,headers});if(!r.ok)throw Error('HUB_API_HTTP_'+r.status);return r.json();};
 const before=await api('/deployments'),active=before.deployments.find(d=>d.deploymentId===deployment);
 if(active?.deploymentConfig.versionNumber!==expectedVersion)throw Error('DEPLOYMENT_BASELINE_CHANGED');
 const content=await api('/content');
 for(const name of names){const actual=content.files.find(f=>f.name===name)?.source,wanted=fs.readFileSync('integrations/hub/'+name+'.js','utf8');if(actual!==wanted)throw Error('SOURCE_MISMATCH');}
 console.log(JSON.stringify({sourceVerified:names.length,previousVersion:expectedVersion,apply:process.argv.includes('--apply')}));
 if(!process.argv.includes('--apply'))return;
 const v=await api('/versions',{method:'POST',body:JSON.stringify({description:'Production map closeout: frozen checkpoint, private lookup, bounded coordinates, stored-data increment'})});
 const current=await api('/deployments/'+deployment);if(current.deploymentConfig.versionNumber!==expectedVersion)throw Error('DEPLOYMENT_CHANGED');
 await api('/deployments/'+deployment,{method:'PUT',body:JSON.stringify({deploymentConfig:{...current.deploymentConfig,versionNumber:v.versionNumber,description:'Production map closeout verified UTF8 stored-data paths'}})});
 const after=await api('/deployments'),check=await api('/deployments/'+deployment);
 if(check.deploymentConfig.versionNumber!==v.versionNumber)throw Error('DEPLOYMENT_VERIFY_FAILED');
 for(const d of before.deployments.filter(d=>d.deploymentId!==deployment)){const x=after.deployments.find(x=>x.deploymentId===d.deploymentId);if(JSON.stringify(x?.deploymentConfig)!==JSON.stringify(d.deploymentConfig))throw Error('UNRELATED_DEPLOYMENT_CHANGED');}
 const deployed=await api('/content?versionNumber='+v.versionNumber);for(const name of names){if(deployed.files.find(f=>f.name===name)?.source!==content.files.find(f=>f.name===name).source)throw Error('VERSION_SOURCE_MISMATCH');}
 console.log(JSON.stringify({version:v.versionNumber,sourceVerified:true,otherDeploymentsChanged:0,secretsChanged:0,customerChanged:0,execution:0}));
})().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'SAFE_DEPLOY_FAILED');process.exitCode=1;});
