import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountMapDataFreshness} from '../src/opsmap-abc/mapDataFreshness.js';
test('status source errorCode accepts only bounded Hub codes and keeps failureType/HTTP independent',async()=>{
 for(const [message,expected] of [['HUB_INTERNAL_ERROR','HUB_INTERNAL_ERROR'],['HUB_AUTH_FAILED','HUB_AUTH_FAILED'],['PRIVATE phone 010-0000-0000','UNKNOWN'],['HUB_ERROR\nPRIVATE','UNKNOWN'],['HUB_error','UNKNOWN'],['HUB_'+ 'A'.repeat(81),'UNKNOWN']]){
  const api=mountMapDataFreshness(express(),{callHub:async()=>{throw Object.assign(Error(message),{failureType:'upstream',upstreamStatus:503});},requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,modelStatus:()=>({}),env:{},baseStore:null});
  const result=await api.readStatus(),failure=result.sources[0];
  assert.equal(failure.errorCode,expected);assert.equal(failure.failureType,'upstream');assert.equal(failure.upstreamStatus,503);
  if(expected==='UNKNOWN')assert(!JSON.stringify(result).includes(message));
 }
});
