import assert from 'node:assert/strict';
import {test} from 'node:test';
import express from 'express';
import {
  createRecentOperationsReader,mergeRecentOperations,mountRecentOperations,normalizeRecentOperations,openRecentOperations,
  projectRecentOperations,RECENT_OPERATIONS_ROUTE,sealRecentOperations,syncStageRecentOperations
} from '../src/stageRecentOperations.js';

const initialStart='2026-08-20', initialEnd='2026-11-17';
const makeDay=(date,source,coverage,codes=[],centerKey='osan')=>({date,source,centerKey,coverage,
  rows:codes.map(customerCode=>({customerCode,evidence:{
    freshon_orders:'order_confirmed',wms_dispatch:'dispatch_confirmed',delivery_admin:'delivery_completed'
  }[source]}))});
const ledger=(...days)=>normalizeRecentOperations({startDate:initialStart,endDate:initialEnd,days});

test('projects verified positives and distinguishes source observations from complete dates',()=>{
  const result=projectRecentOperations(ledger(
    makeDay('2026-10-03','delivery_admin','partial',['A1','A2']),
    makeDay('2026-10-03','freshon_orders','complete',['A1']),
    makeDay('2026-10-03','wms_dispatch','complete',['A1']),
    makeDay('2026-11-05','freshon_orders','partial',['B1'],'honam'),
    makeDay('2026-11-05','wms_dispatch','complete',[],'yeongnam')
  ));
  assert.equal(result.centers.osan.activeCount,2);
  assert.deepEqual(result.centers.osan.confirmedDays,['2026-10-03']);
  assert.deepEqual(result.centers.yeongnam.confirmedDays,[]);
  assert.deepEqual(result.centers.yeongnam.observedDates,['2026-11-05']);
  assert.deepEqual(result.rows.find(row=>row.customerCode==='B1'),
    {customerCode:'B1',centerKey:'honam',date:'2026-11-05',evidence:'order_confirmed'});
  assert.equal(result.rows.find(row=>row.customerCode==='A1').evidence,'delivery_completed');
  assert.throws(()=>ledger(makeDay(initialEnd,'delivery_admin','complete')),/EVIDENCE_INVALID/);
  assert.throws(()=>ledger(makeDay(initialEnd,'wms_dispatch','partial',['A1','A1'])),/EVIDENCE_INVALID/);
});

test('retains earlier confirmed data on a partial input, expires old dates and separates centers',()=>{
  const base=ledger(makeDay(initialStart,'wms_dispatch','complete',['Z1']),
    makeDay(initialEnd,'freshon_orders','complete',['A1']),makeDay(initialEnd,'delivery_admin','partial',['B1'],'honam'));
  const next=mergeRecentOperations(base,'2026-11-18',[
    makeDay(initialEnd,'freshon_orders','partial',['X1']),
    makeDay('2026-11-18','wms_dispatch','complete',['A1'],'yeongnam')
  ]);
  const result=projectRecentOperations(next);
  assert.equal(result.startDate,'2026-08-21');
  assert.deepEqual(result.rows.map(row=>[row.centerKey,row.customerCode]).sort(),[
    ['honam','B1'],['osan','A1'],['yeongnam','A1']
  ]);
});

test('encrypts evidence, rejects a different key and retains prior memory if publication fails',async()=>{
  const original=ledger(makeDay(initialEnd,'freshon_orders','complete',['A1']));
  const key=Buffer.alloc(32,4);
  const value=await sealRecentOperations(original,key);
  assert.throws(()=>JSON.parse(Buffer.from(value.packed,'base64').toString('utf8')));
  assert.deepEqual(await openRecentOperations(value,key),original);
  await assert.rejects(openRecentOperations(value,Buffer.alloc(32,7)));
  let clock=Date.parse('2026-11-18T10:00:00Z'), count=0;
  const read=createRecentOperationsReader({readSeed:async()=>original,now:()=>clock,store:{
    async read(){ if (count++) throw Error('RECENT_OPERATIONS_STORAGE_SCOPE');return null; }
  }});
  const [first,second]=await Promise.all([read(),read()]);
  assert.equal(first,second);
  clock+=65000;
  assert.equal(await read(),first);
  assert.equal(count,2);
});

test('incremental publication adds only the last closed day, retains on missing input and reads back',async()=>{
  const original=ledger(makeDay(initialStart,'delivery_admin','partial',['A1']));
  const latest=makeDay('2026-11-18','wms_dispatch','complete',['B1'],'yeongnam');
  let current={ledger:null,sha:null}, available=false, writes=0;
  const store={
    read:async()=>current,readDay:async(date)=>{assert.equal(date,latest.date);return available?[latest]:null;},
    async write(next,sha){assert.equal(sha,current.sha);writes++;current={ledger:next,sha:'test'};}
  };
  const opts={store,receipt:{runId:'a'.repeat(64),date:'2026-11-19'},readSeed:async()=>original,
    now:()=>Date.parse('2026-11-19T03:00:00Z')};
  assert.equal((await syncStageRecentOperations(opts)).state,'SOURCE_UNAVAILABLE');
  assert.equal(writes,0);
  available=true;
  assert.equal((await syncStageRecentOperations(opts)).state,'PUBLISHED');
  assert.equal((await syncStageRecentOperations(opts)).state,'VERIFIED_NOOP');
  assert.deepEqual(projectRecentOperations(current.ledger).rows.map(row=>row.customerCode),['B1']);
  assert.equal(writes,1);
});

test('protects positive evidence before reading and again after the asynchronous read',async t=>{
  const app=express();
  let callbacks=0, revoke=false;
  mountRecentOperations(app,{now:()=>Date.parse('2026-11-18T19:00:00Z'),requireStaff(req,res,next){
    if (req.get('Authorization')!=='test-employee' || revoke) return res.sendStatus(401);
    next();
  },async read() {
    callbacks++;
    revoke=callbacks===2;
    return projectRecentOperations(ledger(makeDay(initialEnd,'wms_dispatch','partial',['A1'])));
  }});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>server.close());
  await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port+RECENT_OPERATIONS_ROUTE;
  assert.equal((await fetch(url)).status,401);
  assert.equal(callbacks,0);
  const options={headers:{Authorization:'test-employee'}};
  const allowed=await fetch(url,options);
  assert.equal(allowed.headers.get('cache-control'),'private, no-store');
  const value=await allowed.json();
  assert.equal(value.rows.length,1);
  assert.equal(value.expectedEndDate,'2026-11-18');
  assert.equal((await fetch(url,options)).status,401);
});
