import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountMapDataFreshness} from '../src/opsmap-abc/mapDataFreshness.js';
async function request(t,{callHub,modelStatus=()=>({ready:true,generation:7}),details=false}){
 const app=express();mountMapDataFreshness(app,{callHub,modelStatus,requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,env:{OPSMAP_PREPARED_DETAILS_ENABLED:details?'1':'0'},baseStore:null});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/map-phase2b/preview/data-status`);return {status:response.status,body:await response.json()};
}
const privateFailure=()=>Object.assign(Error('PRIVATE_SOURCE_MESSAGE'),{failureType:'PRIVATE_TYPE',upstreamStatus:401,secret:'PRIVATE_SECRET'});
test('Hub model failure preserves prepared detail and local status with safe failure contract',async t=>{
 const result=await request(t,{details:true,callHub:async action=>{if(action==='mapModelStatus')throw privateFailure();return {data:{prepared:true,job:{phase:'DONE',preparedCustomers:9}}};}});
 assert.equal(result.status,200);assert.equal(result.body.data.partial,true);assert.equal(result.body.data.customerDetails.prepared,true);assert.equal(result.body.data.live.generation,7);assert.equal(result.body.data.automatic,'UNKNOWN');assert.equal(result.body.data.continuation,'UNKNOWN');
 const failure=result.body.data.sources.find(s=>s.action==='mapModelStatus');assert.equal(failure.failureType,'unknown');assert.equal(failure.upstreamStatus,401);assert(Number.isSafeInteger(failure.durationMs));assert(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(result.body.data.publicationConnection.sourceBoundCompletionVerified,false);
});
test('prepared detail failure preserves successful model status; timeout uses allowed enum',async t=>{
 const result=await request(t,{details:true,callHub:async action=>{if(action==='customerDetailsStatus')throw Object.assign(Error('PRIVATE'),{name:'AbortError'});return {data:{customer:{freshon:'2026-11-02'},published:{generation:7}}};}});
 assert.equal(result.status,200);assert.equal(result.body.data.customer.freshon,'2026-11-02');assert.equal(result.body.data.customerDetails,null);assert.equal(result.body.data.partial,true);assert.equal(result.body.data.sources.find(s=>s.action==='customerDetailsStatus').failureType,'timeout');assert.equal(result.body.data.sources.find(s=>s.action==='customerDetailsStatus').errorCode,'HUB_TIMEOUT');
});
test('disabled detail is not fabricated success and complete upstream/local failure returns 503',async t=>{
 const calls=[];const result=await request(t,{callHub:async action=>{calls.push(action);throw privateFailure();},modelStatus:()=>{throw Error('PRIVATE_LOCAL');}});
 assert.equal(result.status,503);assert.equal(result.body.ok,false);assert.equal(result.body.data.partial,true);assert.deepEqual(calls,['mapModelStatus']);assert.equal(result.body.data.coverage.proof,'UNKNOWN');assert.equal(result.body.data.publicationConnection.serving.ready,false);assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('local failure preserves good Hub status and malformed model contract is unknown',async t=>{
 const good=await request(t,{callHub:async()=>({data:{customer:{delivery:'2026-11-02'}}}),modelStatus:()=>{throw Error('PRIVATE');}});assert.equal(good.status,200);assert.equal(good.body.data.customer.delivery,'2026-11-02');assert.equal(good.body.data.live,null);assert.equal(good.body.data.partial,true);
 const bad=await request(t,{callHub:async()=>({data:null})});assert.equal(bad.status,200);assert.equal(bad.body.data.sources.find(s=>s.action==='mapModelStatus').failureType,'contract');
});
