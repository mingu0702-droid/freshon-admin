import assert from 'node:assert/strict';
import test from 'node:test';
import {archivedDatedDispatch,deliveryDigest,deliveryTaskId,retainDatedDriverEvidence} from '../src/datedDeliveryContract.js';
import {validateOpsmapSyncDay} from '../src/opsmapSyncGeneration.js';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
import {stageNearbyDispatchDay} from '../src/stageAbValidation.js';

const date='2026-11-11', at=(time)=>`${date}T${time}:00+09:00`;
const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
  OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'fixture-only'};
const task=(id,vehicle,details={})=>({id,deliveryDate:date,customer:{erpCode:`S${id}`},carrier:{fixedNo:vehicle},status:'COMPLETED',...details});
const record=(taskId,time,details={})=>({id:200+taskId,taskId,status:'COMPLETED',eventSource:'DRIVER_APP',eventAt:at(time),...details});
const page=(content,totalElements=content.length,number=0)=>Response.json({content,totalElements,totalPages:Math.ceil(totalElements/300),number});

test('keeps delivery stops distinct from proven driver events including an individual completion at 17:00',async()=>{
  const rows=[task(1,'101',{taskStatusRecords:[record(1,'17:00',{completeTypeText:'직접 전달'})]}),
    task(2,'101',{taskStatusRecords:[record(2,'16:04')]}),
    task(3,'101',{taskStatusRecords:[record(3,'17:00',{bulkJobId:'fixture-job'})]}),
    task(4,'101',{completedAt:at('17:00')}),
    task(5,'101',{taskStatusRecords:[record(5,'16:20',{eventAt:undefined})]}),
    task(6,'105',{status:'OPEN',completedAt:at('15:00')}),task(7,'122',{isBulk:true,completedAt:at('14:10')}),
    task(8,'202',{taskStatusRecords:[record(7,'16:20')]}),task(9,'101',{taskStatusRecords:[record(9,'16:04')]}),
    task(10,'105',{taskStatusRecords:[record(10,'13:00')]}),task(11,'105',{taskStatusRecords:[record(11,'13:10')]})];
  const read=createStageDatedDeliveryReader({env,fetchImpl:()=>page(rows)});
  const data=await read.readContract(date,'osan','101');
  const byId=id=>data.rows.find(row=>row.deliveryId===deliveryTaskId(id));
  assert.equal(data.count,6);
  assert.equal(data.sha256,deliveryDigest(data.rows));
  assert.deepEqual(data.chronology,[deliveryTaskId(1)]);
  assert.deepEqual(new Set(data.chronologyTies[0].deliveryIds),new Set([2,9].map(deliveryTaskId)));
  assert.equal(byId(1).completionType,'DIRECT_HANDOFF');
  assert.equal(byId(1).individualCompletedAt,'2026-11-11T08:00:00.000Z');
  assert.match(byId(1).eventId,/^[a-f0-9]{64}$/);
  assert.equal(byId(3).completionType,'ADMIN_BULK_17');
  assert.equal(byId(4).verification,'NO_INDIVIDUAL_RECORD');
  assert.equal(byId(5).verification,'TIME_UNVERIFIED');
  assert.equal((await read.readContract(date,'osan','122')).rows[0].completionType,'ADMIN_BULK');
  assert.deepEqual((await read.readContract(date,'osan','105')).chronology,[10,11].map(deliveryTaskId));
  assert.equal((await read.readContract(date,'osan','202')).rows[0].individualCompletedAt,null);
});

test('source event IDs retain revisits to the same customer and omit chronology for missing or conflicting event IDs',async()=>{
  const rows=[task(1,'105',{customer:{erpCode:'S1'},taskStatusRecords:[record(1,'16:10')]}),
    task(2,'105',{customer:{erpCode:'S1'},taskStatusRecords:[record(2,'16:15')]}),
    task(3,'105',{taskStatusRecords:[record(3,'16:20',{id:null})]}),
    task(4,'105',{taskStatusRecords:[record(4,'16:25'),record(4,'16:25',{id:999})]})];
  const read=createStageDatedDeliveryReader({env,fetchImpl:()=>page(rows)});
  const result=await read.readContract(date,'osan','105');
  assert.equal(result.activeCount,4);
  assert.deepEqual(result.chronology,[deliveryTaskId(1),deliveryTaskId(2)]);
  assert.equal(result.rows.find(row=>row.deliveryId===deliveryTaskId(3)).verification,'TIME_UNVERIFIED');
  assert.equal(result.rows.find(row=>row.deliveryId===deliveryTaskId(4)).verification,'EVENT_CONFLICT');
  assert.equal(result.source.kind,'DELIVERY_ADMIN_READ');
  assert.equal(result.source.observedAt,result.lastSuccessAt);
  assert.equal(result.sourceGeneration,result.source.sha256);
});

test('staff roster names use the exact dated center assignment and never expose contact fields',async()=>{
 const assigned={driverName:'검증 기사 가',driverPhone:'010-1234-5678',logisticsCenterId:1};
 const rows=[task(1,'102',assigned),task(2,'105',assigned),task(3,'105',{...assigned,driverPhone:undefined}),
   task(4,'102',{...assigned,logisticsCenterId:undefined}),task(5,'102',{...assigned,driverName:'대체용차'}),
   task(6,'102',{...assigned,driver:{name:'검증 기사 나'}}),
   task(7,'126',{carrierName:assigned.driverName,carrierPhone:assigned.driverPhone,logisticsCenterInfo:{id:1}}),
   task(8,'126',{carrier:undefined,carrierInfo:{fixedNo:'126',name:assigned.driverName,tel:assigned.driverPhone,logisticsCenterId:1}}),
   task(9,'126',{carrier:{fixedNo:'126',name:'126호차',tel:assigned.driverPhone,logisticsCenterId:1}}),
   task(10,'126',{...assigned,carrierName:'서로 다른 기사',carrierPhone:'02-123-4567'}),
   task(11,'126',{driverName:assigned.driverName,carrierPhone:assigned.driverPhone,logisticsCenterId:1}),
   task(12,'126',{...assigned,carrierName:assigned.driverName,carrierPhone:'010-2345-6789'}),
   task(13,'126',{...assigned,carrierName:assigned.driverName,carrierPhone:'+82-10-1234-5678'}),
   task(15,'126',{carrier:{fixedNo:'126',logisticsCenterId:1,driverName:assigned.driverName,driverPhoneNumber:assigned.driverPhone}}),
   task(16,'126',{carrier:{fixedNo:'126',...assigned,driverPhoneNumber:'010-2345-6789'}})];
 const seen=[];
 const read=createStageDatedDeliveryReader({env:{...env,MAP_STAFF_SESSION_SECRET:'fixture-driver-roster-secret-000000'},fetchImpl:url=>{
   seen.push(url.pathname);return page(rows);
 }});
 const roster=await read.readContract(date,'osan',null);
 const byId=id=>roster.rows.find(row=>row.deliveryId===deliveryTaskId(id));
 assert.equal(byId(1).driverName,assigned.driverName);
 assert.equal(byId(1).driverIdentity,'VERIFIED');
 assert.match(byId(1).driverKey,/^[a-f0-9]{64}$/);
 assert.equal(byId(1).driverKey,byId(2).driverKey);
 for(const id of [3,4,5,6,9,10,11,12,16])assert.equal(byId(id).driverKey,undefined);
 for(const id of [7,8,13,15])assert.equal(byId(id).driverKey,byId(1).driverKey);
 assert.doesNotMatch(JSON.stringify(roster),/driverPhone|010-1234-5678/);
 assert.doesNotMatch(JSON.stringify(await read(date)),/driverName|driverKey|010-1234-5678/);
 assert.deepEqual(seen,['/api/bali/task']);
 const conflictingCenter=createStageDatedDeliveryReader({env,fetchImpl:()=>page([task(14,'126',{...assigned,logisticsCenterInfo:{id:3}})])});
 await assert.rejects(conflictingCenter.readContract(date,'osan',null),{code:'DELIVERY_SOURCE_SCOPE'});
});

test('retained roster keeps only matching exact-visit drivers without altering saved stops or ordering',()=>{
 const base={deliveryDate:date,vehicle:'126',state:'COMPLETED'};
 const rows=Array.from({length:7},(_,i)=>({...base,deliveryId:deliveryTaskId(i+1),customerCode:'S'+(i+1)}));
 const view={date,center:'osan',sourceId:'1',vehicle:null,sourceComplete:true,rows};
 const saved={...view,state:'PUBLISHED_VERIFIED',count:rows.length,chronology:[rows[0].deliveryId],source:{sha256:'a'.repeat(64)}};
 const proof={driverIdentity:'VERIFIED',driverKey:'b'.repeat(64),driverName:'확인 기사'};
 const observed={...view,state:'LIVE_VERIFIED',rows:[{...rows[0],...proof,unexpected:'discard'},
   {...rows[1],...proof,customerCode:'S999'}, {...rows[2],...proof,vehicle:'102'}, {...rows[3],...proof,state:'OPEN'},
   {...rows[4],...proof,deliveryDate:'2026-11-10'}, {...rows[5],...proof,deliveryId:deliveryTaskId(100)}]};
 const merged=retainDatedDriverEvidence(saved,observed);
 assert.equal(merged.state,'PUBLISHED_VERIFIED');
 assert.equal(merged.count,rows.length);
 assert.equal(merged.source,saved.source);
 assert.equal(merged.chronology,saved.chronology);
 assert.equal(merged.sha256,deliveryDigest(merged.rows));
 assert.deepEqual(merged.rows,[{...rows[0],...proof},...rows.slice(1)]);
 assert.equal(retainDatedDriverEvidence(saved,{...observed,center:'honam'}),saved);
 assert.equal(retainDatedDriverEvidence(saved,{...observed,state:'STALE_VERIFIED'}),saved);
});

test('all pages are checked before returning and incomplete, duplicated or conflicting reads retain the same day only',async()=>{
  let now=Date.parse(at('20:00')), mode='initial', calls=0;
  const tasks=Array.from({length:301},(_,i)=>task(i+1,'101'));
  const read=createStageDatedDeliveryReader({env,now:()=>now,fetchImpl(url){
    calls++;
    const number=Number(url.searchParams.get('page'));
    if (url.searchParams.getAll('enteringDatedAtBetween')[0].slice(0,10)!==date) return new Response(null,{status:403});
    if (mode==='short' && number===1) return page([],301,number);
    if (mode==='duplicate' && number===1) return page([tasks[0]],301,number);
    if (mode==='conflict' && number===1) return page([{...tasks.at(-1),confirmedVehicle:'105'}],301,number);
    if (mode==='vanish') return page([]);
    return page(tasks.slice(number*300,number*300+300),301,number);
  }});
  const [first,other]=await Promise.all([read.readContract(date,'osan','101'),read.readContract(date,'osan','105')]);
  assert.equal(calls,2);
  assert.equal(first.source.pages,2);
  assert.equal(other.confirmedEmpty,true);
  for (const [caseName,code] of [['short','INCOMPLETE'],['duplicate','PAGE_DUPLICATE'],['conflict','VEHICLE_CONFLICT'],['vanish','REGRESSION']]) {
    now+=61_000; mode=caseName;
    const retained=await read.readContract(date,'osan','101');
    assert.equal(retained.state,'STALE_VERIFIED');
    assert.equal(retained.currentReadComplete,false);
    assert.equal(retained.error,'DELIVERY_SOURCE_'+code);
    assert.equal(retained.sha256,first.sha256);
  }
  await assert.rejects(read.readContract('2026-11-10','osan','101'),{code:'DELIVERY_SOURCE_FORBIDDEN'});
  await assert.rejects(read.readContract(date,'yeongnam','101'),{code:'DELIVERY_SOURCE_CENTER_UNVERIFIED'});
});

test('four physical sources persist counts, deduplicate exact in-page IDs and bind completion to the sealed day',async()=>{
  const reads=[];
  const row=task(1,'101',{taskStatusRecords:[record(1,'14:10')]});
  const read=createStageDatedDeliveryReader({env,syncCenters:{osan:'1',osanColdStorage:'2',yeongnam:'3',honam:'4'},
    fetchImpl(url){const id=url.searchParams.get('logisticsCenterId');reads.push(id);
      return page(id==='1'?[row,row]:id==='2'?[task(2,'105')]:[]);}});
  const day=await read.readObservation(date);
  assert.deepEqual(reads,['1','2','3','4']);
  assert.deepEqual(day.dispatch.sources,[['1',1,2,1],['2',1,1,0],['3',1,0,0],['4',1,0,0]]);
  const copy=validateOpsmapSyncDay(JSON.parse(JSON.stringify(day)),date);
  const restored=archivedDatedDispatch(copy,{center:'osan',vehicle:'101',generation:'a'.repeat(64),error:'DELIVERY_SOURCE_FORBIDDEN'});
  assert.deepEqual(restored.chronology,[deliveryTaskId(1)]);
  assert.equal(restored.source.duplicateRows,1);
  assert.equal(restored.state,'PUBLISHED_VERIFIED');
  assert.equal(archivedDatedDispatch(copy,{center:'osanColdStorage',vehicle:'105'}).count,1);
  assert.equal(archivedDatedDispatch(copy,{center:'yeongnam'}).lastVerifiedEmpty,true);
  const nearby=stageNearbyDispatchDay({generation:'a'.repeat(64)},date,copy);
  assert.deepEqual(nearby.centers,{osan:'VERIFIED',yeongnam:'VERIFIED',honam:'VERIFIED'});
  assert.deepEqual(nearby.rows,[{customerCode:'S1',center:'osan',vehicle:'101',completed:true}]);
  assert.deepEqual(stageNearbyDispatchDay({generation:'a'.repeat(64)},'2026-11-10',copy).centers,
    {osan:'UNKNOWN',yeongnam:'UNKNOWN',honam:'UNKNOWN'});
  const legacy=structuredClone(copy);
  legacy.dispatch.events=legacy.dispatch.events.map(event=>event.slice(0,7));
  legacy.proofHash=deliveryDigest([date,legacy.tasks,legacy.visits,legacy.dispatch]);
  assert.deepEqual(archivedDatedDispatch(validateOpsmapSyncDay(legacy,date),{center:'osan',vehicle:'101'}).chronology,[]);
  copy.dispatch.events[0][1]='UNKNOWN';
  assert.throws(()=>validateOpsmapSyncDay(copy,date),/DELIVERY_EVENT_CONTRACT/);
  copy.dispatch.events[0]=day.dispatch.events[0];
  copy.proofHash='b'.repeat(64);
  assert.throws(()=>validateOpsmapSyncDay(copy,date),/DELIVERY_DISPATCH_PROOF/);
});

test('the opt-in status-record read retries only transient failures and excludes a proven batch from visits',async()=>{
  const time=at('17:00');
  const rows=[task(1,'105',{completeType:'DIRECT',completeDatedAt:time}),task(2,'105',{completeType:'DIRECT',completeDatedAt:time})];
  const requests=[];
  const read=createStageDatedDeliveryReader({env:{...env,OPSMAP_STAGE_DELIVERY_EVENT_READ_APPROVED:'1'},fetchImpl(url,options){
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    if (url.pathname==='/api/bali/task') return page(rows);
    const id=Number(url.pathname.split('/')[4]);
    requests.push(id);
    if (id===1 && requests.filter(value=>value===1).length===1) return new Response(null,{status:503});
    return Response.json([{id:100+id,taskId:id,status:'COMPLETED',completeType:'DIRECT',createdAt:time,
      gpsPosition:{latitude:'37.15',longitude:'127.05',isEmpty:false},...(id===2?{action:'BATCH_COMPLETE'}:{})}]);
  }});
  const first=await Promise.all([read.readContract(date,'osan','105'),read.readContract(date,'osan','105')]);
  assert.deepEqual(requests,[1,2,1]);
  assert.deepEqual(first[0],first[1]);
  assert.deepEqual(first[0].chronology,[deliveryTaskId(1)]);
  assert.equal(first[0].rows.find(row=>row.deliveryId===deliveryTaskId(1)).sourceCompletionType,'DIRECT');
  assert.equal(first[0].rows.find(row=>row.deliveryId===deliveryTaskId(2)).completionType,'ADMIN_BULK_17');
  assert.deepEqual(first[0].eventRead,{requested:2,attempted:2,failed:0,truncated:false});
  const day=await read.readObservation(date);
  assert.deepEqual(day.visits.map(row=>row[0]),[deliveryTaskId(1)]);
  assert.deepEqual(archivedDatedDispatch(day,{center:'osan',vehicle:'105'}).chronology,[deliveryTaskId(1)]);
  assert.equal(JSON.stringify(day).includes('gpsPosition'),false);
});
