import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {
  normalizeRecentOperations,projectRecentOperations,recoverVerifiedFreshonDispatch,syncStageRecentOperations
} from '../src/stageRecentOperations.js';

const latest='2026-11-25';
const windowStart='2026-08-28';
const now=()=>Date.parse('2026-11-25T20:00:00Z');
const sha='b'.repeat(40);
const digest=text=>createHash('sha256').update(text).digest('hex');
const dispatchDay=(date,centerKey,coverage,codes)=>({date,centerKey,coverage,source:'wms_dispatch',
  rows:codes.map(customerCode=>({customerCode,evidence:'dispatch_confirmed'}))});
const ledger=(...days)=>normalizeRecentOperations({startDate:windowStart,endDate:latest,days});

function archive(day,center,records,overrides={}) {
  const routes=records.flatMap(([,assigned])=>assigned);
  const unallocated=routes.filter(vehicle=>vehicle==='미배정').length;
  const vehicles=new Set(routes.filter(vehicle=>vehicle!=='미배정')).size;
  const detail=routes.length;
  return {name:day+'-'+center+'.dpapi',bytes:Buffer.from(JSON.stringify({
    day,center,filter:'2',tcFilter:'1',checkedAt:'2026-11-25T19:00:00.000Z',
    digest:digest(day+'|'+center),state:'VERIFIED',detail,physical:detail+vehicles+(unallocated?1:0),
    customers:records.length,confirmed:records.filter(([,rows])=>rows.some(vehicle=>vehicle!=='미배정')).length,
    vehicles,unallocated,records,...overrides
  }))};
}

function memoryStore(saved) {
  let writes=0;
  return {
    read:async()=>({ledger:saved,sha}),
    async write(next,expected) {assert.equal(expected,sha);saved=next;writes++;},
    get writes(){return writes;}
  };
}

test('direct dispatch on three centers uses exactly one approved CAS, retains earlier evidence, and is idempotent',async()=>{
  const retained=dispatchDay(latest,'osan','partial',['A1','A5']);
  const delivery={date:latest,centerKey:'osan',source:'delivery_admin',coverage:'partial',
    rows:[{customerCode:'B1',evidence:'delivery_completed'}]};
  const store=memoryStore(ledger(retained,delivery));
  const archives=[
    archive(latest,'011',[['A1',['101']],['A2',['102','미배정']],['A3',['미배정']]]),
    archive(latest,'012',[['B1',['308']]]),
    archive(latest,'013',[['C1',['501']]])
  ];
  const request={store,archives,now};
  const preview=await recoverVerifiedFreshonDispatch(request);
  assert.equal(preview.state,'VERIFIED_PREVIEW');
  assert.equal(preview.scopes.find(scope=>scope.centerKey==='osan').retainedOutsideInput,1);
  assert.equal(store.writes,0);
  await assert.rejects(recoverVerifiedFreshonDispatch({...request,publish:true}),/RECOVERY_SCOPE/);
  await assert.rejects(recoverVerifiedFreshonDispatch({...request,publish:true,approvedSha256:digest('wrong')}),/APPROVAL_MISMATCH/);
  const published=await recoverVerifiedFreshonDispatch({...request,archives:[...archives].reverse(),
    publish:true,approvedSha256:preview.archiveSha256});
  assert.equal(published.state,'PUBLISHED');
  assert.equal(store.writes,1);
  const saved=(await store.read()).ledger;
  assert.equal(saved.endDate,latest);
  assert.deepEqual(saved.days.find(day=>day.source==='delivery_admin'),delivery);
  assert.deepEqual(saved.days.filter(day=>day.source==='wms_dispatch'),[
    dispatchDay(latest,'honam','partial',['C1']),
    dispatchDay(latest,'osan','partial',['A1','A2','A5']),
    dispatchDay(latest,'yeongnam','partial',['B1'])
  ]);
  assert.equal((await recoverVerifiedFreshonDispatch({...request,publish:true,approvedSha256:preview.archiveSha256})).state,'VERIFIED_NOOP');
  assert.equal(store.writes,1);
  assert.equal(projectRecentOperations(saved,{days:90,summaryOnly:true}).centers.osan.calendar.at(-1).state,'PARTIAL');
});

test('quarantines a complete-scope conflict and malformed source dates while preserving valid dates',async()=>{
  const complete=dispatchDay(latest,'osan','complete',['A1']);
  const store=memoryStore(ledger(complete));
  const request={store,now,archives:[
    archive(latest,'011',[['A2',['101']]]),
    archive(latest,'012',[['A3',['308']]]),
    archive('2026-11-24','013',[['A4',['501']]]),
    archive('2026-11-23','012',[['A5',['308']],['A5',['309']]]),
    archive('2026-11-22','011',[['A6',['미배정']]]),
    archive('2026-11-21','011',[['A7',['101']]],{state:'EMPTY'}),
    archive('2026-11-20','011',[['A8',['101']]],{center:'012'})
  ]};
  const preview=await recoverVerifiedFreshonDispatch(request);
  assert.deepEqual(preview.quarantinedDates.map(row=>row.date),['2026-11-20','2026-11-21','2026-11-23',latest]);
  assert.equal(preview.scopes[0].confirmed,0);
  assert.equal(preview.scopes[0].unallocated,1);
  assert.equal(preview.scopes[0].added,0);
  await recoverVerifiedFreshonDispatch({...request,publish:true,approvedSha256:preview.archiveSha256});
  assert.deepEqual((await store.read()).ledger.days,[dispatchDay('2026-11-24','honam','partial',['A4']),complete]);
});

test('a conflict stays BUSY and a stale readback fails the operation',async()=>{
  const original=ledger();
  const store={read:async()=>({ledger:original,sha})};
  const request={archives:[archive(latest,'011',[['A1',['101']]])],store,now};
  const preview=await recoverVerifiedFreshonDispatch(request);
  const publish={...request,publish:true,approvedSha256:preview.archiveSha256};
  assert.equal((await recoverVerifiedFreshonDispatch({...publish,store:{...store,async write(){
    throw Object.assign(Error('conflict'),{code:'FIXED_STORE_CONFLICT'});
  }}})).state,'BUSY');
  await assert.rejects(recoverVerifiedFreshonDispatch({...publish,store:{...store,async write(){}}}),/STORAGE_READBACK/);
});

test('a complete 90-day file set is capped at 270 exact day-center scopes',async()=>{
  const archives=[];
  for (let offset=0;offset<90;offset++) {
    const date=new Date(Date.parse(windowStart)+offset*86400000).toISOString().slice(0,10);
    for(const center of ['011','012','013']) archives.push(archive(date,center,
      Array.from({length:400},(_,index)=>['A'+String(1000+index),['101']])));
  }
  const args={archives,store:memoryStore(ledger()),now};
  const preview=await recoverVerifiedFreshonDispatch(args);
  assert.equal(preview.inputScopes,270);
  assert.equal(preview.scopes.reduce((count,row)=>count+row.added,0),108000);
  assert.equal(preview.quarantinedDates.length,0);
  await assert.rejects(recoverVerifiedFreshonDispatch({...args,archives:[...archives,archives[0]]}),/RECOVERY_SCOPE/);
});

test('a regional dispatch scope does not block the official Osan snapshot during daily collection',async()=>{
  const regional=dispatchDay(latest,'yeongnam','partial',['A1']);
  const store=memoryStore(ledger(regional));
  let archiveReads=0, dailyReads=0;
  const result=await syncStageRecentOperations({
    store,now,receipt:{date:'2026-11-26',runId:digest('test receipt')},readSource:async()=>null,
    readLatestDispatch:async day=>{
      assert.equal(day,latest);archiveReads++;
      return {date:day,center:'osan',source:'WMS_CONFIRMED_DISPATCH_FRESHON_JSON',
        vehicles:[{vehicle:'101',details:[{customerCode:'A2'}]}]};
    },
    readLatestDay:async()=>{dailyReads++;return []}
  });
  assert.equal(result.state,'PUBLISHED');
  assert.equal(archiveReads,1);
  assert.equal(dailyReads,1);
  assert.deepEqual((await store.read()).ledger.days,[dispatchDay(latest,'osan','partial',['A2']),regional]);
});
