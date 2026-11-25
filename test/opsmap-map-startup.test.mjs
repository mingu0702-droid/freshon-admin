import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {gunzipSync} from 'node:zlib';
import express from 'express';
import {createMapStartupReader,mountMapStartup} from '../src/opsmapMapStartup.js';

const checkedAt='2026-11-25T01:00:00Z';
const sha=value=>createHash('sha256').update(value).digest('hex');
const version=sha('registry');
const fixedVersion=sha('fixed');
const customerCode=index=>'S'+String(100000+index);
const registryRow=index=>{
  const basicAddress=`서울 강남구 합성로 ${index}`;
  return {customerCode:customerCode(index),customerName:`검증용 매장 ${index}`,basicAddress,lifecycle:'ACTIVE',
    addressHash:sha(basicAddress),centerGroup:'osan',sourceUpdatedAt:'',accessMemo:'fixture private value'};
};
const fixedMeta=total=>({basis:'FIXED_DISPATCH_PRIMARY',version:fixedVersion,checkedAt,total,stale:false});
const fixedRow=index=>({customerCode:customerCode(index),baseVehicle:'101',baseVehicleGroup:'osan',
  baseVehicleState:'VERIFIED_MASTER',baseVehicleCheckedAt:checkedAt,baseVehicleVersion:fixedVersion,
  baseVehicleStale:false,baseVehicleSource:'FIXED_DISPATCH_PRIMARY'});
function reader({snapshot,registry,fixed}) {
  return createMapStartupReader({readSnapshot:snapshot,readRegistry:registry,readFixed:fixed,
    snapshotMeta:map=>({sourceGeneration:map.sourceGeneration,latestDate:map.latestDate}),projectSnapshot:map=>map.rows});
}
const base={sourceGeneration:sha('map'),latestDate:'2026-11-07',rows:[{customerCode:customerCode(0),lat:37.5,lng:127}]};

test('a full-size startup response is compressed once, reuses source versions and preserves verified absences',async(t)=>{
  const rows=Array.from({length:17186},(_,index)=>registryRow(index));
  const snapshot={...base,rows:Array.from({length:6043},(_,index)=>({customerCode:customerCode(index),lat:37.5,lng:127,deliveryCount90d:1}))};
  let registry={ref:{version,count:rows.length,checkedAt},rows};
  let transfers=0;
  const fixedTransfer=sha('fixed-transfer');
  const read=reader({snapshot:()=>snapshot,registry:()=>registry,fixed:known=>{
    const meta=fixedMeta(rows.length-1);
    if(known===fixedTransfer)return {ok:true,notModified:true,meta,transferVersion:fixedTransfer};
    transfers++;
    return {ok:true,meta,data:rows.slice(1).map((_,index)=>fixedRow(index+1)),transferVersion:fixedTransfer};
  }});
  const started=performance.now();
  const [first,concurrent]=await Promise.all([read(),read()]);
  const firstMs=Math.round(performance.now()-started);
  assert.equal(concurrent,first);assert.equal(transfers,1);
  assert.ok(first.compressed.length<first.body.length/3);
  assert.ok(gunzipSync(first.compressed).equals(first.body));
  const result=JSON.parse(first.body);
  assert.equal(result.data.registry.rows.length,17186);
  assert.equal(result.data.snapshot.rows.length,6043);
  assert.equal(result.data.fixed.rows.length,17186);
  assert.equal(result.data.fixed.rows[0].baseVehicleState,'NOT_IN_MASTER');
  assert.equal(result.data.registry.rows[0].accessMemo,undefined);
  assert.equal(await read(),first);assert.equal(transfers,1);
  registry={...registry,ref:{...registry.ref,checkedAt:'2026-11-25T03:00:00Z'}};
  assert.notEqual((await read()).version,first.version);
  t.diagnostic(JSON.stringify({firstMs,rawBytes:first.body.length,gzipBytes:first.compressed.length,
    maxRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
});

test('the response is protected before loading, after loading, and when the version matches',async()=>{
  const app=express();let active=true,reads=0,release,recovery='RESTORING';
  const fixture=reader({snapshot:()=>base,registry:()=>({ref:{version,count:1,checkedAt},rows:[registryRow(0)]}),
    fixed:()=>({ok:true,meta:fixedMeta(1),data:[fixedRow(0)],transferVersion:sha('fixed-transfer')})});
  const requireStaff=(req,res,next)=>active&&req.get('authorization')==='fixture'?next():res.sendStatus(401);
  mountMapStartup(app,{requireStaff,recovery:()=>recovery,restoreMs:()=>575,read:async()=>{
    reads++;
    if(reqWait)await new Promise(resolve=>{release=resolve;});
    return recovery==='READY'?fixture():null;
  }});
  let reqWait=false;
  const server=app.listen(0,'127.0.0.1');
  try{
    if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/map-startup';
    assert.equal((await fetch(url)).status,401);
    assert.equal(reads,0);
    const headers={authorization:'fixture','accept-encoding':'gzip'};
    const preparing=await fetch(url,{headers});
    assert.equal(preparing.status,503);
    assert.equal(preparing.headers.get('retry-after'),'2');
    assert.deepEqual(await preparing.json(),{error:'OPSMAP_STARTUP_NOT_READY'});
    recovery='UNAVAILABLE';
    const unavailable=await fetch(url,{headers});
    assert.equal(unavailable.status,503);
    assert.equal(unavailable.headers.get('retry-after'),null);
    assert.deepEqual(await unavailable.json(),{error:'OPSMAP_STARTUP_UNAVAILABLE'});
    recovery='READY';
    const response=await fetch(url,{headers});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-encoding'),'gzip');
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.get('x-opsmap-restore-ms'),'575');
    assert.match(response.headers.get('server-timing'),/^opsmap-startup-prepare;dur=\d+\.\d{2}$/);
    const firstVersion=response.headers.get('x-opsmap-startup-version');
    assert.equal((await response.json()).data.fixed.rows.length,1);
    const same=await fetch(url,{headers:{...headers,'x-opsmap-known-startup':firstVersion}});
    assert.equal((await same.json()).notModified,true);
    reqWait=true;
    const pending=fetch(url,{headers});
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    active=false;release();
    assert.equal((await pending).status,401);
    assert.equal((await fetch(url,{headers:{...headers,'x-opsmap-known-startup':firstVersion}})).status,401);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('a missing current registry or unverified fixed master cannot serve the old base as a ready map',async()=>{
  const read=reader({snapshot:()=>base,registry:()=>null,fixed:()=>{throw Error('must not read fixed');}});
  assert.equal(await read(),null);
  const noMaster=reader({snapshot:()=>base,registry:()=>({ref:{version,count:1,checkedAt},rows:[registryRow(0)]}),
    fixed:()=>({ok:false,meta:{basis:'UNAVAILABLE'}})});
  assert.equal(await noMaster(),null);
});

test('the browser associates a bulk registry atomically, refuses a partial bundle and revokes pending work',async()=>{
  const context={window:{crypto:webcrypto},TextEncoder,AbortController};
  vm.runInNewContext(readFileSync(new URL('../public/opsmap/customer-registry.js',import.meta.url),'utf8'),context);
  const api=context.window.MapCustomerRegistry.create();
  const rows=Array.from({length:1001},(_,index)=>({...registryRow(index),nationalRegistry:true}));
  const full={contract:'customer-registry-v1',version,complete:true,mode:'FULL',deletionPolicy:'EXPLICIT_ONLY',
    total:rows.length,rows};
  await assert.rejects(api.installVerifiedComplete({...full,total:rows.length+1},()=>true),/CUSTOMER_REGISTRY_PAGE_INVALID/);
  assert.equal(api.summary().count,0);
  const request=api.installVerifiedComplete(full,()=>true);
  api.purge();
  await assert.rejects(request,/CUSTOMER_REGISTRY_CANCELLED/);
  assert.equal(api.summary().count,0);
  assert.equal((await api.installVerifiedComplete(full,()=>true)).count,1001);
  assert.equal(api.merge([]).length,1001);
});
