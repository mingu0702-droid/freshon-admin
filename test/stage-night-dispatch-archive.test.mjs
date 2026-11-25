import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {PRIMARY_ORIGIN,PRIMARY_SERVICE} from '../src/stageScope.js';
import {collectStageNightDispatch,createStageNightDispatchArchive,nightDispatchOperations} from '../src/stageNightDispatchArchive.js';
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
   readNightDispatch:async day=>{assert.equal(day,date);return ops;},
   readLatestDay:async ()=>{assert.equal(writes,1);throw Error('DELIVERY_UNAVAILABLE');}}),/DELIVERY_UNAVAILABLE/);
 assert.equal(ledger.startDate,'2026-08-29');
 assert.equal(ledger.endDate,date);
 assert.ok(ledger.days.some(d=>d.source==='delivery_admin'));
 assert.ok(ledger.days.some(d=>d.centerKey==='yeongnam'&&d.coverage==='complete'&&d.rows.length===0));
 assert.equal(projectRecentOperations(ledger,{days:90,summaryOnly:true}).centers.osan.calendar.at(-1).sources.wms_dispatch.customerCount,1);
 assert.deepEqual(await syncStageRecentOperations({store,now,receipt:{date:'2026-11-27',runId:hash},readNightDispatch:async()=>ops}),
   {state:'VERIFIED_NOOP',endDate:date});
 assert.equal(writes,1);
});

