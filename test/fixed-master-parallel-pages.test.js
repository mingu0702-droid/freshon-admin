// Synthetic numbered pages only. No FreshOn authentication or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixedVehicleReader} from '../src/fixedVehicleProjection.js';
import {createFixedVehicleCache} from '../src/fixedVehicleCache.js';
import {fixedEnvelope} from '../src/fixedVehicleStore.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const row=(i,total,vehicle='221')=>({estCd:'T'+String(i).padStart(6,'0'),mainCarSeqNm:vehicle,totalCnt:total});

function fixture(reply,{pageConcurrency=2,session=async()=>{}}={}){
  let active=0,maxActive=0;const calls=[];
  const reader=createFixedVehicleReader({pageConcurrency,ensureSession:session,sleep:async()=>{},extractRows:p=>p.data,
    readJson:async(url,options)=>{
      assert.equal(url,'/bo/wm/standard/fixedAlctnList');assert.equal(options.method,'POST');assert.equal(options.timeoutMs,60000);
      const query=new URLSearchParams(options.body),center=query.get('logCd'),page=Number(query.get('page'));
      assert.equal(query.get('size'),'1000');assert.equal(query.get('sort'),'est_cd,ASC');assert.equal(query.get('isPaging'),'true');assert.equal(query.get('isCount'),'true');
      assert.deepEqual([...query.keys()].sort(),['page','size','isPaging','isCount','sort','logCd','estCd','estName','estNm','estGbn','startDate','endDate','carCd','carNm','shipGbn','baecha'].sort());
      calls.push([center,page]);active++;maxActive=Math.max(maxActive,active);
      try{return await reply({center,page,active});}finally{active--;}
    }});
  return {reader,calls,get active(){return active;},get maxActive(){return maxActive;}};
}

test('opt-in two-page batches preserve source order, all centers and first-page verification',async()=>{
  const rows=Array.from({length:3001},(_,i)=>row(i,3001));
  const f=fixture(async({center,page})=>{await pause(page===1?4:1);return {data:center==='011'?rows.slice(page*1000,(page+1)*1000):[row(center==='012'?900001:900002,1)]};});
  const result=await f.reader();assert.equal(f.maxActive,2);assert.equal(f.active,0);assert.equal(result.meta.sourceRows,3003);assert.equal(result.data.length,3003);
  assert.deepEqual(f.calls,[['011',0],['011',1],['011',2],['011',3],['011',0],['012',0],['013',0]]);
  assert.deepEqual(result.meta.centers.map(c=>c.center),['011','012','013']);assert.equal(result.meta.pageConcurrency,2);assert.equal(result.meta.snapshotIsolationVerified,false);assert.equal(f.reader.getProgress().complete,true);
});

test('default remains one sequential page and invalid parallelism fails before any read',async()=>{
  const f=fixture(async()=>{await pause(1);return {data:[row(1,1)]};},{pageConcurrency:1});await f.reader();assert.equal(f.maxActive,1);
  for(const pageConcurrency of [0,3,-1,'2',NaN])assert.throws(()=>createFixedVehicleReader({pageConcurrency}),/FIXED_MASTER_CONCURRENCY_INVALID/);
});

test('count drift discards only the failed center batch and stops after one bounded rescan',async()=>{
  let scan=0;const f=fixture(async({center,page})=>{
    assert.equal(center,'011');if(page===0)scan++;await pause(page===2?3:1);
    return {data:Array.from({length:1000},(_,i)=>row(page*1000+i,3000+scan*2+(page?1:0)))};
  });
  await assert.rejects(f.reader(),e=>e.code==='FIXED_MASTER_COUNT_CHANGED');assert.equal(scan,2);assert.equal(f.active,0);assert.equal(f.maxActive,2);
  assert.deepEqual(f.calls,[['011',0],['011',1],['011',2],['011',0],['011',1],['011',2]]);
  assert.equal(f.reader.getProgress().complete,false);assert.equal(f.reader.getProgress().phase,'ERROR');assert.equal(f.reader.getProgress().completedCenters.length,0);
});

test('a successful bounded rescan publishes none of the discarded batch values',async()=>{
  let zeroReads=0;const f=fixture(async({center,page})=>{
    if(center!=='011')return {data:[]};if(page===0)zeroReads++;
    const first=zeroReads===1,total=first&&page===0?3001:3002;
    await pause(page===2?3:1);
    return {data:Array.from({length:3002},(_,i)=>row(i,total,first?'101':'202')).slice(page*1000,(page+1)*1000)};
  });
  const result=await f.reader();assert.equal(result.meta.centers[0].scan,1);assert.equal(result.meta.sourceRows,3002);assert.equal(result.data.length,3002);
  assert(result.data.every(row=>row.baseVehicle==='202'));assert.equal(f.reader.getProgress().complete,true);assert.equal(f.reader.getProgress().failureCode,null);assert.equal(f.active,0);assert.equal(zeroReads,3);
});

test('parallel initial 401 responses share exactly one existing-session recovery',async()=>{
  let initialSessions=0,forcedSessions=0,recovered=false;
  const rows=Array.from({length:2501},(_,i)=>row(i,2501));
  const f=fixture(async({center,page})=>{
    await pause(1);if(center==='011'&&page>0&&!recovered)return {status:401};
    return {data:center==='011'?rows.slice(page*1000,(page+1)*1000):[]};
  },{session:async force=>{if(force){forcedSessions++;await pause(3);recovered=true;}else initialSessions++;}});
  const result=await f.reader();assert.equal(initialSessions,1);assert.equal(forcedSessions,1);assert.equal(result.meta.authRetried,true);assert.equal(result.meta.firstHttp,401);
  assert.equal(result.meta.sourceRows,2501);assert.equal(f.maxActive,2);assert.equal(f.active,0);
});

test('a denied prefetched page is drained without retries, future batches or publication',async()=>{
  const f=fixture(async({center,page})=>{assert.equal(center,'011');await pause(page===2?1:3);if(page===2)throw {status:403};return {data:Array.from({length:1000},(_,i)=>row(page*1000+i,3001))};});
  await assert.rejects(f.reader(),e=>e.code==='FIXED_MASTER_FORBIDDEN');assert.deepEqual(f.calls,[['011',0],['011',1],['011',2]]);assert.equal(f.active,0);assert.equal(f.reader.getProgress().complete,false);
});

test('intentional duplicate customers are counted separately from paging completeness and conflicts',async()=>{
  const rows={'011':[row(1,3,'101'),row(1,3,'101'),row(2,3,'122')],'012':[row(2,2,'202'),row(3,2,'202')],'013':[row(3,1,'202')]};
  const f=fixture(async({center})=>({data:rows[center]}));const result=await f.reader();
  assert.equal(result.meta.sourceRows,6);assert.equal(result.meta.uniqueCustomers,3);assert.equal(result.meta.withinCenterDuplicateRows,1);assert.equal(result.meta.crossCenterDuplicateOccurrences,2);assert.equal(result.meta.conflictingCustomers,2);
  assert.equal(result.meta.centers[0].duplicateCustomerRows,1);assert.equal(result.meta.centers[0].duplicateCustomers,1);assert.equal(result.meta.centers[0].uniqueCustomers,2);
  assert.equal(result.data.find(r=>r.customerCode===row(1).estCd).baseVehicle,'101');assert.equal(f.reader.getProgress().complete,true);
});

test('failed concurrent refresh never saves or swaps the previous verified cache',async()=>{
  const at=Date.now()-3600000;const previous=fixedEnvelope([{customerCode:'T999999',baseVehicle:'122',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER'}],new Date(at).toISOString());let saves=0;
  const f=fixture(async({page})=>{await pause(1);if(page)throw {status:403};return {data:Array.from({length:1000},(_,i)=>row(i,3001))};});
  const store={load:async()=>previous,save:async()=>{saves++;},acquire:async()=>true,renew:async()=>{},release:async()=>{}};
  const cache=createFixedVehicleCache({reader:f.reader,store,ttl:0});await cache.get(['T999999']);await cache.settled();const value=await cache.get(['T999999']);
  assert.equal(saves,0);assert.equal(value.meta.version,previous.version);assert.equal(value.data[0].baseVehicle,'122');assert.equal(value.meta.lastError,'FIXED_MASTER_FORBIDDEN');assert.equal(f.active,0);
});

test('oversized page is rejected before prefetching additional pages',async()=>{
  const f=fixture(async()=>({data:Array.from({length:1001},(_,i)=>row(i,1001))}));
  await assert.rejects(f.reader(),e=>e.code==='FIXED_MASTER_PAGE_SIZE_INVALID');assert.equal(f.calls.length,1);assert.equal(f.reader.getProgress().complete,false);
});
