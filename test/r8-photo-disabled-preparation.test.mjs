import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountOpsmapDeliveryPhotoRoutes} from '../src/opsmapDeliveryPhotoRouter.js';

async function check(enabled,{authenticated=true}={}){
 let prepared=0,read=0;
 const app=express();
 mountOpsmapDeliveryPhotoRoutes({app,enabled,prepareSource:async()=>{prepared++;},
  source:{list:async()=>{read++;return [];},openMedia:async()=>{throw Error('UNEXPECTED_MEDIA');}},
  requireStaff:(_q,r,next)=>{if(!authenticated)return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});r.locals.staffSession={key:'SYNTHETIC',expiresAt:Date.now()+60000,idleExpiresAt:Date.now()+60000};return next();},
  isSessionCurrent:()=>authenticated});
 const instance=app.listen(0,'127.0.0.1');await new Promise(resolve=>instance.once('listening',resolve));
 try{const reply=await fetch(`http://127.0.0.1:${instance.address().port}/api/map-phase2b/private/delivery-photos?customerCode=T900001&date=2026-10-23&deliveryId=900001`);return {http:reply.status,body:await reply.json(),prepared,read};}
 finally{await new Promise(resolve=>instance.close(resolve));}
}
test('OFF blocks preparation and source calls for boolean and dynamic feature switches',async()=>{
 for(const enabled of [false,()=>false]){const result=await check(enabled);assert.equal(result.http,503);assert.equal(result.body.error.code,'PHOTO_SOURCE_DISABLED');assert.equal(result.prepared,0);assert.equal(result.read,0);}
});
test('enabled authenticated request retains the existing preparation and source path',async()=>{
 const result=await check(()=>true);assert.equal(result.http,200);assert.equal(result.prepared,1);assert.equal(result.read,1);
});
test('anonymous request cannot prepare a source session even when feature is enabled',async()=>{
 const result=await check(true,{authenticated:false});assert.equal(result.http,401);assert.equal(result.prepared,0);assert.equal(result.read,0);
});
