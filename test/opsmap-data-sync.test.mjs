import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createCustomerRegistry, customerRegistryAddressHash} from '../src/customerRegistry.js';
import {reviseFixedCoordinateLedger} from '../src/fixedStoreCoordinates.js';
import {createOpsmapDataSync, startOpsmapDataSync} from '../src/opsmapDataSync.js';
import {archivedOpsmapAssignments, openOpsmapSyncGenerationStore, syncDigest, syncSha256} from '../src/opsmapSyncGeneration.js';
import {openPublicAddressCatalog} from '../src/opsmapPublicAddressCatalog.js';
import {completeFixedCoordinatesFromCatalog} from '../src/fixedCoordinateCompletion.js';
import {searchPreservedRegistry} from '../src/privateCustomerSearch.js';
import {createShadowCoverageStore} from '../src/shadowCoverage/store.js';
import {createManualMapPins} from '../src/opsmap-abc/manualMapPins.js';
import {coordinateAddressHash} from '../src/opsmap-abc/opsmapAutoCoordinates.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {archiveAddressHash} from '../src/stageArchivedDelivery.js';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {createStageAbValidation, STAGE_ADDRESS_BATCH_ROUTE, STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageAbValidation.js';

const day = '2026-11-10', priorDay = '2026-11-07', historical = '2026-07-31';
const now = () => Date.parse(day+'T04:00:00Z');
const address = n => '경기도 오산시 예시로 '+n;
const known = {code:'T99001',name:'기존 매장',address:address(10),center:'osan',registered:true,lat:37.15,lng:127.06,matchHash:archiveAddressHash(address(10))};
const held = {code:'T99002',name:'확인 대기',address:address(20),center:'osan',registered:true,lat:null,lng:null,matchHash:archiveAddressHash(address(20))};
const saved = {code:'T99004',name:'보존 매장',address:address(40),center:'osan',registered:true,lat:37.18,lng:127.09,matchHash:archiveAddressHash(address(40))};
const customerRow = (code,name,basicAddress) => ({customerCode:code,customerName:name,basicAddress,addressHash:customerRegistryAddressHash(basicAddress),
  sourceUpdatedAt:day+'T00:00:00.000Z',lifecycle:'ACTIVE'});
const point = {customerCode:'T99003',addressHash:coordinateAddressHash(address(30)),lat:37.161,lng:127.061,
  coordinateSource:'BUILDING_VERIFIED',coordinateAccuracy:'BUILDING',evidenceSource:'OFFICIAL_ADDRESS_DATA',
  evidenceSha256:'a'.repeat(64),observedAt:'2026-11-07T00:00:00Z',verifiedAt:day+'T00:00:00Z',measurementKind:'BUILDING_LOCATION'};
const envelope = {schema:'opsmap-fixed-store-coordinates-v1',revision:0,records:{}};
const empty = {...envelope,sha256:syncDigest(envelope)};
const env = {RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN};

async function rootFor(t) {
  const root = await fs.mkdtemp(path.join(os.homedir(),'.opsmap-sync-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return root;
}

async function fixtureSeed(root) {
  const directory = path.join(root,'seed');
  const observed = path.join(directory,'observed-days');
  await fs.mkdir(observed,{recursive:true,mode:0o700});
  const catalog = JSON.stringify({stores:[known,held,saved]});
  const source = JSON.stringify({start:'2026-08-10',end:priorDay,observedAt:'2026-11-08T04:00:00Z',
    sourceWrites:0,sources:{current:{stable:true},archive:{stable:true}},days:1,completedUnique:1,stores:{union:3}});
  await fs.writeFile(path.join(directory,'stores.private.json'),catalog);
  await fs.writeFile(path.join(directory,'source-import.safe.json'),source);
  for (const date of [historical,priorDay]) {
    await fs.writeFile(path.join(observed,date+'.json'),JSON.stringify({date,sourceRows:1,unidentified:0,proof:'OBSERVED_ARCHIVE_CURRENT',
      visits:[[syncSha256(date),known.code,'101','osan',known.matchHash]]}));
  }
  return {directory,catalogSha256:syncSha256(catalog),sourceSha256:syncSha256(source)};
}

function task(id,code,n,vehicle) {
  return {id,deliveryDate:day,customer:{erpCode:code},logisticsCenterId:1,location:{address:address(n)},fixedNo:vehicle,status:'COMPLETED'};
}

async function stageHttp(t, directory, expected) {
  let session;
  const password='isolated-coordinate-fixture';
  const app=createStageVerificationApp({env:{...env,OPSMAP_STAGE_SYNC_READ_APPROVED:'1',OPSMAP_STAGE_SYNC_DIR:directory,
    GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:'fixture',OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',
    MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    MAP_STAFF_SESSION_SECRET:randomBytes(32).toString('base64url')},now,
  async readHub(){throw Object.assign(Error('HUB_FORBIDDEN'),{upstreamStatus:403});},
  async fetchImpl(input,options={}) {
    const name=new URL(input).pathname.split('/').at(-1);
    if(name==='freshon-cache')return Response.json({private:true,permissions:{push:true}});
    assert.equal(name,'staff-sessions-v1.json');
    if(options.method==='PUT'){
      session=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));
      return Response.json({});
    }
    if(!session)return new Response(null,{status:404});
    const bytes=Buffer.from(JSON.stringify(session));
    return Response.json({sha:'a'.repeat(40),encoding:'base64',size:bytes.length,content:bytes.toString('base64')});
  }});
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  app.emit('opsmap-stage-listening');
  const base='http://127.0.0.1:'+server.address().port+'/opsmap/api/map-phase2b';
  const denied=await fetch(base+'/preview/snapshot');
  assert.equal(denied.status,401);
  await denied.body.cancel();
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{Origin:STAGE_ORIGIN,'Content-Type':'application/json'},
    body:JSON.stringify({id:'fixture',password})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  await login.body.cancel();
  const get=async suffix=>{
    const response=await fetch(base+suffix,{headers:{cookie,'sec-fetch-site':'same-origin'}});
    assert.equal(response.status,200,suffix);
    return response.json();
  };
  const snapshot=await get('/preview/snapshot');
  assert.equal(snapshot.meta.sourceGeneration,expected);
  assert.equal(snapshot.data.length,4);
  assert(!snapshot.data.some(row=>row.address||row.customerAddress));
  const area=await fetch(new URL('/opsmap'+STAGE_ADDRESS_BATCH_ROUTE,base),{method:'POST',
    headers:{cookie,Origin:STAGE_ORIGIN,'Content-Type':'application/json'},
    body:JSON.stringify({generation:expected,queries:[point.customerCode]})});
  assert.equal(area.status,200);
  assert.equal((await area.json()).data[0].customer.data[0].lat,point.lat);
  const archive=await get('/preview/assignments?date='+historical);
  assert.equal(archive.meta.date,historical);
  assert.equal(archive.meta.sourceComplete,false);
  for(const days of [30,60,90]){
    const response=await get('/private/shadow-coverage/view?days='+days+'&level=5&box=123,32,132,40');
    assert.equal(response.data.generation,expected);
    assert.equal(response.data.summary.registered,4);
    // Yesterday was observed successfully with zero deliveries; it is not missing.
    assert.equal(response.data.completeness.recordedDays,3);
    assert.equal(response.data.completeness.missingDates.length,days-3);
  }
  const status=await get('/private/stage-sync-evidence');
  assert.equal(status.automaticSyncVerified,false);
  assert.equal(status.scheduled.state,'VERIFIED_SCHEDULED_PROJECTION');
  // This fixture only reads Osan. It cannot advance nationwide success.
  assert.equal(status.scheduled.lastSuccessAt,null);
}

test('new Customer addresses resolve from the public catalog, survive restart, and feed map, area, daily and H3', {timeout:30_000}, async t => {
  const root = await rootFor(t);
  const database = path.join(root,'public.sqlite');
  const python = process.platform==='win32'?'python':'python3';
  const makeArchives = `
from pathlib import Path
import sys, zipfile
root=Path(sys.argv[1])
def postal(number, lot, building):
    fields=['']*26
    for i,value in {1:'경기도',3:'오산시',8:'예시로',10:'0',11:number,12:'0',13:building,
                    17:'테스트동',20:'0',21:lot,23:'0'}.items(): fields[i]=value
    return '|'.join(fields)
first='1'*24+'1'
second='1'*24+'2'
with zipfile.ZipFile(root/'postal.zip','w') as archive:
    archive.writestr('region.txt','건물관리번호\\n'+postal('20','220',first)+'\\n'+postal('30','330',second)+'\\n')
with zipfile.ZipFile(root/'business.zip','w') as archive:
    header='건물관리번호,도로명주소,지번주소,위도,경도,건물명\\n'
    archive.writestr('region.csv',header+first+',경기도 오산시 예시로 20,경기도 오산시 테스트동 220,37.16,127.06,상가\\n'+
        first+',경기도 오산시 예시로 20,경기도 오산시 테스트동 220,37.1602,127.06,상가\\n')
(root/'elevator.csv').write_text('건물명,건물주소,경도,위도\\n,경기도 오산시 예시로 30,127.07,37.17\\n', encoding='utf8')
`;
  const fixture = spawnSync(python,['-X','utf8','-c',makeArchives,root],{encoding:'utf8'});
  assert.equal(fixture.status,0,fixture.stderr);
  const built = spawnSync(python,['-X','utf8','-B','scripts/opsmap-public-address-catalog.py','build',database,
    '--postal',path.join(root,'postal.zip'),'--business',path.join(root,'business.zip'),'--elevator',path.join(root,'elevator.csv'),
    '--business-date','2026-09-30','--elevator-date','2025-12-12'],{encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  const config = {file:database,sha256:syncSha256(await fs.readFile(database))};
  const catalog = await openPublicAddressCatalog(config);
  const directory = path.join(root,'publisher');
  await fs.mkdir(directory,{mode:0o700});
  const seed = await fixtureSeed(root);
  const road = customerRow('T99020','새 매장 A','경기 오산시 예시로 20 (2층 201호)');
  const lot = customerRow('T99021','새 매장 B','경기 오산시 테스트동 220 3층');
  let rows = [road,lot];
  const deliveryId = syncSha256('new-customer-visit');
  const delivery = {date:day,sourceRows:1,unidentified:0,proofHash:syncSha256(day),completeCenters:['osan'],
    visits:[[deliveryId,lot.customerCode,'122','osan',archiveAddressHash(lot.basicAddress)]],
    tasks:[[deliveryId,lot.customerCode,'122','osan',coordinateAddressHash(lot.basicAddress),'COMPLETED']]};
  const options = {directory,seed,now,includeOfficialRegions:false,readLedger:async()=>empty,
    readRegistry:async()=>({complete:true,version:syncDigest(rows),rows}),
    readDay:async date=>date===day?delivery:null,
    completeCoordinates:context=>completeFixedCoordinatesFromCatalog(context,catalog)};
  const worker = await createOpsmapDataSync(options);
  await worker.sync({bootstrap:true});
  const first = await worker.sync();
  const snapshot = await worker.read();
  const pins = [road,lot].map(row=>snapshot.ledger.records[row.customerCode].at(-1).point);
  assert.deepEqual(pins.map(p=>[p.lat,p.lng,p.coordinateAccuracy]),
    [[37.16,127.06,'ADDRESS_APPROXIMATE'],[37.16,127.06,'ADDRESS_APPROXIMATE']]);
  for(const [i,row] of [road,lot].entries()) {
    assert.equal(pins[i].addressHash,coordinateAddressHash(row.basicAddress));
    assert.equal(searchPreservedRegistry(row.customerCode,snapshot.snapshot).data[0].lat,pins[i].lat);
    assert.equal(searchPreservedRegistry(row.basicAddress,snapshot.snapshot).data[0].lat,pins[i].lat);
  }
  assert.equal(archivedOpsmapAssignments(delivery,snapshot).data[0].lat,pins[1].lat);
  const h3 = await createShadowCoverageStore({directory:snapshot.coverage}).readPeriod(90);
  assert.equal(h3.index.sha256,first.generation);
  const cells = h3.catalog.stores.filter(row=>row.code===road.customerCode||row.code===lot.customerCode).map(row=>row.cell);
  assert.equal(cells.length,2);
  assert(cells[0] && cells[0]===cells[1]);
  assert.equal((await (await openOpsmapSyncGenerationStore(directory)).read()).ledger.sha256,snapshot.ledger.sha256);
  rows = [{...road,basicAddress:'경기도 오산시 예시로 30'},lot];
  await worker.sync();
  const moved = (await worker.read()).ledger.records[road.customerCode];
  assert.equal(moved.length,2);
  assert.deepEqual(moved[0].point,pins[0]);
  assert.equal(moved[1].point.coordinateAccuracy,'BUILDING');
  assert.equal(moved[1].point.lat,37.17);
  assert.equal((await worker.sync()).state,'NOOP');
});

test('server timer retries before atomically switching map, fixed coordinates and all coverage windows', {timeout:30_000}, async t => {
  const root=await rootFor(t),directory=path.join(root,'publisher');
  await fs.mkdir(directory,{mode:0o700});
  const seed=await fixtureSeed(root);
  let ledger=empty;
  let reads=0, initialFailure;
  const registryRows=[customerRow(known.code,known.name,address(11)),customerRow(held.code,held.name,held.address),
    customerRow(point.customerCode,'새 매장',address(30))];
  const version=syncDigest({sourceRows:3,lifecycleField:null,rows:registryRows});
  const registry=createCustomerRegistry({now,async readPage(params){
    reads++;
    if(reads===1)throw Error('HUB_FORBIDDEN');
    if(reads===2)initialFailure=await worker.status();
    const noop=params.afterVersion===version;
    return {ok:true,data:{contract:'customer-registry-v1',version,sourceVersion:'b'.repeat(64),sourceVersionKind:'CUSTOMER_METADATA_SHA256',
      fromVersion:noop?version:null,mode:noop?'NOOP':'FULL',rows:noop?[]:registryRows,offset:0,afterCursor:null,nextCursor:null,
      complete:true,total:noop?0:3,sourceCount:3,sourceRows:3,sourceUniqueCodes:3,exclusions:0,conflicts:0,deletionPolicy:'EXPLICIT_ONLY',lifecycleField:null}};
  }});
  let tasks=[task(12,point.customerCode,30,'122'),task(13,held.code,20,'202')];
  const delivery=createStageDatedDeliveryReader({env:{...env,OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'fixture-only'},
    async fetchImpl(url,opts){
      assert.equal(url.origin,'https://delivery-bali.chabyulhwa.com');
      assert.equal(url.searchParams.get('logisticsCenterId'),'1');
      assert.equal(opts.method,'GET');
      const rows=url.searchParams.get('enteringDatedAtBetween').startsWith(day)?tasks:[];
      return Response.json({content:rows,totalElements:rows.length,totalPages:rows.length?1:0});
    }});
  const pinFile=path.join(root,'pin.json');
  const manualOptions={env:{OPSMAP_MANUAL_PIN_STORE_FILE:pinFile,OPSMAP_MANUAL_PIN_WRITES:'1',OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED:'1',
    MAP_STAFF_ID:'fixture',OPSMAP_MANUAL_PIN_WRITER_ID:'fixture'},appRoot:process.cwd(),authorizeWrite:()=>true,now,
    async readCustomer(code){return code===held.code?{customerCode:code,address:held.address}:null;}};
  const manual=createManualMapPins(manualOptions);
  const worker=await createOpsmapDataSync({directory,seed,now,includeOfficialRegions:false,readLedger:async()=>ledger,
    async readRegistry(){await registry.refresh();return registry.read();},readDay:delivery.readObservation,
    readManualPins:()=>createManualMapPins(manualOptions).projection()});
  const before=await worker.sync({bootstrap:true});
  assert.equal(before.lastSuccessAt,null);
  assert.equal(before.metrics[90].located,2);
  const hash=coordinateAddressHash(held.address);
  await manual.mutate(held.code,'save',{expectedRevision:0,requestId:randomUUID(),originalAddressHash:hash,
    latitude:37.17,longitude:127.07,verificationKind:'DIRECT_SITE_MEASUREMENT'},{assertSession:async()=>{}});
  assert.equal((await createManualMapPins(manualOptions).selected(held.code)).revision,1);
  ledger=reviseFixedCoordinateLedger(empty,{expectedRevision:0,rows:[point],updatedAt:day+'T01:00:00Z'});
  assert.throws(()=>reviseFixedCoordinateLedger(ledger,{expectedRevision:1,rows:[{...point,lat:37.162}],updatedAt:day+'T02:00:00Z'}),/LOCKED/);
  const advanced=await new Promise(resolve=>{
    const stop=startOpsmapDataSync(worker,{intervalMs:50,retryMs:10,onResult(value){stop();resolve(value);}});
    t.after(stop);
  });
  assert.equal(initialFailure.error,'HUB_FORBIDDEN');
  assert.equal(initialFailure.generation,before.generation);
  assert.equal(advanced.state,'PUBLISHED');
  assert.equal(advanced.observedToday,true);
  const follower=await openOpsmapSyncGenerationStore(directory);
  const active=await follower.read();
  assert.equal(active.index.sha256,advanced.generation);
  const rows=new Map(active.snapshot.rows.map(row=>[row.customerCode,row]));
  assert.equal(rows.get(point.customerCode).lat,point.lat);
  assert.equal(rows.get(point.customerCode).confirmedVehicle,'122');
  assert.equal(rows.get(held.code).coordinateSource,'MANUAL_PIN');
  assert.equal(rows.get(known.code).lat,null);
  assert.equal(rows.get(known.code).resolutionStatus,'ADDRESS_CHANGED_REVIEW_REQUIRED');
  assert.equal(rows.get(saved.code).lat,saved.lat);
  assert.equal((await follower.readDay(historical)).visits.length,1);
  assert.equal((await worker.sync()).state,'NOOP');
  assert.equal((await follower.read()).state.revision,2);
  await stageHttp(t,directory,advanced.generation);
  const validation=createStageAbValidation({now});
  assert.equal(validation.followScheduled(active,follower.readDay),true);
  tasks=[tasks[0]];
  await assert.rejects(worker.sync(),/DAY_REGRESSION/);
  assert.equal((await follower.read()).index.sha256,advanced.generation);
  tasks.push(task(13,held.code,20,'203'));
  await manual.mutate(held.code,'revert',{expectedRevision:1,targetRevision:0,requestId:randomUUID(),originalAddressHash:hash},{assertSession:async()=>{}});
  const afterReopen=await createManualMapPins(manualOptions).selected(held.code);
  assert.equal(afterReopen.revision,2);
  assert.equal(afterReopen.current,null);
  const reverted=await worker.sync();
  assert.notEqual(reverted.generation,advanced.generation);
  const latest=await follower.read();
  assert.equal(latest.snapshot.rows.find(row=>row.customerCode===held.code).lat,null);
  assert.equal(latest.snapshot.rows.find(row=>row.customerCode===held.code).confirmedVehicle,'203');
  assert.equal(validation.followScheduled(latest,follower.readDay),true);
  await fs.writeFile(path.join(latest.coverage,'coverage-index.json'),'{}');
  assert.equal((await (await openOpsmapSyncGenerationStore(directory)).read()).index.sha256,advanced.generation);
});

test('scheduled Delivery reads preserve verified center scope and reject a wrong-center response', async () => {
  const used=[];
  let wrongCenter=false;
  const delivery=createStageDatedDeliveryReader({env:{...env,OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'fixture-only'},
    syncCenters:{osan:'1',yeongnam:'7',honam:'8'},async fetchImpl(url){
      const id=url.searchParams.get('logisticsCenterId');
      used.push(id);
      const item={...task(Number(id),known.code,10,'101'),logisticsCenterId:wrongCenter&&id==='7'?1:Number(id)};
      return Response.json({content:[item],totalElements:1,totalPages:1});
    }});
  const combined=await delivery.readObservation(day);
  assert.deepEqual(used,['1','7','8']);
  assert.deepEqual(combined.visits.map(row=>row[3]).sort(),['honam','osan','yeongnam']);
  assert.deepEqual(combined.completeCenters,['osan','yeongnam','honam']);
  assert.equal((await delivery(day)).vehicles[0].totalStops,1);
  assert.equal(used.at(-1),'1');
  wrongCenter=true;
  await assert.rejects(delivery.readObservation(day),{code:'DELIVERY_SOURCE_SCOPE'});
});

test('Stage uses a verified move and closure even when counts fall, but rejects missing identity evidence', async t => {
  const root=await rootFor(t);
  const directory=path.join(root,'stage-publisher');
  await fs.mkdir(directory,{mode:0o700});
  const seed=await fixtureSeed(root);
  const worker=await createOpsmapDataSync({directory,seed,now,includeOfficialRegions:false,
    readLedger:async()=>empty,readDay:async()=>null,async readRegistry() {
      const rows=[customerRow(known.code,known.name,address(11)),
        {...customerRow(saved.code,saved.name,saved.address),lifecycle:'DELETED'}];
      return {complete:true,version:syncDigest(rows),deletionPolicy:'EXPLICIT_ONLY',lifecycleField:'status',rows};
    }});
  await worker.sync({bootstrap:true});
  const before=await worker.read();
  const validation=createStageAbValidation({now});
  assert.equal(validation.followScheduled(before,worker.readDay),true);
  await worker.sync();
  const after=await worker.read();
  const unsupported={...after,baseCatalog:{...after.baseCatalog,stores:after.baseCatalog.stores.map(
    ({registryTransition,...row})=>row)}};
  assert.equal(validation.followScheduled(unsupported,worker.readDay),false);
  assert.equal(validation.snapshot().sourceGeneration,before.index.sha256);
  assert.equal(validation.followScheduled(after,worker.readDay),true);
  assert.equal(validation.active().counts.registered,2);
  assert.equal(validation.active().counts.located,0);
  assert.equal(validation.snapshot().rows.find(row=>row.customerCode===known.code).lat,null);
  assert(!validation.snapshot().rows.some(row=>row.customerCode===saved.code));
  assert.equal(validation.followScheduled(before,worker.readDay),false);
});
