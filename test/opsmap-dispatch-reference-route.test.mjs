import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createOpsmapDispatchReferenceReader, mountOpsmapDispatchReference } from '../src/opsmapDispatchReference.js';
import { deliverySourceObservation } from '../src/snapshotRefreshEvidence.js';
import { coordinateAddressHash } from '../src/opsmap-abc/opsmapAutoCoordinates.js';
import { summarizeDispatchPeriod } from '../public/opsmap/dispatch-reference-period.mjs';

const date = '2026-11-21';
const timestamp = date+'T09:00:00.000Z';
const address = 'a'.repeat(64), otherAddress = 'b'.repeat(64);
const tasks = [
  ['id-1','S91001','101','osan',address,'COMPLETED'],
  ['id-2','S91001','101','osan',address,'OPEN'],
  ['id-3','S91002','108','osan',otherAddress,'COMPLETED'],
  ['id-4','S91003',null,'osan',null,'OPEN'],
  ['id-5','S91004','108','osan',null,'CANCELLED'],
  ['id-6','S91005','301','yeongnam',null,'OPEN'],
];
const event = source => [source,'UNKNOWN','NO_INDIVIDUAL_RECORD',null,null,'DELIVERY_TASK_LIST','NO_INDIVIDUAL_RECORD'];
const day = {date,tasks,dispatch:{sources:[['1',1,5,0],['3',1,1,0]],events:tasks.map(row=>event(row[3]==='osan'?'1':'3'))}};
const registry = new Map([['S91001',{name:'검증 매장',addressHash:address,matchHash:address,hasPoint:true,lat:37.1,lng:127.1}],
  ['S91002',{name:'이전한 매장',addressHash:address,hasPoint:true,lat:37.2,lng:127.2}]]);
const publication = {generation:'generation-1',postalGeneration:'postal-1',publishedAt:timestamp,observedAt:()=>timestamp,readDay:async()=>day,registry};
const amounts = async requested => ({date:requested,state:'VERIFIED',observedAt:timestamp,
  vehicles:[{vehicle:'101',amount:12000,routeCode:null,detailState:'UNAVAILABLE'}]});

test('one exact published Osan day keeps separate WMS provenance and exact postal matches',async()=>{
  const read = createOpsmapDispatchReferenceReader({getPublication:()=>publication,readAmounts:amounts,
    readPostcodes:async(codes,generation)=>{
      assert.deepEqual(codes,['S91001']);
      assert.equal(generation,'postal-1');
      return new Map([['S91001','01234']]);
    }});
  const data = await read(date);
  assert.deepEqual(data.route.rows,[{vehicle:'101',customerCode:'S91001',customerName:'검증 매장',postalCode:'01234',lat:37.1,lng:127.1,coordinateVerified:true},
    {vehicle:'108',customerCode:'S91002',customerName:'이전한 매장',postalCode:null,lat:null,lng:null,coordinateVerified:false}]);
  assert.equal(data.center,'osan');
  assert.equal(data.route.source,'PUBLISHED_DELIVERY_ARCHIVE');
  assert.equal(data.route.unassigned,1);
  assert.deepEqual(data.amounts,await amounts(date));
  assert(!JSON.stringify(data).includes('id-1'));
});

test('a mismatched delivery day or switched generation cannot be compared with WMS',async()=>{
  let published = publication;
  const read = createOpsmapDispatchReferenceReader({getPublication:()=>published,readAmounts:amounts,
    readPostcodes:async()=>{published={...publication,generation:'generation-2'};return new Map();}});
  const result = await read(date);
  assert.equal(result.route.state,'UNAVAILABLE');
  assert.equal(result.amounts.state,'VERIFIED');
  assert.equal((await read('2026-11-22')).route.state,'UNAVAILABLE');

  const wrongDayAmounts = createOpsmapDispatchReferenceReader({getPublication:()=>publication,readAmounts:()=>amounts('2026-11-22'),
    readPostcodes:()=>{throw Error('postal access unavailable');}});
  const split = await wrongDayAmounts(date);
  assert.equal(split.route.state,'VERIFIED');
  assert(split.route.rows.every(row=>row.postalCode===null));
  assert.equal(split.amounts.state,'UNAVAILABLE');
  assert.equal(split.amounts.date,date);
});

test('published historical observations remain partial and include only positively observed Osan vehicles',async()=>{
  const visits = [['visit-1','S91001','101','osan',address],['visit-2','S91005','301','yeongnam',address]];
  let archived = {date,visits};
  const read = createOpsmapDispatchReferenceReader({getPublication:()=>({...publication,readDay:async()=>archived}),readAmounts:amounts});
  const result = await read(date);
  assert.equal(result.route.state,'PARTIAL');
  assert.equal(result.route.unassigned,null);
  assert.equal(result.route.rows.length,1);
  assert.equal(result.route.rows[0].coordinateVerified,true);
  const period=await read.period(date,7);
  const summary=summarizeDispatchPeriod(period,new Set(['101','301']),'completed');
  assert.deepEqual(summary.verified,[]);
  assert.deepEqual(summary.completed,[]);
  assert.deepEqual(summary.partialCompleted,[date]);
  assert.equal(summary.vehicles.get('101').stops,1);
  assert.equal(summary.vehicles.has('301'),false);
  assert.equal(period.dates.at(-1).routes,undefined);
  archived = {...archived,planningOnly:true};
  assert.equal((await read(date)).route.state,'UNAVAILABLE');
});

test('a cold-storage-only archive cannot prove an Osan main-center delivery',async()=>{
  const visited=['id-cold','S91001','101','osan',address];
  const archive={date,visits:[visited],tasks:[[...visited,'COMPLETED']],
    dispatch:{sources:[['2',1,1,0]],events:[event('2')]}};
  const read=createOpsmapDispatchReferenceReader({getPublication:()=>({...publication,readDay:async()=>archive})});
  assert.equal((await read(date)).route.state,'UNAVAILABLE');
  const period=await read.period(date,7);
  assert.equal(period.dates.at(-1).state,'UNAVAILABLE');
  assert.equal(period.dates.at(-1).completed,undefined);
});

test('historical explicit and retained delivery reads keep exact address and route evidence without starting period source reads', async()=>{
  const otherDate='2026-11-18';
  const actualAddress='경기도 오산시 합성로 10';
  const known=new Map([['S91001',{name:'현재 이름',addressHash:coordinateAddressHash(actualAddress),
    hasPoint:true,lat:37.12,lng:127.12}]]);
  const roster={
    date:otherDate,centerScope:'osan',sourceReadState:'STALE_VERIFIED',generatedAt:timestamp,
    sourceObservation:deliverySourceObservation([{deliveryDate:otherDate}],{date:otherDate,pages:1,complete:true,resolveVehicle:()=>true}),
    vehicles:[{vehicle:'177',stops:[{customerCode:'S91001',customerName:'원천 당시 이름',address:actualAddress}]}],
  };
  let retained, sourceReads=0;
  const read=createOpsmapDispatchReferenceReader({getPublication:()=>({...publication,registry:known,dispatchDates:[date]}),
    readAmounts:async()=>null,
    readDated:async day=>{sourceReads++;assert.equal(day,otherDate);return roster;},
    readPostcodes:async()=>new Map([['S91001','06241']]),
    readRetainedDated:day=>day===otherDate?retained:null,retainedDatedDates:()=>retained?[otherDate]:[],
  });
  assert.equal((await read(otherDate)).route.state,'UNAVAILABLE');
  assert.equal(sourceReads,0);
  assert.equal((await read.dated(otherDate)).route.rows[0].vehicle,'177');
  assert.equal(sourceReads,1);
  retained=roster;
  const exact=await read(otherDate);
  assert.equal(exact.route.rows[0].customerName,'원천 당시 이름');
  assert.equal(exact.route.rows[0].postalCode,'06241');
  assert.equal(exact.amounts.state,'UNAVAILABLE');
  assert(!JSON.stringify(exact).includes(actualAddress));
  const period=await read.period(date,7);
  const summary=summarizeDispatchPeriod(period,new Set(['177','101']));
  assert.deepEqual(summary.verified,[otherDate,date]);
  assert.equal(summary.unavailable.length,5);
  assert.equal(summary.vehicles.get('177').trend.length,0);
  assert.equal(sourceReads,1);
});

test('period evidence separates dispatch, completion and an amount-only day without filling gaps', async()=>{
  const amountDay='2026-11-19';
  let sourceReads=0;
  const readAmounts=async requested=>requested===amountDay?await amounts(amountDay):null;
  readAmounts.latest=()=>amounts(amountDay);
  const read=createOpsmapDispatchReferenceReader({getPublication:()=>({...publication,dispatchDates:[date]}),
    readAmounts,readDated:()=>{sourceReads++;},
    readPostcodes:async()=>new Map([['S91001','01234']])});
  const period=await read.period(date,7);
  const result=summarizeDispatchPeriod(period,new Set(['101','108']),'completed');
  assert.deepEqual(result.verified,[date]);
  assert.deepEqual(result.completed,[date]);
  assert.deepEqual(result.wms,[amountDay]);
  assert.deepEqual(result.osanScoped,[date]);
  assert.deepEqual(result.exportScoped,[]);
  assert.equal(result.unavailable.length,6);
  assert.equal(result.areas[0].members.get('101').stops,1);
  assert.deepEqual(result.vehicles.get('101').trend,[[amountDay,12000]]);
  assert.equal(period.dates.find(day=>day.date===amountDay).routes,undefined);
  assert.equal(sourceReads,0);
});

test('the day route requires staff before reads and rechecks staff before sending the projection',async t=>{
  const app = express();
  let current = true, reads = 0;
  mountOpsmapDispatchReference(app,{today:()=>date,
    requireStaff(req,res,next){
      if (!current || req.get('X-Test-Staff')!=='yes') return res.status(401).json({error:'STAFF_LOGIN_REQUIRED'});
      next();
    },
    async read(){
      reads++;
      current = false;
      return {privateTestValue:123};
    }});
  const listener=app.listen(0,'127.0.0.1');
  await once(listener,'listening');
  t.after(()=>new Promise(resolve=>listener.close(resolve)));
  const endpoint='http://127.0.0.1:'+listener.address().port+'/api/map-phase2b/private/dispatch-reference-day';
  assert.equal((await fetch(endpoint+'?date='+date)).status,401);
  const headers={'X-Test-Staff':'yes'};
  for(const query of ['date=2026-02-30','date=2026-11-22','date='+date+'&center=yeongnam','date='+date+'&date='+date]){
    assert.equal((await fetch(endpoint+'?'+query,{headers})).status,400);
  }
  assert.equal(reads,0);
  const revoked = await fetch(endpoint+'?date='+date,{headers});
  assert.equal(revoked.status,401);
  assert.equal(revoked.headers.get('cache-control'),'private, no-store');
  assert.equal(reads,1);
  assert.deepEqual(await revoked.json(),{error:'STAFF_LOGIN_REQUIRED'});
});
