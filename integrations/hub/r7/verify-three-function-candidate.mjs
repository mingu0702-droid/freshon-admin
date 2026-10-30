// Offline-only scope guard. It never authenticates, calls Google, or writes a project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {openPrivateSnapshot,sealPrivateSnapshot} from '../../../src/opsmap-abc/privateDetailCache.js';

export const APPROVED_FUNCTIONS=Object.freeze({HubSearch:['hubSearchObjects_'],HubMapAdapter:['hubGetMapMarkerDetail'],HubMapHttpApi:['hubMapHttpHandleCustomerDetail_']});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function exactFunction(source,name){
  const marker='function '+name+'(',start=source.indexOf(marker);
  if(start<0||source.indexOf(marker,start+marker.length)>=0)fail('FUNCTION_MISSING_OR_DUPLICATED');
  const end=source.indexOf('\nfunction ',start+marker.length);
  return source.slice(start,end<0?undefined:end).trimEnd();
}
export function applyApprovedUnifiedDiff(source,patch){
  const sections=patch.replace(/\r\n/g,'\n').split(/(?=^--- )/m).filter(Boolean),result=new Map();
  for(const section of sections){
    const lines=section.split('\n'),name=lines.shift().match(/^--- v64\/([^/]+)\.js$/)?.[1];
    if(!name||!Object.hasOwn(APPROVED_FUNCTIONS,name)||lines.shift()!=='+++ r7-candidate/'+name+'.js'||result.has(name))fail('PATCH_FILE_OUTSIDE_SCOPE');
    const file=source.files.find(file=>file.name===name),original=file.source.split('\n'),output=[];let at=0,index=0;
    while(index<lines.length){
      if(index===lines.length-1&&lines[index]==='')break;
      const hunk=lines[index++].match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);if(!hunk)fail('PATCH_HUNK_INVALID');
      const start=Number(hunk[1])-1;if(start<at)fail('PATCH_HUNK_OVERLAP');output.push(...original.slice(at,start));at=start;
      while(index<lines.length&&!lines[index].startsWith('@@ ')){
        const line=lines[index++];if(index===lines.length&&line==='')break;
        if(line[0]===' '||line[0]==='-'){if(original[at++]!==line.slice(1))fail('PATCH_CONTEXT_MISMATCH');}
        if(line[0]===' '||line[0]==='+')output.push(line.slice(1));
        if(![' ','-','+'].includes(line[0]))fail('PATCH_LINE_INVALID');
      }
    }
    output.push(...original.slice(at));result.set(name,output.join('\n'));
  }
  if(result.size!==3)fail('PATCH_SCOPE_INCOMPLETE');return result;
}
export function candidateRegression(candidate){
  const files=filesByName(candidate),row={customerCode:'S970001',customerName:'SYNTHETIC_ONLY',customerAddress:'가상주소 10',detailAddress:'합성 상세'},results=[];
  function run(name,customer,route,params,verify){
    const calls=[],context=vm.createContext({getCustomers:p=>{calls.push({action:'customers',params:{...p}});return customer;},getDailyRoutes:p=>{calls.push({action:'routes',params:{...p}});return route;}});
    vm.runInContext(files.get('HubMapHttpApi').source,context,{timeout:1000});
    vm.runInContext(exactFunction(files.get('HubSearch').source,'hubSearchObjects_'),context,{timeout:1000});
    vm.runInContext(exactFunction(files.get('HubMapAdapter').source,'hubGetMapMarkerDetail'),context,{timeout:1000});
    let value,error;try{value=context.hubMapHttpHandleCustomerDetail_(params);}catch(e){error=e;}
    if(!verify({value,error,calls}))fail('CANDIDATE_REGRESSION_FAILED');results.push({name,pass:true});
  }
  for(const data of [[row],{items:[row]},{rows:[row]},{headers:Object.keys(row),rows:[Object.values(row)]}])run('current_customer_payload_'+results.length,{ok:true,data},null,{customerCode:row.customerCode},({value,error,calls})=>!error&&value.data.customerAddress===row.customerAddress&&calls.length===1&&calls[0].action==='customers'&&!Object.hasOwn(calls[0].params,'startDate'));
  run('dated_precedence_and_exact_filters',{ok:true,data:[row]},{ok:true,data:[{...row,customerName:'SYNTHETIC_DATED',confirmedVehicle:'101'}]},{customerCode:row.customerCode,date:'2026-10-23'},({value,error,calls})=>!error&&value.data.customerName==='SYNTHETIC_DATED'&&calls.length===2&&calls.every(c=>c.params.startDate==='2026-10-23'&&c.params.endDate==='2026-10-23'));
  for(const [label,customer,code,status] of [['explicit_empty',{ok:true,data:[]},'NOT_FOUND',404],['source_failure',{ok:false,error:'SYNTHETIC_FAILED'},'INTERNAL_ERROR',500],['source_timeout',{ok:false,error:'SYNTHETIC_TIMEOUT'},'TIMEOUT',504],['identity_mismatch',{ok:true,data:[{...row,customerCode:'S970002'}]},'INTERNAL_ERROR',500],['conflict',{ok:true,data:[row,row]},'INTERNAL_ERROR',500],['unknown_contract',{ok:true,data:{unrecognized:[row]}},'INTERNAL_ERROR',500]])run(label,customer,null,{customerCode:row.customerCode},({error})=>error?.safeCode===code&&error.safeHttpStatus===status);
  run('dated_route_failure_stops_without_customer_read',{ok:true,data:[row]},{ok:false,error:'SYNTHETIC_TIMEOUT'},{customerCode:row.customerCode,date:'2026-10-23'},({error,calls})=>error?.safeCode==='TIMEOUT'&&calls.length===1&&calls[0].action==='routes');
  return {scope:'ISOLATED_VM_ACTUAL_V64_CANDIDATE_WITH_SYNTHETIC_RESPONSES_NOT_LIVE_HUB',pass:results.length,fail:0,checks:results};
}
const filesByName=project=>new Map(project.files.map(file=>[file.name,file]));
function namedFunctions(source){return [...source.matchAll(/^function\s+([\w$]+)\s*\(/gm)].map(match=>match[1]);}
function dependencyReport(candidate){
  const definitions=new Map();
  for(const file of candidate.files.filter(file=>file.type==='SERVER_JS'))for(const name of namedFunctions(file.source)){
    const owners=definitions.get(name)||[];owners.push(file.name);definitions.set(name,owners);
  }
  const language=new Set(['if','return','for','while','switch','catch','function','String','Number','Boolean','Object','Array','Date','RegExp','Error','parseInt','parseFloat','isNaN','isFinite','selected']);
  const rows=[];
  for(const [module,names] of Object.entries(APPROVED_FUNCTIONS))for(const name of names){
    const source=exactFunction(filesByName(candidate).get(module).source,name);
    const calls=[...new Set([...source.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map(match=>match[1]))].filter(call=>call!==name&&!language.has(call));
    rows.push({module,function:name,dependencies:calls.map(call=>({name:call,definedIn:definitions.get(call)||[]}))});
  }
  if(rows.some(row=>row.dependencies.some(dependency=>dependency.definedIn.length!==1)))fail('V64_DEPENDENCY_NOT_UNIQUE');
  return rows;
}
export function prepareThreeFunctionCandidate({source,head,manifest,templates}){
  if(source.scriptId!==manifest.sourceProjectId||head.scriptId!==source.scriptId)fail('PROJECT_ID_MISMATCH');
  if(manifest.sourceVersion!==64||source.files.length!==35)fail('V64_BASELINE_REQUIRED');
  const targets=Object.fromEntries((manifest.modules||[]).map(module=>[module.module,module.functions]));
  if(JSON.stringify(targets)!==JSON.stringify(APPROVED_FUNCTIONS))fail('APPROVED_SCOPE_MISMATCH');
  const candidate=JSON.parse(JSON.stringify(source)),original=filesByName(source),current=filesByName(head),patched=filesByName(candidate),changes=[];
  for(const spec of manifest.modules){
    const before=original.get(spec.module),after=patched.get(spec.module),headFile=current.get(spec.module);
    if(!before||before.type!=='SERVER_JS'||!headFile)fail('APPROVED_MODULE_MISSING');
    if(sha(before.source)!==spec.sourceModuleSHA256)fail('V64_MODULE_HASH_MISMATCH');
    const functions=[];
    for(const name of spec.functions){
      const old=exactFunction(before.source,name),replacement=exactFunction(templates[spec.module].replace(/\r\n/g,'\n'),name),headFunction=exactFunction(headFile.source,name);
      if(sha(old)!==spec.sourceFunctionSHA256[name]||sha(replacement)!==spec.candidateFunctionSHA256[name])fail('FUNCTION_HASH_MISMATCH');
      after.source=after.source.replace(old,replacement);
      if(after.source.replace(replacement,'<APPROVED_FUNCTION>')!==before.source.replace(old,'<APPROVED_FUNCTION>'))fail('OUTSIDE_FUNCTION_CHANGE');
      functions.push({name,v64SHA256:sha(old),candidateSHA256:sha(replacement),headSHA256:sha(headFunction),headTargetMatchesV64:headFunction===old});
    }
    if(sha(after.source)!==spec.candidateModuleSHA256)fail('CANDIDATE_MODULE_HASH_MISMATCH');
    changes.push({module:spec.module,sourceSHA256:sha(before.source),candidateSHA256:sha(after.source),functions});
  }
  const wholeDiff=source.files.map(file=>({name:file.name,type:file.type,change:file.source===patched.get(file.name)?.source?'UNCHANGED':'APPROVED_FUNCTION_ONLY',sourceSHA256:sha(file.source),candidateSHA256:sha(patched.get(file.name).source)}));
  if(candidate.files.length!==source.files.length||wholeDiff.filter(row=>row.change!=='UNCHANGED').length!==3)fail('WHOLE_PROJECT_SCOPE_CHANGED');
  const headChanges=[];
  for(const name of new Set([...original.keys(),...current.keys()])){
    const before=original.get(name),now=current.get(name);if(before?.source===now?.source&&before?.type===now?.type)continue;
    const changedFunctions=[];
    if(before?.type==='SERVER_JS'&&now?.type==='SERVER_JS')for(const fn of new Set([...namedFunctions(before.source),...namedFunctions(now.source)])){
      let a=null,b=null;try{a=exactFunction(before.source,fn);}catch{}try{b=exactFunction(now.source,fn);}catch{}
      if(a!==b)changedFunctions.push({name:fn,change:a===null?'ADDED':b===null?'REMOVED':'CHANGED',sourceSHA256:a===null?null:sha(a),headSHA256:b===null?null:sha(b)});
    }
    headChanges.push({name,type:now?.type||before?.type,change:!before?'ADDED':!now?'REMOVED':'CHANGED',sourceSHA256:before?sha(before.source):null,headSHA256:now?sha(now.source):null,changedFunctions});
  }
  let syntaxFiles=0;for(const file of candidate.files.filter(file=>file.type==='SERVER_JS')){new vm.Script(file.source,{filename:file.name+'.gs'});syntaxFiles++;}
  const dependencies=dependencyReport(candidate);
  return {candidate,report:{status:'V64_PLUS_EXACT_APPROVED_THREE_FUNCTIONS_LOCAL_ONLY',sourceProjectId:source.scriptId,sourceVersion:64,sourceFiles:source.files.length,candidateFiles:candidate.files.length,sourceSHA256:sha(JSON.stringify(source)),candidateSHA256:sha(JSON.stringify(candidate)),modifiedModules:changes,wholeProjectDiff:wholeDiff,syntaxFiles,dependencies,manifestUnchanged:original.get('appsscript')?.source===patched.get('appsscript')?.source,headFileCount:head.files.length,headChanges,headPreserved:true,remoteCalls:0,remoteWrites:0,versionsCreated:0,deploymentsUpdated:0,actualInstall:false,r5Installed:false,oauthApprovalRequired:false,deployableWithoutEditorReplacement:false,blocker:'APPS_SCRIPT_VERSION_SNAPSHOTS_ENTIRE_HEAD_WITH_UNAPPROVED_CHANGES',singleRequiredDecision:'Project owner must resolve the existing undeployed HEAD delta and designate an approved deployable HEAD while preserving those changes. Until then keep this exact three-function candidate local; no blanket 109-file deployment, editor overwrite, project substitution, or repeated OAuth request.',officialContracts:['https://developers.google.com/apps-script/api/reference/rest/v1/projects.versions/create','https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent'],headExecutionRisk:'updateContent replaces the whole HEAD used by triggers/editor/development executions; temporarily replacing it with v64 is not an isolated deployment operation.'}};
}

function run(){
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...value]=arg.split('=');return[key,value.join('=')];}));
  for(const name of ['--v64','--head-encrypted','--key-file','--output-encrypted','--report'])if(!args[name])fail('REQUIRED_LOCAL_PATH_MISSING');
  const repo=path.resolve(fileURLToPath(new URL('../../../',import.meta.url))),output=path.resolve(args['--output-encrypted']);
  if(!output.endsWith('.encrypted.json')||output.toLowerCase().startsWith(repo.toLowerCase()+path.sep))fail('PRIVATE_OUTPUT_MUST_STAY_OUTSIDE_REPOSITORY');
  const read=filename=>JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));
  const key=fs.readFileSync(args['--key-file'],'utf8').trim(),source=read(args['--v64']),head=openPrivateSnapshot(read(args['--head-encrypted']),key);
  const dir=path.dirname(fileURLToPath(import.meta.url)),manifest=read(path.join(dir,'INSTALL_MANIFEST.json'));
  const templates=Object.fromEntries(Object.keys(APPROVED_FUNCTIONS).map(module=>[module,fs.readFileSync(path.join(dir,module==='HubSearch'?'HubSearchObjects.compatibility.js':'HubCustomerDetail.compatibility.js'),'utf8')]));
  const {candidate,report}=prepareThreeFunctionCandidate({source,head,manifest,templates});
  const dryApplied=applyApprovedUnifiedDiff(source,fs.readFileSync(path.join(dir,manifest.customerDetailPatch),'utf8'));
  for(const [name,content] of dryApplied)if(content!==filesByName(candidate).get(name).source)fail('APPROVED_DIFF_CANDIDATE_MISMATCH');
  report.approvedDiffSHA256=sha(fs.readFileSync(path.join(dir,manifest.customerDetailPatch)));report.fullDiffMatchesCandidate=true;report.regression=candidateRegression(candidate);
  fs.writeFileSync(output,JSON.stringify(sealPrivateSnapshot(candidate,key)),{flag:'wx',mode:0o600});
  const readback=openPrivateSnapshot(read(output),key);if(sha(JSON.stringify(readback))!==report.candidateSHA256)fail('LOCAL_ENCRYPTED_READBACK_MISMATCH');
  report.encryptedReadbackEqual=true;fs.writeFileSync(args['--report'],JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:report.status,sourceFiles:report.sourceFiles,candidateFiles:report.candidateFiles,changedModules:report.modifiedModules.length,syntaxFiles:report.syntaxFiles,dependenciesUnique:true,encryptedReadbackEqual:true,headPreserved:true,actualInstall:false,remoteCalls:0,remoteWrites:0,blocker:report.blocker}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{run();}catch(error){console.error(JSON.stringify({error:error.code||'OFFLINE_CANDIDATE_GUARD_FAILED',remoteCalls:0,remoteWrites:0}));process.exitCode=1;}
