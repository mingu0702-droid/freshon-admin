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

function gas({allowed=true,audience=STAGE_ORIGIN,acknowledgement=JSON.stringify({state:'PUBLISHED',date}),nightly=false,night}={}){
  const requests=[],messages=[];
  const props={OPSMAP_WMS_OFFICIAL_HANDOFF_V1:JSON.stringify({enabled:true,audience,nightly}),
    OPSMAP_WMS_OFFICIAL_CAPABILITY_B64:deriveOpsmapWmsHandoffKey(secret,STAGE_ORIGIN).toString('base64')};
  const byteArray=buffer=>Array.from(buffer,byte=>byte>127?byte-256:byte);
  const context={
    Date:night?class extends Date{static now(){return night.now();}}:fixedDate,
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>props[key]})},
    Utilities:{base64Decode:value=>byteArray(Buffer.from(value,'base64')),base64Encode:bytes=>Buffer.from(bytes).toString('base64'),
      newBlob:value=>({getBytes:()=>byteArray(Buffer.from(value,'utf8'))}),
      DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(algorithm,bytes)=>byteArray(createHash(algorithm).update(Buffer.from(bytes)).digest()),
      computeHmacSha256Signature:(bytes,key)=>byteArray(createHmac('sha256',Buffer.from(key)).update(Buffer.from(bytes)).digest()),getUuid:()=>runId},
    UrlFetchApp:{fetch:(url,opts)=>{
      requests.push({url,...opts});
      return {getResponseCode:()=>200,getContentText:()=>acknowledgement};
    }},
    soOwner_:()=>{if(!allowed)throw Error('DENIED');},
    console:{log:x=>messages.push(x),warn:x=>messages.push(x)},
    ...(night?.context||{})
  };
  const api=runInNewContext(gasSource+'\n({capture:opsmapCaptureWmsOfficialRound_,queue:opsmapQueueWmsOfficialRound_,send:opsmapSendWmsOfficialRound_,night:opsmapRunNightWmsOfficialRound_})',context);
  return {api,requests,messages,context};
}

function makeSignedHeaders(payload,{audience=STAGE_ORIGIN,issuedAt=new Date(now).toISOString(),shipDate=date,key=deriveOpsmapWmsHandoffKey(secret,audience)}={}){
  const digest=hexDigest(payload);
  return {'Content-Type':'application/json','X-Opsmap-Wms-Date':shipDate,'X-Opsmap-Wms-Issued-At':issuedAt,
    'X-Opsmap-Wms-Body-Sha256':digest,'X-Opsmap-Wms-Signature':createHmac('sha256',key)
      .update(JSON.stringify(['opsmap-wms-owner-handoff-v1',audience,OPSMAP_WMS_HANDOFF_ROUTE,'011',shipDate,issuedAt,digest])).digest('hex')};
}

async function start(t,{settings=env,publish,now:clockNow=now}={}){
  const app=express();
  const registered=mountOpsmapWmsOfficialRoundHandoff(app,{env:settings,clock:{secret},now:()=>clockNow,publish});
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


const nightStart=Date.parse('2026-11-26T12:15:00.000Z');
const scheduledAt=Date.parse('2026-11-26T12:00:00.000Z');
const uid='1234567890';
const receipt={ok:true,source:'30-minute-clock',requestId:'R'+uid+'_'+scheduledAt,scheduledAt};
const nightStateKey='OPSMAP_WMS_OFFICIAL_NIGHT_V1';

function nightGas({nightly=true,owner=true,reconciled=true,failure,acknowledgement,nightTime=nightStart}={}){
  const state=new Map([
    ['TRIGGERS',{clock:uid,bootstrap:'other'}],
    ['clock-request-'+receipt.requestId,{first:false,uid,scheduledAt,day:'2026-11-26'}]
  ]);
  const {plans,details}=batch();
  const calls=[];
  const provider={
    SON_CLOCK_REQUEST_PREFIX_:'clock-request-',
    SON_METER_:null,
    sonState_:key=>state.get(key),
    sonSave_:(key,value)=>state.set(key,value),
    sonOwnerEffective_:()=>{if(!owner)throw Error('DENIED');},
    soLock_:operation=>operation(),
    sopKstDay_:time=>new Date(time.getTime()+9*60*60*1000).toISOString().slice(0,10),
    soRead_:()=>({file:'fixture'}),
    sonDriverCredential_:()=>({username:'fixture',password:'fixture'}),
    swfLiveLogin_:()=>{calls.push('login');return {};},
    swfSpec_:(_session,warehouse,day,dispatch)=>({warehouse,day,dispatch}),
    swfSend_:specs=>{
      calls.push(JSON.parse(JSON.stringify(specs)));
      if(failure)throw failure;
      return [plans,details];
    },
    swfRows_:(source,warehouse,day)=>{
      assert.equal(warehouse,'011');
      assert.equal(day,'20261127');
      return source;
    },
    swfReport_:()=>({code:'011',fullyReconciled:reconciled})
  };
  const instance=gas({nightly,acknowledgement,night:{now:()=>nightTime,context:provider}});
  return {...instance,calls,state};
}

test('nightly owner clock offers one same-wave Osan tomorrow pair without changing the existing MIS receipt',async t=>{
  const {api,requests,calls,state,context}=nightGas();
  const trigger={triggerUid:uid};
  const unchanged={...receipt};
  api.night(trigger,receipt,nightStart);
  api.night(trigger,receipt,nightStart);
  assert.deepEqual(receipt,unchanged);
  assert.equal(context.SON_METER_,null);
  assert.deepEqual(calls,['login',[
    {warehouse:'011',day:'20261127',dispatch:false},
    {warehouse:'011',day:'20261127',dispatch:true}
  ]]);
  assert.equal(requests.length,1);
  assert.equal(state.get(nightStateKey).state,'ACKNOWLEDGED');
  assert.doesNotMatch(requests[0].payload,/PRIVATE/);
  let official;
  const {post}=await start(t,{now:nightStart,publish:async value=>{
    const bytes=encodeWmsOfficialRound(value.round,value.date);
    official=decodeWmsOfficialRound(bytes,{date,observedAt:new Date(nightStart).toISOString()}).data;
    return {state:'PUBLISHED'};
  }});
  const response=await post(requests[0].payload,{'Content-Type':requests[0].contentType,...requests[0].headers});
  assert.equal(response.status,200);
  assert.equal(official.total,2025);
  assert.equal(official.vehicles.find(row=>row.vehicle==='100').waypointCount,2);
});

test('nightly owner clock stays off outside approval, UID, matching execution receipt, time and owner',()=>{
  const variants=[
    {args:{nightly:false}},
    {args:{owner:false}},
    {triggerUid:'unapproved'},
    {receipt:{...receipt,ok:false}},
    {receipt:{...receipt,requestId:'R9_'+scheduledAt}},
    {receipt:{...receipt,source:'first-clock'}},
    {started:Date.parse('2026-11-26T12:09:00.000Z')},
    {started:Date.parse('2026-11-26T21:12:00.000Z')},
    {started:Date.parse('2026-11-26T13:10:00.000Z')},
    {args:{nightTime:nightStart+111_000},started:nightStart}
  ];
  for(const value of variants){
    const {api,requests,calls,state}=nightGas(value.args);
    api.night({triggerUid:value.triggerUid||uid},value.receipt||receipt,value.started??nightStart);
    assert.deepEqual(calls,[]);
    assert.deepEqual(requests,[]);
    assert.equal(state.has(nightStateKey),false);
  }
});

test('nightly owner clock keeps one attempt when the provider or receiver result is uncertain',()=>{
  for(const args of [{failure:Error('PRIVATE MESSAGE')},{reconciled:false},{acknowledgement:'{}'}]){
    const {api,requests,calls,state,messages}=nightGas(args);
    api.night({triggerUid:uid},receipt,nightStart);
    api.night({triggerUid:uid},receipt,nightStart);
    assert.equal(calls.length,2);
    assert.equal(requests.length,args.acknowledgement?1:0);
    assert.ok(['ATTEMPTED','NOT_ACKNOWLEDGED'].includes(state.get(nightStateKey).state));
    assert.doesNotMatch(messages.join('\n'),/PRIVATE/);
  }
});

test('an existing owner correction from this delivery morning posts once without another WMS fetch',async t=>{
  const morningAt=Date.parse('2026-11-26T21:12:00.000Z');
  const {api,requests}=gas({night:{now:()=>morningAt}});
  const {plans,details}=batch(3);
  const lease={id:runId},job={id:runId,day:date};
  const report={code:'011',fullyReconciled:true};
  api.capture(report,date,morningAt-1_000,plans,details);
  api.queue([report],job,{ok:true,published:true},lease);
  api.send(lease);
  api.send(lease);
  assert.equal(requests.length,1);
  let published;
  const {post}=await start(t,{now:morningAt,publish:async input=>{
    assert.equal(input.reconcileExisting,true);
    const {round,date:shipDate}=input;
    const bytes=encodeWmsOfficialRound(round,shipDate);
    published=decodeWmsOfficialRound(bytes,{date:shipDate,observedAt:round.plan.observedAt}).data;
    return {state:'PUBLISHED'};
  }});
  const [request]=requests;
  const response=await post(request.payload,{'Content-Type':request.contentType,...request.headers});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{state:'PUBLISHED',date});
  assert.equal(published.observedAt,new Date(morningAt-1_000).toISOString());
  assert.equal(published.total,3025);
  assert.equal(published.vehicles.find(row=>row.vehicle==='100').waypointCount,3);
});
