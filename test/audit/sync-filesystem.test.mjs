import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createOpsmapDataSync} from '../../src/opsmapDataSync.js';
import {openOpsmapSyncGenerationStore} from '../../src/opsmapSyncGeneration.js';
import {completeFixedCoordinates} from '../../src/fixedCoordinateCompletion.js';
import {archiveAddressHash} from '../../src/stageArchivedDelivery.js';
import {coordinateAddressHash} from '../../src/opsmap-abc/opsmapAutoCoordinates.js';
import {datesFor, PERIODS} from '../../src/shadowCoverage/coverageFiles.js';
import {hash,now,address,emptyLedger,store,index} from './fixtures.mjs';

// Deterministic publication-contract fixture, NOT an H3 algorithm substitute.
// File CAS, hash validation, private snapshot, ledger and restart code are real.
async function coverageFixture({inputDirectory,outputDirectory}) {
  await fs.mkdir(path.join(outputDirectory,'days'),{recursive:true,mode:0o700});
  const source=JSON.parse(await fs.readFile(path.join(inputDirectory,'source-import.safe.json')));
  const catalog=JSON.parse(await fs.readFile(path.join(inputDirectory,'stores.private.json')));
  const blob=async value=>{const text=JSON.stringify(value),sha256=hash(text);await fs.writeFile(path.join(outputDirectory,sha256+'.json'),text,{mode:0o600});return {sha256,bytes:Buffer.byteLength(text)};};
  const catalogRef=await blob(catalog),windows={};
  for(const days of PERIODS){
    const all=datesFor(source.end,days),observed=[];
    for(const date of all)try{await fs.stat(path.join(inputDirectory,'observed-days',date+'.json'));observed.push(date);}catch{}
    windows[days]=await blob({days,start:all[0],end:source.end,observedDates:{all:observed},rows:[]});
  }
  const body={schema:1,kind:'OBSERVED',asOf:source.end,sourceObservedAt:source.observedAt,generatedAt:new Date(now()).toISOString(),catalog:catalogRef,windows};
  const idx={...body,sha256:hash(body)};
  await fs.writeFile(path.join(outputDirectory,'coverage-index.json'),JSON.stringify(idx),{mode:0o600});
  return {index:idx,metrics:{90:{located:catalog.stores.filter(s=>s.lat!==null).length}}};
}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'opsmap-audit-fs-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const seedDir=path.join(root,'seed'),directory=path.join(root,'published');
  await fs.mkdir(path.join(seedDir,'observed-days'),{recursive:true,mode:0o700});
  await fs.mkdir(directory,{mode:0o700});
  const s=store('T990001',10,{lat:37.15,lng:127.05,matchHash:archiveAddressHash(address(10)),
    originalAddressHash:coordinateAddressHash(address(10)),coordinateSource:'VERIFIED_STORE_POINT'});
  const catalog=JSON.stringify({stores:[s]});
  const facts=JSON.stringify({start:'2026-08-10',end:'2026-11-07',observedAt:'2026-11-08T00:00:00Z',sourceWrites:0,sources:{current:{stable:true},archive:{stable:true}},days:1,completedUnique:1,stores:{union:1}});
  await fs.writeFile(path.join(seedDir,'stores.private.json'),catalog);
  await fs.writeFile(path.join(seedDir,'source-import.safe.json'),facts);
  for(const date of ['2026-07-31','2026-11-07'])await fs.writeFile(path.join(seedDir,'observed-days',date+'.json'),JSON.stringify({date,sourceRows:1,unidentified:0,visits:[[hash(date),'T990001','101','osan',s.matchHash]]}));
  const seed={directory:seedDir,catalogSha256:hash(catalog),sourceSha256:hash(facts)};
  let reg=[s],fail=false;
  const opts={directory,seed,now,readLedger:async()=>emptyLedger(),includeOfficialRegions:false,buildCoverage:coverageFixture,
    readRegistry:async()=>({complete:true,version:hash(reg),rows:reg.map(r=>({customerCode:r.code,customerName:r.name,basicAddress:r.address,lifecycle:'ACTIVE'}))}),
    readDay:async date=>{if(fail)throw Error('HUB_FORBIDDEN');return {date,proof:'VERIFIED_COMPLETE_DAY',proofHash:hash(date),sourceRows:0,unidentified:0,completeCenters:['osan','yeongnam','honam'],visits:[],tasks:[]};},
    completeCoordinates:ctx=>completeFixedCoordinates({...ctx,index:index([[address(20),37.16,127.06],[address(30),37.17,127.07]])})};
  return {directory,opts,setRegistry:r=>reg=r,setFailure:v=>fail=v,s};
}
test('new Customer becomes durable coordinate automatically; two fresh processes restore it; older-than-90-days survives',async t=>{
 const f=await fixture(t),worker=await createOpsmapDataSync(f.opts);
 await worker.sync({bootstrap:true});
 f.setRegistry([f.s,store('T990002',20)]);
 const published=await worker.sync();
 assert.equal(published.state,'PUBLISHED');assert.equal(published.sourceReadComplete,true);
 const active=await worker.read();
 assert.equal(active.ledger.records.T990002.at(-1).point.addressHash,coordinateAddressHash(address(20)));
 assert.equal(active.snapshot.rows.find(r=>r.customerCode==='T990002').lat,37.16);
 assert.equal((await worker.readDay('2026-07-31')).visits.length,1);
 const moduleUrl=new URL('../../src/opsmapSyncGeneration.js',import.meta.url).href;
 for(let i=0;i<2;i++){
  const script=`const {openOpsmapSyncGenerationStore}=await import(${JSON.stringify(moduleUrl)});const s=await openOpsmapSyncGenerationStore(${JSON.stringify(f.directory)});const g=await s.read();console.log(JSON.stringify({lat:g.snapshot.rows.find(r=>r.customerCode==='T990002').lat,revision:g.ledger.revision,archive:(await s.readDay('2026-07-31')).visits.length}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{lat:37.16,revision:1,archive:1});
 }
 const restarted=await createOpsmapDataSync(f.opts);
 assert.equal((await restarted.sync()).state,'NOOP');
 assert.equal((await restarted.read()).ledger.records.T990002.length,1);
 f.setFailure(true);await assert.rejects(restarted.sync(),/HUB_FORBIDDEN/);
 assert.equal((await restarted.read()).index.sha256,active.index.sha256);
 assert.equal((await restarted.status()).lastSuccessAt,published.lastSuccessAt);
});
test('changed Customer address replaces only its address-bound point, keeps history, and republishes atomically',async t=>{
 const f=await fixture(t),worker=await createOpsmapDataSync(f.opts);await worker.sync({bootstrap:true});
 f.setRegistry([f.s,store('T990002',20)]);await worker.sync();
 f.setRegistry([store(f.s.code,30),store('T990002',30)]);await worker.sync();
 const g=await worker.read();assert.equal(g.ledger.records.T990002.length,2);
 assert.equal(g.ledger.records.T990002[0].point.lat,37.16);
 assert.equal(g.snapshot.rows.find(r=>r.customerCode==='T990002').lat,37.17);
 assert.equal(g.snapshot.rows.find(r=>r.customerCode===f.s.code).lat,37.17);
 assert.equal(g.ledger.records.T990002.at(-1).point.addressHash,coordinateAddressHash(address(30)));
});
