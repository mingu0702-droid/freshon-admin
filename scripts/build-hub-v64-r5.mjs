// Local-only candidate builder. No OAuth, deployment, project writes, or source IO.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import vm from 'node:vm';
const [input]=process.argv.slice(2);if(!input||!path.isAbsolute(input))throw Error('Usage: node scripts/build-hub-v64-r5.mjs ABS_VERIFIED_V64_CONTENT_JSON');
const bytes=fs.readFileSync(input),digest=b=>crypto.createHash('sha256').update(b).digest('hex'),sourceDigest=b=>digest(Buffer.from(String(b).replaceAll('\r\n','\n'),'utf8'));
if(digest(bytes)!=='eabd5bfa8e65ece7d3f063c3f858afdcf98715d15171186a6b1815ed92620811')throw Error('HUB_V64_SOURCE_PIN');
const project=JSON.parse(bytes);if(project.files?.length!==35)throw Error('HUB_V64_FILE_COUNT');
const source=name=>{const rows=project.files.filter(f=>f.name===name&&f.type==='SERVER_JS');if(rows.length!==1)throw Error('HUB_V64_SOURCE_IDENTITY');return rows[0].source;};
const replace=(s,from,to)=>{if(s.split(from).length!==2)throw Error('HUB_V64_ANCHOR_AMBIGUOUS');return s.replace(from,to);};
let http=source('HubMapHttpApi'),auto=source('HubMapAutomation');
http=replace(http,'      customerDetail: hubMapHttpHandleCustomerDetail_,','      customerDetail: hubMapHttpHandleCustomerDetail_,\n      customerDetailPrepared: function(p){return hubMapCustomerDetailPrepared_(p);},\n      customerDetailsStatus: function(p){hubMapHttpValidateOnlyKeys_(p,[]);return hubCustomerDetailStatus_();},\n      customerDetailsSyncRequest: function(p){return hubMapCustomerDetailsSyncRequest_(p);},\n      mapRoadBudgetStatus: function(p){return hubMapRoadBudgetStatus_(p);},\n      mapRoadBudgetReserve: function(p){return hubMapRoadBudgetReserve_(p);},');
http=replace(http,'function hubMapHttpSafeError_(error) {',`function hubMapHttpSafeError_(error) {
  const preparedCode=String(error&&error.code||error&&error.message||'');
  if(/^(?:CUSTOMER_DETAILS|ROAD_BUDGET)_[A-Z_]+$/.test(preparedCode))return {code:preparedCode,message:'Prepared source is not available for this request.',httpStatus:/EXHAUSTED/.test(preparedCode)?429:/NOT_READY|NOT_APPROVED|REQUIRED|UNOBSERVED/.test(preparedCode)?503:409,retryable:false};`);
auto=replace(auto,"generation:s.generation||null};","generation:s.generation||null,customerDetails:s.customerDetails||null};");
auto=replace(auto,'  const s=hubMapAutomationLoad_();s.lastCheck=new Date().toISOString();',`  const s=hubMapAutomationLoad_();s.lastCheck=new Date().toISOString();
  // Opt-in only; never installs triggers or changes the existing map worker.
  if(PropertiesService.getScriptProperties().getProperty('OPSMAP_CUSTOMER_DETAILS_AUTO_ENABLED')==='1'&&typeof hubMapCustomerDetailsAutoStep_==='function'){
    try{s.customerDetails=hubMapCustomerDetailsAutoStep_();}
    catch(e){s.customerDetails={status:'ERROR',error:'CUSTOMER_DETAILS_AUTO_FAILED'};}
  }`);
const root=path.resolve(import.meta.dirname,'..'),target=path.join(root,'integrations/hub/v64');fs.mkdirSync(target,{recursive:true});
const modified={HubMapHttpApi:http,HubMapAutomation:auto},add=['HubMapPackageStore','HubCustomerDetailContract','HubCustomerDetailStore','HubMapRoadBudget'];
const candidate=project.files.filter(f=>f.type==='SERVER_JS').map(f=>modified[f.name]||f.source);
for(const name of add){if(project.files.some(f=>f.name===name))throw Error('HUB_V64_MODULE_COLLISION');candidate.push(fs.readFileSync(path.join(root,'integrations/hub',name+'.js'),'utf8'));}
new vm.Script(candidate.join('\n;\n'),{filename:'verified-v64-plus-r5.js'});
for(const [name,text]of Object.entries(modified))fs.writeFileSync(path.join(target,name+'.js'),text);
const manifest={schema:1,moduleHashEncoding:'UTF8_LF_NORMALIZED',sourceVersion:64,sourceFileCount:35,sourceContentSha256:digest(bytes),candidateFileCount:39,runtimeSyntax:'PASS',remoteInstall:false,remoteDeploy:false,oauthScopesChanged:false,library42Changed:false,triggersChanged:false,defaultAutoEnabled:false,requiredPrivateProperties:{OPSMAP_CUSTOMER_DETAILS_SCOPE_MODE:'CUSTOMER_MASTER',OPSMAP_CUSTOMER_DETAILS_FOLDER_ID:'Existing operator-approved private Hub output folder; do not use Customer or Archive folders'},requiresPublicMapRoot:false,modules:[...Object.entries(modified).map(([name,text])=>({name,path:'integrations/hub/v64/'+name+'.js',operation:'REPLACE_EXACT_V64_ONLY',baseSha256:sourceDigest(source(name)),sha256:sourceDigest(text)})),...add.map(name=>({name,path:'integrations/hub/'+name+'.js',operation:'ADD_IF_ABSENT',sha256:sourceDigest(fs.readFileSync(path.join(root,'integrations/hub',name+'.js'),'utf8'))}))],untouchedVersion64Modules:project.files.filter(f=>!modified[f.name]).map(f=>({name:f.name,type:f.type,sha256:sourceDigest(f.source||'')}))};
fs.writeFileSync(path.join(target,'MERGE_MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({sourceVersion:64,originalFiles:35,candidateFiles:39,existingFilesModified:2,addedModules:4,syntax:'PASS',deployments:0}));
