import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../integrations/hub/HubMapAutomation.js',import.meta.url),'utf8');
function fixture({stale=false,mismatch=false}={}){
 const props={own:'c',published:'old',stage:'s',prod:'r'},state={stateId:'c',baseStateId:'old',operation:'MAP_INCREMENTAL',publishTarget:'production',phase:'BUILD',generation:10,shards:{'period:2026-09-19':{id:'shard'}}};let saved='',writes=0;
 const ctx=vm.createContext({Date,JSON,HUB_MAP_INCREMENTAL:{property:'own'},HUB_STAGE_MODEL:{property:'published'},HUB_MODEL_TARGETS:{stage:{property:'stage'},production:{property:'prod'}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]})},DriveApp:{getFileById:id=>{assert.equal(id,'c');return{setContent:s=>{saved=s;writes++;},getBlob:()=>({getDataAsString:()=>stale?'old':saved})};}},ScriptApp:{getOAuthToken:()=> 'SYNTHETIC'},UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>mismatch?'wrong':saved})}});vm.runInContext(source,ctx);
 return{state,props,save:()=>ctx.hubMapCandidateCheckpointSave_(state),get writes(){return writes;},get saved(){return saved;}};
}
test('candidate checkpoint uses frozen exact bytes with independent readback',()=>{const f=fixture({stale:true});f.save();assert.equal(f.writes,1);assert.equal(f.saved,JSON.stringify(f.state));});
test('candidate mismatch cannot be accepted or rewritten',()=>{const f=fixture({stale:true,mismatch:true});assert.throws(f.save,/CHECKPOINT_MISMATCH/);assert.equal(f.writes,1);});
test('candidate cannot overwrite source generation, peer restore or immutable shard',()=>{for(const id of ['old','s','r','shard']){const f=fixture();f.state.stateId=id;assert.throws(f.save,/CHECKPOINT_CONFLICT/);assert.equal(f.writes,0);}});
test('already published candidate cannot rewind to BUILD',()=>{const f=fixture();f.props.published='c';assert.throws(f.save,/CHECKPOINT_CONFLICT/);assert.equal(f.writes,0);});
