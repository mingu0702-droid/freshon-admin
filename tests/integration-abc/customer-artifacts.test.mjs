import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {buildCustomerPrivateRecords,createCustomerPrivateArtifactStore,createCustomerPrivateRefreshWorker,bindPreparedCustomerPrivateReads} from '../../src/customerPrivatePreparation.js';
import {validatePreparedDetail} from '../../src/preparedCustomerDetails.js';
import {createRoadRouteService} from '../../src/roadRouteService.js';
import {hubHarness} from '../repair5/hub-harness.mjs';
const date='2026-10-31T00:00:00.000Z',updated='2026-10-30T00:00:00.000Z';
const row=(more={})=>({customerCode:'S970001',customerName:'SYNTHETIC_ONLY',address:'서울특별시 합성로 10',password:'FAKE_ONLY_9876',securityKey:true,generalKey:false,updatedAt:updated,...more});
const build=(rows,previous={},sourceVersion='1')=>buildCustomerPrivateRecords({rows,previous,sourceVersion,observedAt:date});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'opsmap-abc-private-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const key=crypto.randomBytes(32).toString('base64');const store=await createCustomerPrivateArtifactStore({directory:dir,appRoot:process.cwd(),key});let marker={version:'1'};const commit=async(data)=>store.commit({...data,sourceVersion:marker.version,sourceMarker:{...marker},confirmSource:async()=>({...marker})});return {dir,key,store,commit,setVersion:v=>marker={version:v}};}
test('actual B worker coalesces automatic/manual requests into one snapshot read',async t=>{
 const h=await fixture(t);let reads=0;const worker=createCustomerPrivateRefreshWorker({store:h.store,readSnapshot:async()=>{reads++;await new Promise(r=>setTimeout(r,5));return {rows:[row()],sourceMarker:{version:'1'},observedAt:date};},confirmSource:async()=>({version:'1'})});
 const a=worker.automatic(),b=worker.manual();assert.equal(a,b);const v=await a;assert.equal(reads,1);assert.equal(v.phase,'DONE');assert.equal((await worker.manual()).phase,'NOOP');
});
test('encrypted preparation remains readable after reopening and retains old manifest',async t=>{
 const h=await fixture(t),b=build([row()]);await h.commit(b);h.setVersion('2');await h.commit(build([row({password:'FAKE_ONLY_NEW',updatedAt:'2026-10-30T12:00:00Z'})],await h.store.loadRecords(),'2'));
 const reopened=await createCustomerPrivateArtifactStore({directory:h.dir,appRoot:process.cwd(),key:h.key});const result=await reopened.read('S970001');assert.equal(result.data.password,'FAKE_ONLY_NEW');assert.equal((await h.store.status()).previousPreserved,true);assert.equal(result.meta.currentness,'UNCONFIRMED');
 for(const name of await fs.readdir(h.dir)){const text=await fs.readFile(path.join(h.dir,name),'utf8');assert.ok(!text.includes('FAKE_ONLY_9876')&&!text.includes('FAKE_ONLY_NEW'));}
});
test('blank and stale inputs never overwrite a prepared password',()=>{
 const b=build([row()]);const n=build([row({password:'',updatedAt:'2026-10-30T12:00:00Z'}),row({password:'STALE',updatedAt:'2026-10-29T00:00:00Z'})],b.records,'2');assert.equal(n.records.S970001.fields.password.value,'FAKE_ONLY_9876');
});
test('verified newer explicit clear removes only the named field',()=>{
 const b=build([row()]);const n=build([row({password:'',updatedAt:'2026-10-30T12:00:00Z',correctionVerified:true,clearedFields:['password']})],b.records,'2');assert.equal(n.records.S970001.fields.password.value,null);assert.equal(n.records.S970001.fields.securityKey.value,true);
});
test('explicit customer deletion preserves auditable history and suppresses every sensitive field',()=>{
 const b=build([row()]);const n=build([row({deleted:true,correctionVerified:true,updatedAt:'2026-10-30T12:00:00Z'})],b.records,'2');const out=globalThis.OpsmapCustomerDetailContract.project(n.records.S970001);assert.equal(out.data.password,null);assert.equal(out.data.memoState,'DELETED');assert.ok(n.records.S970001.audit.length>=2);
});
test('passwords stay excluded from the store-address projection',async t=>{
 const h=await fixture(t);await h.commit(build([row()]));const p=await h.store.read('S970001',{view:'store',requestedDate:'2026-10-23'});const v=validatePreparedDetail(p,{customerCode:'S970001',view:'store',date:'2026-10-23'});assert.equal(v.value.password,undefined);assert.equal(v.value.securityKey,undefined);assert.equal(v.value.address,'서울특별시 합성로 10');
});
test('source change during preparation preserves the last verified pointer',async t=>{
 const h=await fixture(t);await h.commit(build([row()]));const before=await fs.readFile(path.join(h.dir,'customer-current.json'),'utf8');await assert.rejects(h.store.commit({...build([row()]),sourceVersion:'2',sourceMarker:{version:'2'},confirmSource:async()=>({version:'3'})}),e=>e.code==='CUSTOMER_ARTIFACT_SOURCE_CHANGED');assert.equal(await fs.readFile(path.join(h.dir,'customer-current.json'),'utf8'),before);
});
test('corrupted encrypted bytes fail closed instead of becoming empty successful data',async t=>{
 const h=await fixture(t);await h.commit(build([row()]));const p=JSON.parse(await fs.readFile(path.join(h.dir,'customer-current.json'),'utf8'));await fs.appendFile(path.join(h.dir,p.current.file),' ');await assert.rejects(h.store.read('S970001'),e=>e.code==='CUSTOMER_ARTIFACT_HASH');
});
test('bridge passes unrelated authenticated Hub actions through unchanged',async()=>{
 let args;const bridge=bindPreparedCustomerPrivateReads({store:{read:async()=>({data:{synthetic:true}})},callHub:async(...a)=>(args=a,{kept:true})});assert.deepEqual(await bridge('unrelated',{a:1},{privateRead:true}),{kept:true});assert.equal(args[0],'unrelated');await assert.rejects(bridge('customerDetailPrepared',{customerCode:'S970001',token:'not-a-real-secret'}),e=>e.code==='CUSTOMER_ARTIFACT_PARAMS');
});
test('MASTER-only Hub preparation does not require a public map package',()=>{
 const h=hubHarness();h.props.delete('PRODUCTION_MAP_PACKAGES_V1');h.props.set('OPSMAP_CUSTOMER_DETAILS_SCOPE_MODE','CUSTOMER_MASTER');h.props.set('OPSMAP_CUSTOMER_DETAILS_FOLDER_ID','private-folder');assert.equal(h.run().phase,'DONE');assert.equal(h.read().data.password,'INITIAL');assert.equal(h.metrics.sourceWrites,0);
});
test('road readiness without enabled flag/key/budget makes zero provider calls',async()=>{
 let calls=0;const svc=createRoadRouteService({env:{},requireDurableBudget:true,fetchImpl:async()=>{calls++;throw Error('unexpected');}});const r=await svc.readiness();assert.equal(r.canRequest,false);assert.ok(r.blockedReasons.includes('FEATURE_DISABLED'));assert.ok(r.blockedReasons.includes('KEY_MISSING'));assert.ok(r.blockedReasons.includes('PERSISTENT_BUDGET_REQUIRED'));assert.equal(calls,0);
});
test('readiness inspection never consumes the approved routing budget',async()=>{
 let reserves=0,calls=0;const svc=createRoadRouteService({env:{OPSMAP_ROAD_ROUTE_ENABLED:'1',KAKAO_MOBILITY_REST_API_KEY:'synthetic-only'},requireDurableBudget:true,budget:{durable:true,status:async()=>({durable:true,scope:'CUMULATIVE_APPROVED_ACCOUNT',remaining:2}),reserve:async()=>{reserves++;}},fetchImpl:async()=>{calls++;}});assert.equal((await svc.readiness()).canRequest,true);assert.equal(reserves,0);assert.equal(calls,0);
});
