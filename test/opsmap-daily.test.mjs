import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {datedCompletionEvent,datedSourceFailure,dailyAssignmentContract} from '../src/opsmapDailyServer.js';
import {createDailyRetainedStore} from '../src/opsmapDailyRetained.js';
import {readPaginatedDatedAssignments} from '../src/opsmap-abc/phase2bAssignments.js';
import '../public/opsmap/opsmap-daily.js';
const daily=globalThis.OpsmapDaily,date='2026-11-11';
const at=hh=>date+'T'+hh+':00:00+09:00';
const event=(id,type,hh,extra={})=>datedCompletionEvent({id,status:'COMPLETED',
  completionEvent:{type,source:'DRIVER_APP',at:at(hh),...extra}});
const visit=(code,actualDeliveryEvent,extra={})=>({customerCode:code,vehicle:'105',deliveryDate:date,status:'COMPLETED',
  lat:37,lng:127,actualDeliveryEvent,...extra});
test('only explicit individual handoff or delivery completion enters the line, including genuine 17:00',()=>{
  const first=event('1','직접전달','09'),last=event('2','배송완료','17');
  assert.equal(first.kind,'DIRECT_HANDOFF');
  assert.equal(last.kind,'DELIVERY_COMPLETED');
  assert.equal(event('3','배송완료','17',{bulk:true}),null);
  assert.equal(event('3','배송완료','17',{source:'SYSTEM'}),null);
  assert.equal(event('3','배송완료','17',{at:'2026-02-30T08:30:00+09:00'}),null);
  assert.equal(event('3','배송완료','17',{at:null}),null);
  assert.equal(event('3','배송완료','17',{deliveryId:4}),null);
  assert.equal(datedCompletionEvent({id:3,status:'COMPLETED',completedAt:at('08')}),null);
  const points=daily.actualPoints([visit('B',last,{order:1}),visit('A',first,{order:99}),
    visit('A2',first),visit('NO_POINT',event('4','배송완료','08'),{lat:null}),visit('BULK',null),
    visit('PENDING',event('5','배송완료','08'),{status:'PENDING'})]);
  assert.deepEqual(points.map(p=>p.row.customerCode),['A','B']);
});
test('partial pages and mismatched dates or duplicated assignments never validate as empty',async()=>{
  assert.throws(()=>daily.validate({ok:true,data:[],meta:{date,complete:false,rowCount:0}},date),/INCOMPLETE/);
  assert.throws(()=>daily.validate({ok:true,data:[],meta:{date,complete:true}},date),/INCOMPLETE/);
  assert.doesNotThrow(()=>daily.validate({ok:true,data:[],meta:{date,complete:true,rowCount:0}},date));
  const rows=[visit('A',null),visit('A',null)];
  assert.throws(()=>daily.validate({ok:true,data:rows,meta:{date,complete:true,rowCount:2}},date),/INCOMPLETE/);
  const page=(offset,revision)=>({ok:true,data:[{...visit('A'+offset,null),sourceKey:'key'+offset}],meta:{date,contract:'dated-assignments-v1',sourceCount:2,totalCount:2,
    pageOffset:offset,count:1,pageSize:1,truncated:false,hasMore:offset===0,complete:offset!==0,nextCursor:offset===0?'next':null,sourceRevision:revision}});
  await assert.rejects(readPaginatedDatedAssignments(date,({cursor})=>cursor?page(1,'new'):page(0,'old'),{pageSize:1}),/GENERATION_CHANGED/);
  assert.throws(()=>daily.validate({ok:true,data:[visit('A',null,{deliveryDate:'2026-11-10'})],meta:{date,complete:true,rowCount:1}},date),/INCOMPLETE/);
  assert.throws(()=>daily.validate({ok:true,data:[visit('A',null,{confirmedVehicle:'122'})],meta:{date,complete:true,rowCount:1}},date),/INCOMPLETE/);
});
test('HTTP 401/403/429/500/502/503, timeout, partial and cancellation have distinct labels',()=>{
  for(const status of [401,403,429,500,502,503]){
    const failure=datedSourceFailure({upstreamStatus:status}); assert.equal(failure.status,status);
    assert.match(daily.errorLabel(failure),new RegExp(String(status)));
  }
  assert.match(daily.errorLabel(datedSourceFailure(Error('HUB_TIMEOUT'))),/시간 초과/);
  assert.match(daily.errorLabel(datedSourceFailure(Error('DATED_ASSIGNMENTS_PAGE_GAP'))),/부분 페이지/);
  assert.match(daily.errorLabel({code:'REQUEST_CANCELLED'}),/취소/);
});
test('Seoul date turns to D+1 at 21:00 while an explicit selected date remains valid through midnight',()=>{
  for(const [kst,expected] of [['20:59:59','2026-11-11'],['21:00:00','2026-11-12'],['23:59:59','2026-11-12']])
    assert.equal(daily.dispatch(Date.parse(date+'T'+kst+'+09:00')),expected);
  assert.equal(daily.dispatch(Date.parse('2026-11-12T00:00:00+09:00')),'2026-11-12');
  assert.equal(daily.calendar(Date.parse('2026-11-12T00:00:00+09:00')),'2026-11-12');
  assert.equal(daily.day(date),true);
});
test('fresh process restores the same sealed date after restart; wrong key and tampering are rejected',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'opsmap-daily-')),secret='synthetic-secret'.repeat(3);
  try{
    const store=createDailyRetainedStore({directory,secret});
    const value=dailyAssignmentContract({ok:true,data:[visit('S970001',event('42','배송완료','10'),{phone:'PRIVATE_NOT_RETAINED'})],
      meta:{date,complete:true,source:'synthetic'}});
    await store.write(value);
    const module=new URL('../src/opsmapDailyRetained.js',import.meta.url).href;
    const restored=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',
      'const {createDailyRetainedStore}=await import(process.argv[1]);console.log(JSON.stringify(await createDailyRetainedStore({directory:process.argv[2],secret:process.argv[3]}).read(process.argv[4])));',
      module,directory,secret,date],{encoding:'utf8'}));
    assert.equal(restored.meta.sourceRevision,value.meta.sourceRevision);
    assert.equal(restored.data[0].customerCode,'S970001');
    assert.equal(restored.data[0].phone,undefined);
    assert.equal(await createDailyRetainedStore({directory,secret:'z'.repeat(40)}).read(date),null);
    const file=path.join(directory,'opsmap-daily-'+date+'.sealed'),cipher=await readFile(file);
    cipher[40]^=1; await writeFile(file,cipher);
    assert.equal(await store.read(date),null);
  }finally{await rm(directory,{recursive:true,force:true});}
});

import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
test('Delivery wire-format: per-vehicle record requests are shared and cannot add unproven or foreign visits',async()=>{
  const t=at('17'),gps={latitude:'37.125',longitude:'127.250',isEmpty:false};
  const task=(id,type,vehicle='105')=>({id,status:'COMPLETED',completeType:type,completeDatedAt:t,enteringDatedAt:date,
    customer:{erpCode:'S'+id},carrier:{fixedNo:vehicle,logisticsCenterId:1},location:{gps}});
  const rows=[task(1,'DIRECT'),task(2,'FRONT_DOOR'),task(3,'BASIC'),task(4,'DIRECT','122')];
  const calls=[];
  const reader=createStageDatedDeliveryReader({env:{RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'fixture-only',OPSMAP_STAGE_DELIVERY_EVENT_READ_APPROVED:'1'},fetchImpl:async(url,options)=>{
      assert.equal(options.method,'GET');calls.push(url.pathname);
      if(url.pathname==='/api/bali/task')return Response.json({content:rows,totalElements:4,totalPages:1,number:0});
      const id=Number(url.pathname.split('/').at(-2)),row=rows.find(r=>r.id===id);
      return Response.json([{id:id+20,taskId:id,createdBy:'fixture-driver',createdAt:date+'T17:00:00.000001+09:00',
        completeType:row.completeType,status:id===2?'BEFORE':'COMPLETED',gpsPosition:gps,
        ...(id===3?{bulk:true}:{})}]);
    }});
  const roster=await reader(date);
  assert.equal(roster.vehicles[0].stops[0].lat,37.125);
  assert.equal(roster.vehicles[0].stops[0].deliveryCompletedAt,null);
  const read=()=>reader.readContract(date,'osan','105');
  const [a,b]=await Promise.all([read(),read()]);
  assert.equal(a,b);
  assert.equal(a.sourceComplete,true);
  assert.deepEqual(a.rows.filter(x=>a.chronology.includes(x.deliveryId)).map(x=>[x.customerCode,x.completionType]),[['S1','DIRECT_HANDOFF']]);
  const completeRoster=await reader.readContract(date,'osan',null);
  const chronology=daily.chronology(completeRoster,a,'105');
  assert.equal(chronology.points.size,1);
  assert.equal(chronology.status.get(a.rows.find(row=>row.customerCode==='S2').deliveryId),null);
  assert.throws(()=>daily.chronology(completeRoster,{...a,chronologyTies:[{deliveryIds:a.chronology}]},'105'));
  assert.throws(()=>daily.chronology(completeRoster,a,'122'));
  assert.deepEqual(calls.sort(),['/api/bali/task','/api/bali/task/1/status-record','/api/bali/task/2/status-record','/api/bali/task/3/status-record']);
});

import express from 'express';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {mountProductionMapApi} from '../src/opsmap-abc/productionMapIntegration.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
test('a new HTTP service serves the last complete disk result while its source is still blocked', {timeout:5000}, async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'opsmap-daily-http-')),secret='synthetic-secret'.repeat(3);
  let releaseSource, first, second;
  const password='synthetic-test-password', origin='https://localhost:3000';
  const passwordHash=await createStaffPasswordHash(password);
  const serve=async reader=>{
    const app=express();
    mountProductionMapApi(app,{previewEnabled:()=>true,requireView:(_q,_r,next)=>next(),
      readPhase2bSnapshot:async()=>null,getSnapshotMemory:()=>null,phase2bKstDate:()=>date,
      normalizeDateValue:value=>value,phase2bTodayStatus:reader,hybridEnabled:()=>false,
      authOptions:{env:{MAP_STAFF_SESSION_SECRET:secret,OPSMAP_DAILY_RETAINED_DIR:directory,MAP_STAFF_ID:'fixture',MAP_STAFF_ORIGIN:origin,MAP_STAFF_PASSWORD_HASH:passwordHash}}});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+server.address().port+'/api/map-phase2b';
    const auth=await fetch(base+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password})});
    assert.equal(auth.status,200);
    const cookie=auth.headers.get('set-cookie').split(';')[0];
    return {close:()=>new Promise(resolve=>server.close(resolve)),read:()=>fetch(base+'/preview/assignments?date='+date,{headers:{cookie}}).then(r=>r.json())};
  };
  const observation=deliverySourceObservation([{enteringDatedAt:date}],{date,complete:true,pages:1,resolveVehicle:()=> '105'});
  const live={date,sourceObservation:observation,generatedAt:at('04'),vehicles:[{vehicle:'105',stops:[visit('S1',null)]}]};
  try{
    first=await serve(async()=>live);
    assert.equal((await first.read()).data[0].customerCode,'S1');await first.close();first=null;
    let entered;
    const started=new Promise(resolve=>{entered=resolve;});
    second=await serve(async()=>{entered();await new Promise(resolve=>{releaseSource=resolve;});return live;});
    const value=await second.read();await started;
    assert.equal(value.meta.retained,true);assert.equal(value.data[0].customerCode,'S1');
    releaseSource();
    assert.equal((await second.read()).meta.retained,undefined);
  }finally{releaseSource?.();await first?.close();await second?.close();await rm(directory,{recursive:true,force:true});}
});
