import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeRecentOperations,normalizeRecentOperations,openRecentOperations,recentOperationsKey,sealRecentOperations}
  from '../src/stageRecentOperations.js';
import {planStageNightOrderExclusions,stageNightOrderScope} from '../src/stageNightOrderScope.js';

const centers=['osan','yeongnam','honam'];
const start='2026-08-27', end='2026-11-24', run='2026-11-25';
const day=(date,centerKey,codes=[],extra={})=>({date,centerKey,source:'freshon_orders',coverage:'partial',
  rows:codes.map(customerCode=>({customerCode,evidence:'order_confirmed',nightOrder:true})),...extra});

test('confirmed night orders can establish presence even if overall coverage is insufficient for exclusion',async()=>{
  const prior=normalizeRecentOperations({startDate:start,endDate:end,days:[
    day(end,'yeongnam',[],{rows:[{customerCode:'S1',evidence:'order_confirmed'},{customerCode:'S2',evidence:'order_confirmed'}]}),
    {date:end,centerKey:'osan',source:'wms_dispatch',coverage:'complete',rows:[{customerCode:'S3',evidence:'dispatch_confirmed'}]}
  ]});
  const incoming=mergeRecentOperations(prior,end,[day(end,'yeongnam',['S1','S4'])]);
  const key=recentOperationsKey(Buffer.alloc(32,7).toString('base64'));
  const reopened=await openRecentOperations(await sealRecentOperations(incoming,key),key);
  const scope=stageNightOrderScope(reopened,run);
  assert.deepEqual([...scope.byCenter.get('yeongnam')],['S1','S4']);
  assert.deepEqual([...scope.orderCodes],['S1','S4']);
  assert.equal(scope.allDaysVerified,false);
  assert.deepEqual([...planStageNightOrderExclusions(scope,['S2','S3'],new Set()).skip],[]);
  assert(reopened.days.some(entry=>entry.rows.some(row=>row.customerCode==='S2'&&!row.nightOrder)));
  assert.equal(reopened.days.find(entry=>entry.source==='wms_dispatch').rows[0].evidence,'dispatch_confirmed');
  assert.throws(()=>normalizeRecentOperations({startDate:start,endDate:end,days:[
    day(end,'osan',['S4'],{completeNightOrders:true})
  ]}),/RECENT_OPERATIONS_EVIDENCE_INVALID/);
});

test('exclusion needs all 270 authoritative closed-day scopes and never applies to protected stores',()=>{
  const calendar=Array.from({length:90},(_,i)=>new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10));
  const days=calendar.flatMap((date,index)=>centers.map(center=>day(date,center,
    index===0&&center==='honam'?['S1']:[],{coverage:'complete',completeNightOrders:true})));
  const ledger=normalizeRecentOperations({startDate:start,endDate:end,days});
  const scope=stageNightOrderScope(ledger,run), protectedCodes=new Set(['S2']);
  assert.equal(scope.allDaysVerified,true);
  assert.deepEqual([...scope.orderCodes],['S1']);
  const codes=['S1','S2','S3'];
  const review=planStageNightOrderExclusions(scope,codes,protectedCodes);
  assert.equal(review.proposed,1);
  assert.match(review.reviewSha256,/^[a-f0-9]{64}$/);
  assert.equal(review.skip.size,0);
  assert.deepEqual([...planStageNightOrderExclusions(scope,codes,protectedCodes,review.reviewSha256).skip],['S3']);
  const safeScope=stageNightOrderScope({...ledger,days:ledger.days.filter(entry=>entry.date!==end||entry.centerKey!=='yeongnam')},run);
  assert.equal(safeScope.allDaysVerified,false);
  assert.equal(planStageNightOrderExclusions(safeScope,codes,protectedCodes,review.reviewSha256).proposed,0);
});
