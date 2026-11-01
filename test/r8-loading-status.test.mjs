import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountMapDataFreshness} from '../src/mapDataFreshness.js';

function fixture(callHub,env={}){
 let clock=100000;
 const app=express(),api=mountMapDataFreshness(app,{callHub,requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,modelStatus:()=>({generation:7}),env,now:()=>clock,baseStore:null});
 return {app,api,advance:ms=>{clock+=ms;}};
}
test('concurrent model status is single-flight and one failure backs off without returning old freshness',async()=>{
 let calls=0,resolve,fail=false;
 const f=fixture(async()=>{calls++;if(fail)throw Error('SYNTHETIC_UPSTREAM_ONLY');return new Promise(r=>{resolve=r;});});
 const a=f.api.readStatus(),b=f.api.readStatus();assert.equal(calls,1);
 resolve({data:{customer:{freshon:'2026-10-31'},published:{generation:7}}});
 const first=await a;assert.equal(await b,first);assert.equal(first.checkedAt,new Date(100000).toISOString());
 assert.equal(await f.api.readStatus(),first);assert.equal(calls,1);
 f.advance(20001);fail=true;
 await assert.rejects(f.api.readStatus(),/^Error: MAP_DATA_STATUS_UNAVAILABLE$/);assert.equal(calls,2);
 for(let i=0;i<5;i++)await assert.rejects(f.api.readStatus(),/^Error: MAP_DATA_STATUS_UNAVAILABLE$/);
 assert.equal(calls,2);f.advance(10001);fail=false;
 const recovered=f.api.readStatus();assert.equal(calls,3);resolve({data:{published:{generation:8}}});
 assert.equal((await recovered).published.generation,8);
});
test('optional prepared-detail status failure does not hide valid map metadata or pretend detail readiness',async()=>{
 const calls=[];const f=fixture(async action=>{calls.push(action);if(action==='customerDetailsStatus')throw Error('SYNTHETIC_PRIVATE_VALUE');return {data:{published:{generation:9},coverage:{generation:9,proof:'GENERATION_SHARD_HASH_AND_COLLECTION_LOG_MATCH'}}};},{OPSMAP_PREPARED_DETAILS_ENABLED:'1'});
 const result=await f.api.readStatus();assert.equal(result.published.generation,9);assert.equal(result.customerDetails,null);assert.equal(result.customerDetailsState,'UNAVAILABLE');assert(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_VALUE'));assert.equal(calls.length,2);
});
test('failure response is 503 with retry-after and remains behind the existing read guard',async()=>{
 let reads=0,allowed=false;
 const app=express();mountMapDataFreshness(app,{callHub:async()=>{reads++;throw Error('SYNTHETIC_PRIVATE_VALUE');},requireView:(_q,r,n)=>allowed?n():r.status(401).json({error:'UNAUTHORIZED'}),previewEnabled:()=>true,modelStatus:()=>({}),env:{},baseStore:null});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/preview/data-status';
 try{assert.equal((await fetch(url)).status,401);assert.equal(reads,0);allowed=true;for(let i=0;i<3;i++){const response=await fetch(url);assert.equal(response.status,503);assert(Number(response.headers.get('retry-after'))>=1);assert.deepEqual(await response.json(),{error:'MAP_DATA_STATUS_UNAVAILABLE'});}assert.equal(reads,1);}finally{await new Promise(r=>server.close(r));}
});
