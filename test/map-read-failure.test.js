import test from 'node:test';
import assert from 'node:assert/strict';
import {mapReadFailure} from '../src/mapReadFailure.js';
import {addHubReadTiming} from '../src/staffLatency.js';
import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
test('logical source errors are distinct from transport failures',()=>{
 for(const code of ['PERIOD_SOURCE_CHANGED','HISTORY_LOCATOR_CHANGED','PERIOD_HISTORY_INCOMPLETE'])assert.equal(mapReadFailure(new Error('HUB_'+code)).status,409);
 assert.equal(mapReadFailure(new Error('HUB_PERIOD_ROW_INVALID')).status,422);
 assert.equal(mapReadFailure(Object.assign(new Error('SYNTHETIC_BODY'),{name:'AbortError'}),'ROUTE').code,'ROUTE_UPSTREAM_TIMEOUT');
 assert.equal(mapReadFailure(Object.assign(new Error('SYNTHETIC_BODY'),{failureType:'parse'})).code,'SOURCE_INVALID_JSON');
 assert.ok(!JSON.stringify(mapReadFailure(new Error('SYNTHETIC_BODY'))).includes('SYNTHETIC'));
});
test('history timing headers include only whitelisted metadata',()=>{
 const headers={},res={locals:{staffTiming:{}},setHeader:(k,v)=>headers[k]=v};
 addHubReadTiming(res,{responseHeadersMs:20,sourceReadMs:3,phase:'DONE',responseKind:'json',upstreamStatus:200,sentAt:100,hubExecutionStartAt:105,body:'SYNTHETIC',url:'SYNTHETIC'});
 assert.equal(res.locals.staffTiming.sourceRead,3);assert.equal(headers['X-History-Upstream-Status'],'200');assert.ok(!JSON.stringify({headers,res}).includes('SYNTHETIC'));
});
test('period compression preserves every historical record without compressing private endpoints',async()=>{
 const source=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 assert.match(source,/preview\/period", requireView, compression\(\{ threshold: 1024 \}\)/);
 const body={data:[{customerCode:'S1234',history:Array.from({length:2000},(_,i)=>({deliveryDate:'2026-08-01',vehicle:String(i%3),driverKey:'SYNTHETIC',kind:'ASSIGNED'}))}]};
 const app=express();app.get('/period',compression({threshold:1024}),(req,res)=>res.json(body));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/period',{headers:{'accept-encoding':'gzip'}});assert.equal(response.headers.get('content-encoding'),'gzip');assert.deepEqual(await response.json(),body);}finally{await new Promise(resolve=>server.close(resolve));}
});
