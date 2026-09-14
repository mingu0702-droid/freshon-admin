import test from 'node:test';
import assert from 'node:assert/strict';
import { callHub } from '../src/hubApiClient.js';
const original=globalThis.fetch;
process.env.HUB_API_URL='https://script.google.com/macros/s/SYNTHETIC/exec';
process.env.HUB_API_SECRET='SYNTHETIC_ONLY_'.repeat(4);
test.after(()=>{globalThis.fetch=original;});
test('history fetch abort covers OUTPUT body, without a background request or retry',async()=>{
 let calls=0,aborted=false;
 globalThis.fetch=async(_url,options)=>{calls++;return{status:200,ok:true,headers:new Headers({'content-type':'application/json'}),text:()=>new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(new Error('TEST'),{name:'AbortError'}));},{once:true});})};};
 const at=Date.now();await assert.rejects(callHub('staffDriverHistory',{}, {useCache:false,privateRead:true,deadline:at+40}),{name:'AbortError'});
 assert.equal(calls,1);assert.equal(aborted,true);assert.ok(Date.now()-at<500);
});
test('OUTPUT HTML 404 is not retried and not confused with JSON not-found',async()=>{
 let calls=0;globalThis.fetch=async()=>++calls===1?new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?synthetic=not-a-token'}}):new Response('<html>not found</html>',{status:404,headers:{'content-type':'text/html'}});
 await assert.rejects(callHub('staffDriverHistory',{}, {useCache:false,privateRead:true}),{message:'HUB_OUTPUT_HTML_404'});assert.equal(calls,2);
 calls=0;globalThis.fetch=async()=>{calls++;return Response.json({ok:false,meta:{httpStatus:404},error:{code:'CUSTOMER_NOT_FOUND'}},{status:200});};
 await assert.rejects(callHub('staffDriverHistory',{}, {useCache:false,privateRead:true}),{message:'HUB_CUSTOMER_NOT_FOUND'});assert.equal(calls,1);
});
