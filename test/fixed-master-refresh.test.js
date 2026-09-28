import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixedVehicleReader} from '../src/fixedVehicleProjection.js';
const row=(i,total,vehicle='221')=>({estCd:'S'+String(i).padStart(6,'0'),mainCarSeqNm:vehicle,totalCnt:total});
function fixture(read){let calls=0;const reader=createFixedVehicleReader({ensureSession:async()=>{},sleep:async()=>{},extractRows:p=>p.data,readJson:async(_u,o)=>{calls++;const q=new URLSearchParams(o.body);return{data:read(q.get('logCd'),Number(q.get('page')))};}});return{reader,get calls(){return calls;}};}
test('one changing center restarts once; stable new count is accepted, not pinned to old count',async()=>{
 let scan=0;const f=fixture((center,page)=>{if(center!=='011')return[];if(page===0)scan++;
  if(scan===1)return page===0?Array.from({length:1000},(_,i)=>row(i,1001)):[row(1000,1002)];
  return page===0?Array.from({length:1000},(_,i)=>row(i,1002)):[row(1000,1002),row(1001,1002,'')];});
 const result=await f.reader();assert.equal(result.meta.sourceRows,1002);assert.equal(result.data.length,1002);assert.equal(result.data.at(-1).baseVehicleState,'UNASSIGNED');assert.equal(result.meta.centers[0].scan,1);
});
test('persistently changing count is bounded and cannot return a replacement',async()=>{
 const f=fixture((c,p)=>c!=='011'?[]:p===0?Array.from({length:1000},(_,i)=>row(i,1001)):[row(1000,1002)]);
 await assert.rejects(f.reader(),e=>e.code==='FIXED_MASTER_COUNT_CHANGED');assert.equal(f.calls,4);
});
test('same count but changed first page fails bounded end verification',async()=>{
 let first=0;const f=fixture((c,p)=>c!=='011'?[]:p===0?Array.from({length:1000},(_,i)=>row(i,1001,(++first%2000)<1000?'221':'222')):[row(1000,1001)]);
 await assert.rejects(f.reader(),e=>e.code==='FIXED_MASTER_SOURCE_CHANGED');assert.equal(f.calls,6);
});
test('repeated page rejected even if source count could appear complete',async()=>{
 const f=fixture(c=>c!=='011'?[]:Array.from({length:1000},(_,i)=>row(i,2000)));
 await assert.rejects(f.reader(),e=>e.code==='FIXED_MASTER_PAGE_REPEATED');assert.equal(f.calls,2);
});
test('raw count and unique customer count are distinct; cross-center conflict stays explicit',async()=>{
 const f=fixture(c=>c==='013'?[]:[row(1,1,c==='011'?'221':'222')]);const result=await f.reader();
 assert.equal(result.meta.sourceRows,2);assert.equal(result.data.length,1);assert.equal(result.data[0].baseVehicleState,'CONFLICT');
});
