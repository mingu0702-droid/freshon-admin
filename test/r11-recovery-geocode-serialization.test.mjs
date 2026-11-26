import test from 'node:test';import assert from 'node:assert/strict';
import {createProductionGeocodeBudgetGithubStore} from '../src/opsmap-abc/manualPinGithubStore.js';
function fixture(){let version=1,state={used:161,days:{'2026-11-03':161}},puts=0,failNext=false;
const response=(value,status=200)=>({ok:status===200,status,json:async()=>value});
const fetchImpl=async(url,options={})=>{await new Promise(resolve=>setTimeout(resolve,2));if(failNext){failNext=false;return response({},403);}if(!url.includes('/contents/'))return response({private:true,permissions:{push:true}});if(options.method==='PUT'){const body=JSON.parse(options.body);if(body.sha!==version.toString(16).padStart(40,'0'))return response({},409);version++;state=JSON.parse(Buffer.from(body.content,'base64').toString());puts++;return response({});}return response({sha:version.toString(16).padStart(40,'0'),encoding:'base64',content:Buffer.from(JSON.stringify(state)).toString('base64')});};
const store=createProductionGeocodeBudgetGithubStore({repo:'mingu0702-droid/freshon-cache',branch:'production/opsmap-manual-pins',token:'synthetic',fetchImpl});return{store,get:()=>({state,puts}),fail:()=>{failNext=true;}};}
test('concurrent address reservations serialize without lost usage or false GitHub CAS conflicts',async()=>{const f=fixture();await Promise.all(Array.from({length:6},()=>f.store.transaction(async(state,commit)=>{state.used++;state.days['2026-11-03']++;await commit(state);})));assert.deepEqual(f.get(),{state:{used:167,days:{'2026-11-03':167}},puts:6});});
test('failed reservation releases the queue without resetting persisted counts',async()=>{const f=fixture();f.fail();await assert.rejects(f.store.transaction(async()=>{}),{code:'MANUAL_PIN_GITHUB_PERMISSION'});await f.store.transaction(async(state,commit)=>{state.used++;await commit(state);});assert.equal(f.get().state.used,162);assert.equal(f.get().state.days['2026-11-03'],161);assert.equal(f.get().puts,1);});

test('production reuses a verified quota write receipt, rejects stale CAS, and rereads after conflict', async()=>{
 const {createHash}=await import('node:crypto');
 const path='opsmap-production/geocode-budget-v1.json';
 const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 let bytes=Buffer.from('{"used":9}'),time=0,requests=[];
 const store=createProductionGeocodeBudgetGithubStore({repo:'mingu0702-droid/freshon-cache',token:'synthetic',
  branch:'production/opsmap-manual-pins',clock:()=>time,fetchImpl:async(url,options)=>{
   if(!url.includes('/contents/')){requests.push('permission');return Response.json({private:true,permissions:{push:true}});}
   if(options.method!=='PUT'){requests.push('read');return Response.json({sha:blob(bytes),content:bytes.toString('base64'),encoding:'base64'});}
   requests.push('write');
   const input=JSON.parse(options.body);
   if(input.sha!==blob(bytes))return Response.json({}, {status:409});
   bytes=Buffer.from(input.content,'base64');
   return Response.json({content:{type:'file',path,sha:blob(bytes)},commit:{sha:'a'.repeat(40)}});
  }});
 const reserve=()=>store.transaction((state,commit)=>commit({used:state.used+1}),{reservation:true});
 await reserve();
 assert.deepEqual(requests,['permission','read','write']);
 requests=[]; await reserve();
 assert.deepEqual(requests,['write']);
 assert.equal(JSON.parse(bytes).used,11);
 bytes=Buffer.from('{"used":14}');
 await assert.rejects(reserve(),{code:'MANUAL_PIN_GITHUB_CONFLICT'});
 assert.equal(JSON.parse(bytes).used,14);
 requests=[]; time+=6000; await reserve();
 assert.deepEqual(requests,['permission','read','write']);
 assert.equal(JSON.parse(bytes).used,15);
});
