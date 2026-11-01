import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {mountCurrentCustomerDetailRoute} from '../src/currentCustomerDetailRoute.js';
test('current protected lookup authenticates before source access, uses no snapshot date and never serves stale values',async()=>{
 const app=express();let authorized=true,reads=0,fail=false,revoke=false;
 const guard=(req,res,next)=>{if(!authorized||req.get('x-synthetic-auth')!=='yes')return res.status(401).json({ok:false});res.locals.sensitiveAuthenticated=true;return next();};
 app.use('/api/map-phase2b/private',guard);
 mountCurrentCustomerDetailRoute(app,{requireStaff:guard,previewEnabled:()=>true,env:{OPSMAP_PRIVATE_READER_ENABLED:'true'},callHub:async(action,params,options)=>{reads++;assert.equal(action,'customerDetail');assert.deepEqual(params,{customerCode:'S970001'});assert.equal(options.privateRead,true);if(fail)throw Error('SYNTHETIC_UNAVAILABLE');if(revoke)authorized=false;return {ok:true,data:{customerCode:'S970001',accessMemo:'비밀번호: SYNTHETIC_ONLY'},meta:{sourceBasis:'CURRENT_CUSTOMER_LOOKUP'}};}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/customer-current-detail?customerCode=S970001';
 try{
  let response=await fetch(url);assert.equal(response.status,401);assert.equal(reads,0);
  response=await fetch(url,{headers:{'x-synthetic-auth':'yes'}});let value=await response.json();assert.equal(response.status,200);assert.equal(value.data.memoDate,null);assert.equal(value.data.password,'SYNTHETIC_ONLY');assert.equal(value.data.sourceBasis,'CURRENT_CUSTOMER_LOOKUP');assert.match(response.headers.get('cache-control'),/no-store/);
  fail=true;response=await fetch(url,{headers:{'x-synthetic-auth':'yes'}});value=await response.json();assert.equal(response.status,502);assert.equal(value.data,null);assert(!JSON.stringify(value).includes('SYNTHETIC_ONLY'));
  fail=false;revoke=true;response=await fetch(url,{headers:{'x-synthetic-auth':'yes'}});assert.equal(response.status,401);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
