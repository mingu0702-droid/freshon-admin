import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePeriod, checkPeriodPage, groupPeriodRows, createPeriodJobs, readStaffDriverHistory } from '../src/mapPeriod.js';
import '../public/map-period-ui.js';
const startDate = '2026-08-01', endDate = '2026-08-28';
const row = (n, overrides={}) => ({customerCode:'S1001',sourceKey:'KEY'+n,deliveryDate:'2026-08-02',lastDeliveryDate:'2026-08-02',vehicle:'101',driverKey:'driver-a',driverName:'합성 기사', ...overrides});
function page(data,{offset=0,total=data.length,more=false,privateHistory=false,customerCode=''}={}) {
 return {ok:true,data,meta:{contract:privateHistory?'staff-driver-history-v1':'period-assignments-v1',startDate,endDate,customerCode,
   totalCount:total,sourceCount:total,pageOffset:offset,count:data.length,pageSize:privateHistory?200:1000,
   hasMore:more,complete:!more,nextCursor:more?'NEXT':null,truncated:false}};
}
const job = () => ({startDate,endDate,count:0,total:null,keys:new Set(),cursors:new Set()});
test('period page validates counts, duplicates, range, cursor and rejects truncated success',()=>{
 assert.deepEqual(validatePeriod(startDate,endDate),{startDate,endDate});
 assert.throws(()=>validatePeriod('2026-01-01',endDate)); assert.throws(()=>validatePeriod('2026-02-30',endDate));
 const j=job();checkPeriodPage(page([row(1)],{total:2,more:true}),j);
 checkPeriodPage(page([row(2)],{offset:1,total:2}),j);assert.equal(j.count,2);
 for(const patch of [{totalCount:3},{truncated:true},{count:2},{complete:false},{hasMore:true},{pageOffset:1}]) {
  const p=page([row(1)]);Object.assign(p.meta,patch);assert.throws(()=>checkPeriodPage(p,job()));
 }
 assert.throws(()=>checkPeriodPage(page([row(1),row(1)]),job()));
 assert.throws(()=>checkPeriodPage(page([row(1,{deliveryDate:'2026-07-31'})]),job()));
});
test('period preserves changed vehicles and dates; driver selection is historical identity',()=>{
 const grouped=groupPeriodRows([row(1),row(2,{deliveryDate:'2026-08-20',lastDeliveryDate:'2026-08-20',vehicle:'202'}),row(3,{customerCode:'S1002',driverKey:'driver-b'})]);
 assert.equal(grouped.length,2);assert.equal(grouped[0].history.length,2);assert.equal(grouped[0].vehicle,'202');
 assert.equal(MapPeriodUi.select(grouped,['101'])[0].vehicle,'101');
 const byDriver=MapPeriodUi.select(grouped,[],'driver-a');assert.equal(byDriver.length,1);assert.equal(byDriver[0].history.length,2);
 assert.equal(byDriver[0].status,'');assert.equal(byDriver[0].representativeLabel,'선택 기간 내 최신 배차');
});
test('dense period markers cluster without removing underlying stores or selected identity',()=>{
 const rows=Array.from({length:100},(_,i)=>({customerCode:'S'+i,lat:37,lng:127}));
 const pins=MapPeriodUi.cluster(rows,()=>({x:100,y:100}),12,'S1');
 assert.equal(pins.length,2);assert.equal(pins[0].customerCode,'S1');assert.equal(pins[1].clusterCount,99);
 assert.equal(MapPeriodUi.cluster(rows,()=>({x:100,y:100}),7).length,100);assert.equal(rows.length,100);
});
test('background period advances pages automatically, hides partial data, stops third repeated error',async()=>{
 const tasks=[];let calls=0;
 const jobs=createPeriodJobs({schedule:fn=>{tasks.push(fn);return {unref(){}};},loadPage:async()=>++calls===1?page([row(1)],{total:2,more:true}):page([row(2)],{offset:1,total:2})});
 assert.equal(jobs.read(startDate,endDate).data,null);
 tasks.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(jobs.read(startDate,endDate).meta.count,1);assert.equal(jobs.read(startDate,endDate).data,null);
 tasks.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(jobs.read(startDate,endDate).meta.complete,true);
 const errors=[],failed=createPeriodJobs({schedule:fn=>{errors.push(fn);return {unref(){}};},loadPage:async()=>{throw new Error('SYNTHETIC');}});
 failed.read(startDate,endDate);
 for(let i=0;i<3;i++){errors.shift()();await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(failed.read(startDate,endDate).meta.phase,'ERROR');assert.equal(errors.length,0);
});
test('driver history returns only requested customer and no owner/raw memo fields',async()=>{
 const rows=await readStaffDriverHistory({customerCode:'S1001',startDate,endDate},async()=>page([row(1,{driverPhone:'SYNTHETIC_CONTACT',ownerPhone:'NEVER',accessMemo:'NEVER'})],{privateHistory:true,customerCode:'S1001'}));
 assert.equal(rows[0].driverPhone,'SYNTHETIC_CONTACT');assert.equal('ownerPhone' in rows[0],false);assert.equal('accessMemo' in rows[0],false);
 await assert.rejects(readStaffDriverHistory({customerCode:'S9999',startDate,endDate},async()=>page([row(1)],{privateHistory:true})));
});
