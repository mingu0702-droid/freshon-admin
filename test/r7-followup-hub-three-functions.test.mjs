import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {APPROVED_FUNCTIONS,prepareThreeFunctionCandidate,applyApprovedUnifiedDiff} from '../integrations/hub/r7/verify-three-function-candidate.mjs';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(){
  const modules=[],templates={},files=[];
  for(const [module,[fn]] of Object.entries(APPROVED_FUNCTIONS)){
    const original='function '+fn+'(value){return value;}';const replacement='function '+fn+'(value){return value || null;}';
    files.push({name:module,type:'SERVER_JS',source:original+'\n'});templates[module]=replacement+'\n';
    modules.push({module,functions:[fn],sourceModuleSHA256:hash(original+'\n'),candidateModuleSHA256:hash(replacement+'\n'),sourceFunctionSHA256:{[fn]:hash(original)},candidateFunctionSHA256:{[fn]:hash(replacement)}});
  }
  files.push({name:'appsscript',type:'JSON',source:'{"timeZone":"Asia/Seoul"}'});
  for(let i=files.length;i<35;i++)files.push({name:'SYNTHETIC_'+i,type:'SERVER_JS',source:'function synthetic'+i+'(){return null;}'});
  const source={scriptId:'SYNTHETIC_PROJECT_ONLY',files},head=structuredClone(source);
  head.files.push({name:'SYNTHETIC_UNDEPLOYED',type:'SERVER_JS',source:'function syntheticUndeployed(){return null;}'});
  return{source,head,manifest:{sourceProjectId:source.scriptId,sourceVersion:64,modules},templates};
}
test('offline candidate preserves every non-target file and blocks unrelated HEAD publication',()=>{
  const f=fixture(),before=JSON.stringify(f.head),{candidate,report}=prepareThreeFunctionCandidate(f);
  assert.equal(candidate.files.length,35);assert.equal(report.wholeProjectDiff.filter(x=>x.change!=='UNCHANGED').length,3);
  assert.equal(report.manifestUnchanged,true);assert.equal(JSON.stringify(f.head),before);
  assert.equal(report.headChanges.length,1);assert.equal(report.deployableWithoutEditorReplacement,false);assert.equal(report.actualInstall,false);
  assert.equal(report.remoteCalls+report.remoteWrites+report.versionsCreated+report.deploymentsUpdated,0);
});
test('scope guard refuses project substitution, v64 drift, fourth function, and unapproved helper dependency',()=>{
  for(const [change,code]of [
    [f=>f.head.scriptId='OTHER_PROJECT','PROJECT_ID_MISMATCH'],
    [f=>f.source.files[0].source+='// unreviewed','V64_MODULE_HASH_MISMATCH'],
    [f=>f.manifest.modules[0].functions.push('extraHelper'),'APPROVED_SCOPE_MISMATCH'],
    [f=>{const spec=f.manifest.modules[0],fn=spec.functions[0],replacement='function '+fn+'(value){return extraHelper(value);}';f.templates[spec.module]=replacement;spec.candidateFunctionSHA256[fn]=hash(replacement);spec.candidateModuleSHA256=hash(replacement+'\n');},'V64_DEPENDENCY_NOT_UNIQUE']
  ]){const f=fixture();change(f);assert.throws(()=>prepareThreeFunctionCandidate(f),e=>e.code===code);}
});
test('approved unified patch applies in memory only and refuses wrong context or missing target',()=>{
  const f=fixture();const patch=f.manifest.modules.map(spec=>{const file=f.source.files.find(file=>file.name===spec.module);return'--- v64/'+spec.module+'.js\n+++ r7-candidate/'+spec.module+'.js\n@@ -1 +1 @@\n-'+file.source.trimEnd()+'\n+'+f.templates[spec.module].trimEnd()+'\n';}).join('');
  const applied=applyApprovedUnifiedDiff(f.source,patch);assert.equal(applied.size,3);
  for(const [name,source]of applied)assert.equal(hash(source),f.manifest.modules.find(module=>module.module===name).candidateModuleSHA256);
  assert.throws(()=>applyApprovedUnifiedDiff(f.source,patch.replace('return value;}','return changed;}')),e=>e.code==='PATCH_CONTEXT_MISMATCH');
  assert.throws(()=>applyApprovedUnifiedDiff(f.source,patch.slice(0,patch.indexOf('--- v64/HubMapHttpApi'))),e=>e.code==='PATCH_SCOPE_INCOMPLETE');
});
test('checked-in metadata pins the actual v64 candidate, exact function hashes, and unapplied status',()=>{
  const dir=new URL('../integrations/hub/r7/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('INSTALL_MANIFEST.json',dir),'utf8'));
  const result=JSON.parse(fs.readFileSync(new URL('FOLLOWUP_DEPLOYMENT_GUARD_FINAL.json',dir),'utf8'));
  assert.equal(result.sourceFiles,35);assert.equal(result.candidateFiles,35);assert.equal(result.syntaxFiles,33);
  assert.equal(result.wholeProjectDiff.filter(file=>file.change==='UNCHANGED').length,32);assert.equal(result.manifestUnchanged,true);
  for(const module of result.modifiedModules)for(const fn of module.functions){const spec=manifest.modules.find(spec=>spec.module===module.module);assert.equal(fn.v64SHA256,spec.sourceFunctionSHA256[fn.name]);assert.equal(fn.candidateSHA256,spec.candidateFunctionSHA256[fn.name]);assert.equal(fn.headTargetMatchesV64,true);}
  assert.equal(result.approvedDiffSHA256,hash(fs.readFileSync(new URL(manifest.customerDetailPatch,dir))));assert.equal(result.fullDiffMatchesCandidate,true);
  assert.equal(result.regression.pass,12);assert.equal(result.regression.fail,0);assert.equal(result.encryptedReadbackEqual,true);
  assert.equal(result.actualInstall,false);assert.equal(result.r5Installed,false);assert.equal(result.remoteCalls+result.remoteWrites,0);
});
