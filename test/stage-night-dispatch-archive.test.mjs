import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {PRIMARY_ORIGIN,PRIMARY_SERVICE} from '../src/stageScope.js';
import {collectStageNightDispatch,collectStageNightDispatchRun,createStageNightDispatchArchive,
  nightDispatchOperations} from '../src/stageNightDispatchArchive.js';
import {syncStageRecentOperations,projectRecentOperations} from '../src/stageRecentOperations.js';

const date='2026-11-26',now=()=>Date.parse('2026-11-26T21:05:00Z');
const hash='a'.repeat(64),signedSha='b'.repeat(40);
const result=(centerKey,rows,dateOverride=date)=>({date:dateOverride,centerKey,
  observedAt:'2026-11-26T21:05:00.000Z',sourceSha256:hash,state:rows.length?'VERIFIED':'ZERO_VERIFIED',detail:rows.length,rows});
const row=(customerCode,vehicles)=>({customerCode,vehicles});
const centerResult=result('osan',[row('S100',['101','102']),row('S200',['미배정'])]);

function primaryEnv(){
  const preservation=JSON.stringify({schema:1,destination:PRIMARY_ORIGIN,operationsArchive:signedSha,wmsArchive:signedSha,
    legacySnapshotArchive:signedSha,legacyAuthArchive:signedSha,legacyPinsArchive:signedSha,stagePinsArchive:signedSha,
    legacyRegistryVerified:true,legacyRegistryUnconfirmed:0,legacyFixedUnconfirmed:0,stagePinsUnconfirmed:0,
    legacyRegistryChecked:17186,legacyFixedChecked:17500});
  return {RENDER_SERVICE_ID:PRIMARY_SERVICE,RENDER_EXTERNAL_URL:PRIMARY_ORIGIN,
    OPSMAP_PRIMARY_CUTOVER_APPROVED:'1',OPSMAP_PRIMARY_ARCHIVE_READ_APPROVED:'1',OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN:'read-archive',
    OPSMAP_PRIMARY_SYNC_OWNER:'1',OPSMAP_PRIMARY_ARCHIVE_WRITE_APPROVED:'1',OPSMAP_PRIMARY_ARCHIVE_WRITE_TOKEN:'write-archive',
    OPSMAP_PRIMARY_PRESERVATION_JSON:preservation,OPSMAP_PRIMARY_PRESERVATION_SHA256:createHash('sha256').update(preservation).digest('hex'),
    OPSMAP_STAGE_RECENT_OPERATIONS_SYNC_APPROVED:'1',OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:Buffer.alloc(32,1).toString('base64')};
}

test('daily private archive encrypts assignments, keeps previous center scopes and independently re-reads',async()=>{
  let saved,blobSha,writes=0;
  const archive=createStageNightDispatchArchive({env:primaryEnv(),now,write:true,fetchImpl:async(input,opts)=>{
    const url=new URL(input);
    if(url.pathname==='/repos/mingu0702-droid/freshon-cache')return Response.json({private:true});
    assert.match(url.pathname,/\/recent-operations-v1\/night-dispatch-2026-11-26\.json$/);
    if(opts.method==='PUT'){
      assert.equal(opts.headers.Authorization,'Bearer write-archive');
      const put=JSON.parse(opts.body);
      assert.equal(put.branch,'stage/opsmap-snapshots');
      assert.equal(put.sha,blobSha);
      const envelope=Buffer.from(put.content,'base64').toString('utf8');
      assert.doesNotMatch(envelope,/S100|S200|osan|미배정/);
      saved=JSON.parse(envelope);
      blobSha=createHash('sha1').update(envelope).digest('hex');
      writes++;
      return Response.json({ok:true});
    }
    assert.equal(opts.headers.Authorization,'Bearer read-archive');
    if(!saved)return new Response(null,{status:404});
    if(opts.headers.Accept==='application/vnd.github.raw+json')return Response.json(saved);
    return Response.json({sha:blobSha,content:Buffer.from(JSON.stringify(saved)).toString('base64')});
  }});
  assert.deepEqual(await archive.readDay(date),[]);
  const first=await archive.saveDay(date,[centerResult]);
  assert.deepEqual(first[0].rows,[['S100',['101','102']],['S200',['미배정']]]);
  const combined=await archive.saveDay(date,[result('osan',[row('S600',['112'])]),result('yeongnam',[])]);
  assert.equal(writes,2);
  assert.deepEqual(combined[0].rows,first[0].rows);
  assert.equal(combined.find(scope=>scope.centerKey==='yeongnam').state,'ZERO_VERIFIED');
  assert.deepEqual(await archive.readDay(date),combined);
  assert.deepEqual(await archive.saveDay(date,[centerResult]),combined);
  assert.equal(writes,2);
  await assert.rejects(()=>archive.saveDay('2026-11-25',[centerResult]),/ARCHIVE_SCOPE/);
  await assert.rejects(()=>archive.readDay('2026-11-27'),/ARCHIVE_SCOPE/);
  saved.packed=saved.packed.slice(3);
  await assert.rejects(()=>archive.readDay(date),/ARCHIVE_INVALID/);
  assert.equal(createStageNightDispatchArchive({env:{...primaryEnv(),OPSMAP_PRIMARY_SYNC_OWNER:'0'},write:true,now}),null);
});

test('the private retry checkpoint is conditionally written and independently validated',async()=>{
  let stored=null,sha;
  const archive=createStageNightDispatchArchive({env:primaryEnv(),now,write:true,fetchImpl:async(input,opts)=>{
    const url=new URL(input);
    if(url.pathname==='/repos/mingu0702-droid/freshon-cache')return Response.json({private:true});
    assert.match(url.pathname,/\/recent-operations-v1\/night-dispatch-checkpoint\.json$/);
    if(opts.method==='PUT'){
      assert.equal(opts.headers.Authorization,'Bearer write-archive');
      const put=JSON.parse(opts.body);
      assert.equal(put.sha,sha);
      const bytes=Buffer.from(put.content,'base64');
      stored=JSON.parse(bytes);
      sha=createHash('sha1').update(bytes).digest('hex');
      return Response.json({});
    }
    assert.equal(opts.headers.Authorization,'Bearer read-archive');
    if(!stored)return new Response(null,{status:404});
    if(opts.headers.Accept==='application/vnd.github.raw+json')return Response.json(stored);
    return Response.json({sha,content:Buffer.from(JSON.stringify(stored)).toString('base64')});
  }});
  const pending=[{date,centerKey:'yeongnam',attemptedOn:date}];
  assert.deepEqual(await archive.readCheckpoint(),{sha:null,checkpoint:null});
  await archive.saveCheckpoint(date,pending,null);
  assert.deepEqual(await archive.readCheckpoint(),{sha,checkpoint:{version:1,through:date,pending}});
  await archive.saveCheckpoint(date,[],sha);
  await assert.rejects(()=>archive.saveCheckpoint(date,[{...pending[0],date:'2026-11-25'}],sha),/CHECKPOINT_INVALID/);
  stored.through='2026-11-27';
  await assert.rejects(()=>archive.readCheckpoint(),/ARCHIVE_SCOPE/);
});

test('covered 90-day dates are skipped and an interrupted date only recollects missing centers',async()=>{
  const existing={...centerResult,rows:centerResult.rows.map(({customerCode,vehicles})=>[customerCode,vehicles])};
  const requested=[],historyReads=[];
  const archive={
    readDay:async day=>{historyReads.push(day);return day===date?[existing]:[];},
    saveDay:async (day,scopes)=>{assert.equal(day,date);return [existing,...scopes];}
  };
  const read=async (day,center)=>{requested.push([day,center]);return center==='honam'?null:result(center,[row('S300',['301'])]);};
  assert.deepEqual(await collectStageNightDispatch({date:'2026-11-25',archive,read}),[]);
  assert.deepEqual(historyReads,[]);
  const reports=[];
  const next=await collectStageNightDispatch({date,archive,read,onCenter:r=>reports.push(r)});
  assert.deepEqual(requested,[[date,'yeongnam'],[date,'honam']]);
  assert.deepEqual(historyReads,[date]);
  assert.deepEqual(nightDispatchOperations(next).map(scope=>scope.rows.map(r=>r.customerCode)),[['S100'],['S300']]);
  assert.deepEqual(reports.map(x=>x.state),['SOURCE_UNCONFIRMED','ALREADY_ARCHIVED','VERIFIED']);
});

test('today’s signed run publishes the previous day before any separate delivery provider, and rolls the 90 days',async()=>{
 const old={startDate:'2026-08-28',endDate:'2026-11-25',days:[
   {date:'2026-08-28',centerKey:'osan',source:'wms_dispatch',coverage:'partial',rows:[{customerCode:'S001',evidence:'dispatch_confirmed'}]},
   {date:'2026-11-25',centerKey:'osan',source:'delivery_admin',coverage:'partial',rows:[{customerCode:'S010',evidence:'delivery_completed'}]}
 ]};
 let ledger=old,writes=0;
 const store={read:async()=>({ledger,sha:signedSha}),readDay:async()=>null,
   write:async (next,sha)=>{assert.equal(sha,signedSha);ledger=next;writes++;}};
 const ops=nightDispatchOperations([{...centerResult,rows:[['S100',['101','102']]]},result('yeongnam',[])]);
 await assert.rejects(()=>syncStageRecentOperations({store,now,receipt:{date:'2026-11-27',runId:hash},
   readNightDispatch:async day=>{assert.equal(day,date);return {scopes:ops};},
   readLatestDay:async ()=>{assert.equal(writes,1);throw Error('DELIVERY_UNAVAILABLE');}}),/DELIVERY_UNAVAILABLE/);
 assert.equal(ledger.startDate,'2026-08-29');
 assert.equal(ledger.endDate,date);
 assert.ok(ledger.days.some(d=>d.source==='delivery_admin'));
 assert.ok(ledger.days.some(d=>d.centerKey==='yeongnam'&&d.coverage==='complete'&&d.rows.length===0));
 assert.equal(projectRecentOperations(ledger,{days:90,summaryOnly:true}).centers.osan.calendar.at(-1).sources.wms_dispatch.customerCount,1);
 assert.deepEqual(await syncStageRecentOperations({store,now,receipt:{date:'2026-11-27',runId:hash},
   readNightDispatch:async()=>({scopes:ops})}),
   {state:'VERIFIED_NOOP',endDate:date});
 assert.equal(writes,1);
});

test('the next morning repairs only the missing center, including after an interruption before checkpointing',async()=>{
  for(const interrupted of [false,true]){
    const nextDate='2026-11-27';
    const dayScans=new Map(),requests=[];
    let checkpoint=null;
    const archive={
      readCheckpoint:async()=>({checkpoint,sha:checkpoint?signedSha:null}),
      saveCheckpoint:async(through,pending,sha)=>{
        assert.equal(sha,checkpoint?signedSha:null);
        checkpoint=structuredClone({through,pending});
      },
      readDay:async day=>dayScans.get(day)??[],
      saveDay:async(day,addition)=>{
        const saved=[...dayScans.get(day)??[],...addition];
        dayScans.set(day,saved);
        return saved;
      }
    };
    const read=async (day,center)=>{
      requests.push([day,center]);
      if(requests.length<=3&&center==='yeongnam')throw Error('FRESHON_NIGHT_DISPATCH_TRANSPORT');
      return result(center,[row('S300',['301'])],day);
    };
    const baseline=await collectStageNightDispatchRun({date:'2026-11-25',archive,read});
    assert.equal(baseline.scopes.length,0);
    assert.equal(requests.length,0);
    const first=await collectStageNightDispatchRun({date,archive,read});
    assert.deepEqual(first.scopes.map(scope=>scope.centerKey),['osan','honam']);
    if(!interrupted)await first.saveProgress();
    const second=await collectStageNightDispatchRun({date:nextDate,archive,read});
    assert.deepEqual(requests.slice(3),[
      [nextDate,'osan'],[nextDate,'yeongnam'],[nextDate,'honam'],[date,'yeongnam']
    ]);
    assert.ok(second.scopes.some(scope=>scope.date===date&&scope.centerKey==='yeongnam'));
    // The same receipt can resume without replaying archived centers at the source.
    await second.saveProgress();
    assert.deepEqual(checkpoint,{through:nextDate,pending:[]});
    await collectStageNightDispatchRun({date:nextDate,archive,read});
    assert.equal(requests.length,7);
  }
});

test('recovery defers when the shared request budget is spent and corroboration never touches the sealed baseline',async()=>{
  const recorded=[],attempted=[];
  const nextDate='2026-11-27';
  const checkpoint={through:date,pending:[{date,centerKey:'osan',attemptedOn:date}]};
  let saved;
  const archived={date:nextDate,centerKey:'honam',state:'VERIFIED',observedAt:'2026-11-27T21:05:00.000Z',
    sourceSha256:hash,detail:1,rows:[['S300',['310']]]};
  const archive={readCheckpoint:async()=>({checkpoint,sha:signedSha}),
    readDay:async day=>{recorded.push(day);return day===nextDate?[archived]:[];},
    saveDay:async()=>{throw Error('Unexpected save');},
    saveCheckpoint:async(_through,pending)=>{saved=pending;}};
  const read=async(day,center,{neighbor})=>{
    attempted.push([day,center]);
    assert.equal(await neighbor(),null);
    return null;
  };
  read.hasCapacity=()=>attempted.length<2;
  const run=await collectStageNightDispatchRun({date:nextDate,archive,read});
  await run.saveProgress();
  assert.deepEqual(attempted,[[nextDate,'osan'],[nextDate,'yeongnam']]);
  assert.ok(recorded.every(day=>day>'2026-11-25'));
  assert.ok(saved.some(scope=>scope.date===date&&scope.centerKey==='osan'));
});

test('an older scope merges with previously confirmed evidence before acknowledging progress',async()=>{
  const nextDate='2026-11-27',calls=[];
  let ledger={startDate:'2026-08-29',endDate:date,days:[{
    date,centerKey:'yeongnam',source:'wms_dispatch',coverage:'complete',
    rows:[{customerCode:'S010',evidence:'dispatch_confirmed'}]
  }]};
  const store={read:async()=>{calls.push('read');return {ledger,sha:signedSha};},readDay:async()=>null,
    write:async next=>{calls.push('write');ledger=next;}};
  const options={now:()=>now()+86_400_000,receipt:{date:'2026-11-28',runId:hash},
    readNightDispatch:async()=>({scopes:nightDispatchOperations([result('yeongnam',[['S300',['312']]])]),
      saveProgress:async()=>calls.push('ack')})};
  assert.deepEqual(await syncStageRecentOperations({...options,store:{...store,
    write:async()=>{throw Object.assign(Error(),{code:'FIXED_STORE_CONFLICT'});}}}),{state:'BUSY',endDate:date});
  assert.deepEqual(calls.splice(0),['read']);
  const run=await syncStageRecentOperations({...options,store});
  assert.deepEqual(calls,['read','write','read','ack']);
  assert.equal(ledger.endDate,nextDate);
  assert.deepEqual(ledger.days[0].rows.map(row=>row.customerCode),['S010','S300']);
  assert.equal(run.state,'PUBLISHED');
});

