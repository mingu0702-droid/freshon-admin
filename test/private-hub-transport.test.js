import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPrivateHub,privateResponseKind,privateOutputDeadline} from '../src/privateHubTransport.js';
const original=global.fetch;
test.afterEach(()=>{global.fetch=original;});
test('exec redirect preserves POST; output redirect drops body; metadata has no URL/body',async()=>{
 const calls=[],profile={};
 global.fetch=async(url,options)=>{calls.push({url,...options});if(calls.length===1)return new Response(null,{status:302,headers:{location:'https://script.google.com/macros/s/STAGE/exec?region=1'}});if(calls.length===2)return new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?user_content_key=SYNTHETIC'}});return new Response('{}');};
 await fetchPrivateHub('https://script.google.com/macros/s/STAGE/exec',{body:'SYNTHETIC_SIGNED',headers:{'content-type':'application/json'}},profile);
 assert.deepEqual(calls.map(x=>x.method),['POST','POST','GET']);
 assert.equal(calls[2].body,undefined);assert.deepEqual(calls[2].headers,{});
 assert.ok(!JSON.stringify(profile).includes('SYNTHETIC'));
});
test('untrusted redirects never receive a signed body',async()=>{
 let calls=0;global.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://attacker.invalid/exec'}});};
 await assert.rejects(fetchPrivateHub('https://script.google.com/macros/s/STAGE/exec',{body:'SYNTHETIC'},{}),/DETAIL_REDIRECT_REJECTED/);assert.equal(calls,1);
});
test('response classification contains only enums, not response data',()=>{
 assert.equal(privateResponseKind('',''), 'invalid-json');
 assert.equal(privateResponseKind('<html>'), 'html');
 assert.equal(privateResponseKind('',{data:{service:'hub-map-api',status:'UP'}}),'health-json');
 assert.equal(privateResponseKind('',{data:{accessMemo:'SYNTHETIC'}}),'json');
});
test('output allowance is bounded, respects caller deadline, never grants another execution budget',()=>{
 assert.equal(privateOutputDeadline(0,4800,4600),6100);
 assert.equal(privateOutputDeadline(0,4800,4799),6299);
 assert.equal(privateOutputDeadline(0,4800,4800,5000),5000);
 assert.equal(privateOutputDeadline(0,4800,1000),4800);
});
test('only trusted output redirect receives allowance, never authentication or execution redirects',async()=>{
 let calls=0,grants=0;const profile={};global.fetch=async()=>{calls++;return calls===1?new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?user_content_key=SYNTHETIC'}}):new Response('{}');};
 await fetchPrivateHub('https://script.google.com/macros/s/STAGE/exec',{body:'SYNTHETIC'},profile,()=>grants++);assert.equal(grants,1);assert.equal(profile.requestStage,'OUTPUT');
 global.fetch=async()=>new Response(null,{status:302,headers:{location:'https://accounts.google.com/login'}});
 await assert.rejects(fetchPrivateHub('https://script.google.com/macros/s/STAGE/exec',{}, {},()=>grants++),/REDIRECT_REJECTED/);assert.equal(grants,1);
});
