import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import express from 'express';
import {STAGE_ORIGIN,STAGE_SERVICE,PRIMARY_ORIGIN} from '../src/stageScope.js';
import {decodeWmsOfficialRound,encodeWmsOfficialRound} from '../src/stageWmsOfficialRound.js';
import {deriveOpsmapWmsHandoffKey,mountOpsmapWmsOfficialRoundHandoff,OPSMAP_WMS_HANDOFF_ROUTE} from '../src/opsmapWmsOfficialRoundHandoff.js';

const secret='test-clock-secret-only-example-32-plus';
const now=Date.parse('2026-11-26T12:01:00.000Z'), date='2026-11-27', observedAt=now-60_000;
const runId='00000000-0000-0000-0000-000000000001';
const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
  OPSMAP_STAGE_WMS_DISPATCH_EXPORT_APPROVED:'1',OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF:'a'.repeat(40),
  OPSMAP_STAGE_WMS_DISPATCH_EXPORT_PUBLISH_APPROVED:'1',OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_KEY_B64:Buffer.alloc(32,13).toString('base64'),
  OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_WRITE_TOKEN:'isolated-test-archive-write',
  OPSMAP_STAGE_WMS_OFFICIAL_ROUND_PUBLISH_APPROVED:'1',OPSMAP_STAGE_WMS_OFFICIAL_ROUND_HANDOFF_APPROVED:'1'};
const gasSource=await readFile(new URL('../integrations/wms-official-round/OfficialWmsRoundHandoff.gs',import.meta.url),'utf8');
const hexDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixedDate=class extends Date{static now(){return now;}};
const scope={date,warehouse:'011',observedAt:new Date(observedAt).toISOString(),roundId:runId};
const unassigned={WH_CD:'011',DLVRY_DATE:date,DISPATCH_YN:'N',DLVRY_NO:'U1',CUST_CD:'S50001',SELL_AMT:25};

function batch(assigned=2,groups=1){
  const plans=[],rows=[];
  for(let group=0;group<groups;group++){
    const DISPATCH_NO='DSP-'+String(group).padStart(18,'0'), ROUTE_NM=String(group+100), ROUTE_CD='ALIAS-'+group;
    const remainder=group<assigned%groups?1:0;
    const count=Math.floor(assigned/groups)+remainder;
    plans.push({DISPATCH_NO,ROUTE_NM,ROUTE_CD,SELL_AMT:count*1000,STOP_LOC_CNT:count,
      WH_CD:'011',DLVRY_DATE:date,superfluous:'PRIVATE PLAN FIELD'});
    for(let stop=0;stop<count;stop++){
      rows.push({WH_CD:'011',DLVRY_DATE:date,DISPATCH_NO,ROUTE_NM,ROUTE_CD_ORG:ROUTE_CD,DISPATCH_YN:'Y',
        DLVRY_NO:'DLV-'+String(rows.length+1).padStart(15,'0'),CUST_CD:'S'+String(rows.length+10000),SELL_AMT:1000,
        CUST_NM:'PRIVATE CUSTOMER NAME',PHONE:'PRIVATE PHONE',ADDR:'PRIVATE ADDRESS'});
    }
  }
  return {plans,details:[...rows,unassigned]};
}

function gas({allowed=true,audience=STAGE_ORIGIN,acknowledgement=JSON.stringify({state:'PUBLISHED',date})}={}){
  const requests=[],messages=[];
  const props={OPSMAP_WMS_OFFICIAL_HANDOFF_V1:JSON.stringify({enabled:true,audience}),
    OPSMAP_WMS_OFFICIAL_CAPABILITY_B64:deriveOpsmapWmsHandoffKey(secret,STAGE_ORIGIN).toString('base64')};
  const byteArray=buffer=>Array.from(buffer,byte=>byte>127?byte-256:byte);
  const context={
    Date:fixedDate,
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>props[key]})},
    Utilities:{base64Decode:value=>byteArray(Buffer.from(value,'base64')),base64Encode:bytes=>Buffer.from(bytes).toString('base64'),
      newBlob:value=>({getBytes:()=>byteArray(Buffer.from(value,'utf8'))}),
      DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(algorithm,bytes)=>byteArray(createHash(algorithm).update(Buffer.from(bytes)).digest()),
      computeHmacSha256Signature:(bytes,key)=>byteArray(createHmac('sha256',Buffer.from(key)).update(Buffer.from(bytes)).digest())},
    UrlFetchApp:{fetch:(url,opts)=>{
      requests.push({url,...opts});
      return {getResponseCode:()=>200,getContentText:()=>acknowledgement};
    }},
    soOwner_:()=>{if(!allowed)throw Error('DENIED');},
    console:{log:x=>messages.push(x),warn:x=>messages.push(x)}
  };
  const api=runInNewContext(gasSource+'\n({capture:opsmapCaptureWmsOfficialRound_,queue:opsmapQueueWmsOfficialRound_,send:opsmapSendWmsOfficialRound_})',context);
  return {api,requests,messages};
}

function makeSignedHeaders(payload,{audience=STAGE_ORIGIN,issuedAt=new Date(now).toISOString(),shipDate=date,key=deriveOpsmapWmsHandoffKey(secret,audience)}={}){
  const digest=hexDigest(payload);
  return {'Content-Type':'application/json','X-Opsmap-Wms-Date':shipDate,'X-Opsmap-Wms-Issued-At':issuedAt,
    'X-Opsmap-Wms-Body-Sha256':digest,'X-Opsmap-Wms-Signature':createHmac('sha256',key)
      .update(JSON.stringify(['opsmap-wms-owner-handoff-v1',audience,OPSMAP_WMS_HANDOFF_ROUTE,'011',shipDate,issuedAt,digest])).digest('hex')};
}

async function start(t,{settings=env,publish}={}){
  const app=express();
  const registered=mountOpsmapWmsOfficialRoundHandoff(app,{env:settings,clock:{secret},now:()=>now,publish});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port+OPSMAP_WMS_HANDOFF_ROUTE;
  return {registered,post:(body,headers)=>fetch(url,{method:'POST',body,headers})};
}

test('owner GAS sends one minimized already-reconciled Osan round and Node verifies the same wire receipt',async t=>{
  const {api,requests,messages}=gas();
  const {plans,details}=batch(1937,113);
  const report={code:'011',fullyReconciled:true};
  const lease={id:runId},job={id:runId,day:date};
  api.capture(report,date,observedAt,plans,details);
  api.queue([report],job,{ok:true,published:true},lease);
  assert.equal(requests.length,0);
  api.send(lease);
  api.send(lease);
  assert.equal(requests.length,1);
  const request=requests[0];
  assert.equal(request.url,STAGE_ORIGIN+OPSMAP_WMS_HANDOFF_ROUTE);
  assert.equal(request.followRedirects,false);
  assert.ok(Buffer.byteLength(request.payload)>250_000&&Buffer.byteLength(request.payload)<512*1024);
  assert.doesNotMatch(request.payload,/PRIVATE/);
  assert.doesNotMatch(messages.join('\n'),/DLV|DSP|SELL_AMT|PRIVATE/);
  assert.equal(JSON.parse(messages[0]).state,'ACKNOWLEDGED');
  let accepted;
  const {registered,post}=await start(t,{publish:async value=>{
    assert.equal(value.reconcileExisting,true);
    const bytes=encodeWmsOfficialRound(value.round,value.date);
    accepted=decodeWmsOfficialRound(bytes,{date,observedAt:scope.observedAt}).data;
    return {state:'PUBLISHED',sha256:'b'.repeat(64)};
  }});
  assert.equal(registered,true);
  const response=await post(request.payload,{'Content-Type':request.contentType,...request.headers});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{state:'PUBLISHED',date});
  assert.equal(accepted.total,1937025);
  assert.equal(accepted.deliveryCount,1938);
  assert.equal(accepted.vehicles.reduce((sum,vehicle)=>sum+(vehicle.waypointCount??0),0),1937);
});

test('GAS never sends a rejected, superseded, uncommitted, non-owner or non-approved-destination result',()=>{
  const {plans,details}=batch();
  const lease={id:runId},job={id:runId,day:date};
  const {api,requests}=gas();
  const report={code:'011',fullyReconciled:true};
  api.capture(report,date,observedAt,plans,details);
  api.queue([report],job,{ok:true,published:false},lease);
  api.send(lease);
  assert.equal(requests.length,0);
  report.fullyReconciled=false;
  api.queue([report],job,{ok:true,published:true},lease);
  api.send(lease);
  assert.equal(requests.length,0);
  const proxy=gas({acknowledgement:'<!doctype html>'});
  report.fullyReconciled=true;
  proxy.api.capture(report,date,observedAt,plans,details);
  proxy.api.queue([report],job,{ok:true,published:true},lease);
  proxy.api.send(lease);
  assert.equal(JSON.parse(proxy.messages[0]).state,'NOT_ACKNOWLEDGED');
  for(const settings of [{allowed:false},{audience:'https://unapproved.test'}]){
    const other=gas(settings);
    report.fullyReconciled=true;
    other.api.capture(report,date,observedAt,plans,details);
    other.api.queue([report],job,{ok:true,published:true},lease);
    other.api.send(lease);
    assert.equal(other.requests.length,0);
  }
});

test('receiver is off until approved and rejects wrong audience, clock key, replay window, changes and oversize',async t=>{
  let publishCalls=0;
  const publish=async()=>{
    publishCalls++;
    return {state:'PUBLISHED'};
  };
  const disabled=await start(t,{settings:{...env,OPSMAP_STAGE_WMS_OFFICIAL_ROUND_HANDOFF_APPROVED:'0'},publish});
  assert.equal(disabled.registered,false);
  assert.equal((await disabled.post('{}',makeSignedHeaders('{}'))).status,404);
  const {post}=await start(t,{publish});
  const {plans,details}=batch();
  const pair={plan:{...scope,rows:plans},dispatch:{...scope,rows:details}};
  const payload=JSON.stringify(pair), headers=makeSignedHeaders(payload);
  const stale=makeSignedHeaders(payload,{issuedAt:new Date(now-11*60_000).toISOString()});
  const wrongAudience=makeSignedHeaders(payload,{audience:PRIMARY_ORIGIN});
  const clock=makeSignedHeaders(payload,{key:secret});
  for(const rejected of [stale,wrongAudience,clock])assert.equal((await post(payload,rejected)).status,403);
  assert.equal((await post(payload+' ',headers)).status,400);
  assert.equal((await post(payload,{...headers,'Content-Encoding':'gzip'})).status,415);
  const wrongScope=JSON.stringify({...pair,dispatch:{...pair.dispatch,warehouse:'012'}});
  assert.equal((await post(wrongScope,makeSignedHeaders(wrongScope))).status,400);
  const oversized='X'.repeat(512*1024+1);
  assert.equal((await post(oversized,makeSignedHeaders(oversized))).status,413);
  assert.equal(publishCalls,0);
});

test('signed handoff bounds concurrent publication and does not disclose writer errors',async t=>{
  let release,startInFlight;
  const gate=new Promise(resolve=>{release=resolve;});
  const began=new Promise(resolve=>{startInFlight=resolve;});
  const {post}=await start(t,{publish:async()=>{
    startInFlight();
    await gate;
    throw Object.assign(Error('PRIVATE SOURCE ROW'),{code:'WMS_EXPORT_RELEASE_STALE'});
  }});
  const {plans,details}=batch();
  const payload=JSON.stringify({plan:{...scope,rows:plans},dispatch:{...scope,rows:details}});
  const headers=makeSignedHeaders(payload);
  const pending=post(payload,headers);
  await began;
  const busy=await post(payload,headers);
  assert.equal(busy.status,429);
  release();
  const conflict=await pending;
  assert.equal(conflict.status,409);
  assert.deepEqual(await conflict.json(),{error:'WMS_HANDOFF_CONFLICT'});
});
