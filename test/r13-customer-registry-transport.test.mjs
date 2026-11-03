import test from 'node:test';import assert from 'node:assert/strict';
import {privateReaderEndpoint} from '../src/opsmap-abc/privateReaderEndpoint.js';
import {registryFixture} from './customer-registry-fixture.mjs';
const original={...process.env},originalFetch=global.fetch;let instance=0;
test.afterEach(()=>{process.env={...original};global.fetch=originalFetch;});
async function client(){Object.assign(process.env,{HUB_API_URL:'https://synthetic.example/legacy',HUB_API_SECRET:'x'.repeat(32),OPSMAP_PRIVATE_READER_ENABLED:'true',OPSMAP_PRIVATE_READER_URL:'https://script.google.com/macros/s/SYNTHETIC_CUSTOMER_READER_DEPLOYMENT_123/exec',OPSMAP_PRIVATE_READER_SECRET:'y'.repeat(32)});return import('../src/opsmap-abc/phase2bHubReadClient.js?r13='+instance++);}
test('registry refuses legacy Hub fallback and uses the isolated authenticated no-cache transport',async()=>{
 assert.throws(()=>privateReaderEndpoint('customerRegistry',{}),/PRIVATE_READER_CONFIGURATION_REQUIRED/);const api=await client(),f=registryFixture();let calls=0;
 global.fetch=async(url,options)=>{calls++;assert.equal(url,process.env.OPSMAP_PRIVATE_READER_URL);const request=JSON.parse(options.body);assert.equal(request.action,'customerRegistry');assert(request.auth.signature);return new Response(JSON.stringify({ok:true,data:f.feed(request.params),meta:{requestId:request.requestId,detailDate:null}}),{status:200,headers:{'content-type':'application/json'}});};
 const first=await api.callHub('customerRegistry',{}),next=await api.callHub('customerRegistry',{afterVersion:first.data.version});assert.equal(next.data.mode,'NOOP');assert.equal(calls,2);
});
test('mismatched source identity and nonminimal registry responses are rejected',async()=>{
 const api=await client(),f=registryFixture();global.fetch=async()=>new Response(JSON.stringify({ok:true,data:f.feed(),meta:{requestId:'WRONG_REQUEST_ID',detailDate:null}}),{headers:{'content-type':'application/json'}});await assert.rejects(api.callHub('customerRegistry',{}),/HUB_INVALID_REGISTRY_CONTRACT/);
 global.fetch=async(_url,options)=>{const r=JSON.parse(options.body),data=f.feed();data.rows[0].phone='DO_NOT_RETURN';return new Response(JSON.stringify({ok:true,data,meta:{requestId:r.requestId,detailDate:null}}),{headers:{'content-type':'application/json'}});};await assert.rejects(api.callHub('customerRegistry',{}),/HUB_INVALID_REGISTRY_CONTRACT/);
});
test('matching safe registry cursor errors retain the restart code and are never retried blindly',async()=>{
 const api=await client();let calls=0;global.fetch=async(_url,options)=>{calls++;const r=JSON.parse(options.body);return new Response(JSON.stringify({ok:false,error:{code:'INTERNAL_ERROR'},meta:{requestId:r.requestId,httpStatus:500,sourceErrorCode:'REGISTRY_CURSOR_EXPIRED'}}),{headers:{'content-type':'application/json'}});};
 await assert.rejects(api.callHub('customerRegistry',{cursor:'synthetic'}),{code:'REGISTRY_CURSOR_EXPIRED'});assert.equal(calls,1);
});
