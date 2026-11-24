import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createHmac} from 'node:crypto';
import express from 'express';
import {opsmapArchiveSite,opsmapArchiveWriteApproved,PRIMARY_ORIGIN,PRIMARY_SERVICE,STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
import {createSnapshotTransfer,sendSnapshotTransfer} from '../src/opsmapTransferVersion.js';
import {createFixedVehicleCache} from '../src/opsmap-abc/fixedVehicleCache.js';
import {fixedEnvelope} from '../src/fixedVehicleStore.js';
import {opsmapScheduleConfig,verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
import {createPrimaryOperationalMap,primaryMapDispatch,primaryOperationalEnv} from '../src/productionOpsmapPromotion.js';
import {stageFixedMasterStorage} from '../src/stageFixedMasterSync.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const stage={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN};
const proof={schema:1,destination:PRIMARY_ORIGIN,operationsArchive:'1'.repeat(40),wmsArchive:'2'.repeat(40),
  legacySnapshotArchive:'3'.repeat(40),legacyAuthArchive:'4'.repeat(40),
  legacyPinsArchive:'5'.repeat(40),stagePinsArchive:'6'.repeat(40),
  legacyRegistryChecked:1,legacyFixedChecked:1,legacyRegistryVerified:true,
  legacyRegistryUnconfirmed:0,legacyFixedUnconfirmed:0,stagePinsUnconfirmed:0};
function approved(overrides={}){
  const raw=JSON.stringify({...proof,...overrides});
  return {RENDER_SERVICE_ID:PRIMARY_SERVICE,RENDER_EXTERNAL_URL:PRIMARY_ORIGIN,
    OPSMAP_PRIMARY_CUTOVER_APPROVED:'1',OPSMAP_PRIMARY_ARCHIVE_READ_APPROVED:'1',
    OPSMAP_PRIMARY_PRESERVATION_JSON:raw,OPSMAP_PRIMARY_PRESERVATION_SHA256:sha(raw),
    OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN:'fixture-reader',
    OPSMAP_AUTH_ORIGIN:PRIMARY_ORIGIN,OPSMAP_AUTH_ID:'fixture',OPSMAP_AUTH_PASSWORD_HASH:'fixture-hash',
    OPSMAP_AUTH_STORE_TOKEN:'production-auth-only',OPSMAP_AUTH_SESSION_SECRET:'production-session-only'};
}

test('the promotion fails closed with a wrong host, unread old rows, or missing owner approval',()=>{
  const env=approved();
  assert.equal(opsmapArchiveSite(stage),'stage');
  assert.equal(opsmapArchiveSite({...env,RENDER_EXTERNAL_URL:STAGE_ORIGIN}),null);
  assert.equal(opsmapArchiveSite({...env,OPSMAP_PRIMARY_PRESERVATION_SHA256:'0'.repeat(64)}),null);
  assert.equal(opsmapArchiveSite(approved({legacyRegistryUnconfirmed:1})),null);
  assert.equal(opsmapArchiveSite(approved({legacyRegistryVerified:false})),null);
  assert.equal(opsmapArchiveSite(approved({stagePinsUnconfirmed:1})),null);
  const copy=primaryOperationalEnv({...env,OPSMAP_STAGE_SYNC_WRITE_TOKEN:'old-stage-writer'});
  assert.equal(copy.GITHUB_TOKEN,'production-auth-only');
  assert.equal(copy.OPSMAP_STAGE_SYNC_READ_TOKEN,'fixture-reader');
  assert.equal(copy.OPSMAP_STAGE_SYNC_WRITE_TOKEN,undefined);
  assert.equal(opsmapArchiveWriteApproved(copy),false);
  assert.throws(()=>stageFixedMasterStorage({env:copy,write:true}),/FIXED_STORE_STAGE_APPROVAL/);
  assert.throws(()=>primaryOperationalEnv({...env,OPSMAP_AUTH_ORIGIN:STAGE_ORIGIN}),/OPSMAP_PRIMARY_AUTH_REQUIRED/);
});

test('primary startup refuses to replace the legacy map without preserved archive settings',async()=>{
  let outbound=0;
  const fetchImpl=async()=>{outbound++;throw Error('unexpected outbound request');};
  assert.equal(await createPrimaryOperationalMap({env:approved({legacyRegistryUnconfirmed:1}),fetchImpl}),null);
  await assert.rejects(createPrimaryOperationalMap({env:approved(),fetchImpl}),/OPSMAP_PRIMARY_ARCHIVE_KEY_OR_BASELINE/);
  assert.equal(outbound,0);
});

test('a receipt signed for the primary owner cannot authorize the Stage clock or cross audiences',()=>{
  const env=approved();
  env.OPSMAP_PRIMARY_CLOCK_SECRET='fixture-primary-clock-only'.repeat(3);
  env.OPSMAP_PRIMARY_CLOCK_TRIGGER_ID='12345';
  env.OPSMAP_PRIMARY_CLOCK_EXECUTOR_SHA256=sha('fixture-clock-account');
  const now=Date.parse('2026-11-30T21:25:00Z');
  const cfg={...opsmapScheduleConfig(env),now:()=>now};
  const origin='APPS_SCRIPT_TIME_TRIGGER',version=2,triggerId=cfg.scheduleId,principal=cfg.executorHash;
  const audience=PRIMARY_ORIGIN,date='2026-12-01',slot=Math.floor(now/3600000),issuedAt=new Date(now).toISOString();
  const runId=sha(JSON.stringify([version,origin,triggerId,principal,slot,audience]));
  const signature=createHmac('sha256',cfg.secret).update(JSON.stringify([version,origin,triggerId,principal,issuedAt,slot,date,runId,audience])).digest('hex');
  const receipt={version,origin,triggerId,principal,issuedAt,slot,date,runId,audience,signature};
  assert.equal(verifyOpsmapScheduleReceipt(receipt,cfg).audience,audience);
  assert.throws(()=>verifyOpsmapScheduleReceipt(receipt,{...cfg,audience:STAGE_ORIGIN}),/OPSMAP_SCHEDULE_RECEIPT/);
  assert.throws(()=>verifyOpsmapScheduleReceipt(receipt,{...cfg,audience:undefined}),/OPSMAP_SCHEDULE_RECEIPT/);
});

test('same installed data sends only metadata after authentication and resends when data changes',async()=>{
  const app=express(), snapshots=createSnapshotTransfer(), meta={version:'fixture'};
  let rows=[{customerCode:'S10001'}];
  app.get('/snapshot',(req,res)=>{
    if(req.get('authorization')!=='fixture')return res.sendStatus(401);
    return sendSnapshotTransfer(req,res,snapshots(rows,meta),meta);
  });
  const server=app.listen(0,'127.0.0.1');
  try{
    if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/snapshot';
    const first=await fetch(url,{headers:{authorization:'fixture'}});
    assert.deepEqual((await first.json()).data,rows);
    const version=first.headers.get('x-opsmap-transfer-version');
    assert.match(version,/^[a-f0-9]{64}$/);
    const request=authorization=>fetch(url,{headers:{authorization,'x-opsmap-known-snapshot':version}});
    assert.equal((await request('invalid')).status,401);
    const same=await request('fixture');
    assert.deepEqual(await same.json(),{ok:true,notModified:true,meta});
    assert.equal(same.headers.get('cache-control'),'private, no-store');
    rows=[{customerCode:'S10002'}];
    assert.deepEqual((await (await request('fixture')).json()).data,rows);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('a cached fixed-master version is scoped to precisely the previously received customers',async()=>{
  const checkedAt='2026-11-24T16:00:00.000Z';
  const envelope=fixedEnvelope([{customerCode:'S10001',baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER'}],checkedAt);
  const cache=createFixedVehicleCache({readOnly:true,now:()=>Date.parse(checkedAt),store:{load:async()=>envelope}});
  const first=await cache.get(['S10001']);
  assert.match(first.transferVersion,/^[a-f0-9]{64}$/);
  assert.equal((await cache.get(['S10001'],{knownVersion:first.transferVersion})).notModified,true);
  assert.equal((await cache.get(['S10002'],{knownVersion:first.transferVersion})).data[0].customerCode,'S10002');
});

test('promotion dispatch preserves legacy pin and photo operations and unrelated endpoints',()=>{
  const forwarded=[],passed=[];
  const middleware=primaryMapDispatch(req=>forwarded.push(req.url));
  for(const path of ['/opsmap/','/opsmap/api/map-phase2b/preview/snapshot','/internal/opsmap/scheduled-sync',
    '/api/map-phase2b/private/manual-pins','/opsmap/api/map-phase2b/private/delivery-photos/discover','/api/uploads']){
    const request={path,url:path};
    middleware(request,{},()=>passed.push(request.url));
  }
  assert.deepEqual(forwarded,['/opsmap/','/api/map-phase2b/preview/snapshot','/internal/opsmap/scheduled-sync']);
  assert.deepEqual(passed,['/opsmap/api/map-phase2b/private/manual-pins','/opsmap/api/map-phase2b/private/delivery-photos/discover','/api/uploads']);
});
