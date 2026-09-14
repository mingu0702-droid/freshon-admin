import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createReadDeadline, historyDeadline } from '../src/readDeadline.js';
import { EventEmitter } from 'node:events';
import { readStaffDriverHistory, compactPeriodStores, groupPeriodRows, createPeriodJobs } from '../src/mapPeriod.js';
import { validateDeliveryLivePage } from '../src/deliveryLiveContract.js';
import { mapReadFailure } from '../src/mapReadFailure.js';
import '../public/map-period-ui.js';
const range={customerCode:'S1001',startDate:'2026-08-01',endDate:'2026-08-03'};
const record=(n,patch={})=>({customerCode:'S1001',sourceKey:'K'+n,deliveryId:'T'+n,deliveryDate:'2026-08-01',vehicle:'101',driverKey:'A',driverName:'SYNTHETIC',...patch});
function page(rows,more=false){return{ok:true,data:rows,meta:{...range,source:'Delivery.delivery_admin_raw',contract:'staff-driver-history-v1',pageSize:200,pageOffset:0,count:rows.length,totalCount:more?2:rows.length,sourceCount:more?2:rows.length,hasMore:more,complete:!more,nextCursor:more?'NEXT':null,truncated:false}};}
test('one deadline includes prior auth and never starts another page after expiry',async()=>{
 let now=0,calls=0;const budget=createReadDeadline({now:()=>now});
 now=4900;
 await assert.rejects(readStaffDriverHistory(range,async(_,options)=>{calls++;assert.equal(options.deadline,5000);assert.equal(options.signal,budget.signal);now=5001;return page([record(1)],true);},{budget,requireDelivery:true}),{name:'AbortError'});
 assert.equal(calls,1);budget.dispose();
});
test('request disconnect aborts actual downstream signal',()=>{
 const req=new EventEmitter(),res=new EventEmitter();historyDeadline(req,res,()=>{});
 res.emit('close');assert.equal(req.historyBudget.signal.aborted,true);
});
test('wrong Freshon history source fails closed even when HTTP and pagination succeed',async()=>{
 await assert.rejects(readStaffDriverHistory(range,async()=>{const p=page([record(1)]);p.meta.source='Customer.daily_routes';return p;},{requireDelivery:true}),/HISTORY_SOURCE_INCOMPLETE/);
});
test('period compact relations preserve multi-vehicle driver filters and counts',()=>{
 const rows=[record(1),record(2,{deliveryDate:'2026-08-02'}),record(3,{deliveryDate:'2026-08-03',vehicle:'202',driverKey:'B'})];
 const compact=compactPeriodStores(groupPeriodRows(rows));assert.equal('history'in compact[0],false);
 const hydrated=compact.map(r=>({...r,history:r.relations}));
 assert.equal(MapPeriodUi.select(hydrated,['101'])[0].visitCount,2);
 assert.equal(MapPeriodUi.select(hydrated,[],'B')[0].visitCount,1);
 assert.equal(MapPeriodUi.select(hydrated,[])[0].periodVisitCount,3);
});
test('status-only peek does not create or restart a job',()=>{
 let schedules=0;const jobs=createPeriodJobs({schedule:()=>{schedules++;return{};},loadPage:()=>{}});
 assert.equal(jobs.peek(range.startDate,range.endDate).phase,'NOT_FOUND');assert.equal(schedules,0);
 jobs.read(range.startDate,range.endDate);const status=jobs.peek(range.startDate,range.endDate);
 assert.equal(status.continuation,'ACTIVE');assert.ok(status.jobId);assert.ok(status.nextScheduledAt);assert.equal(schedules,1);
});
test('OUTPUT HTML 404 has a distinct non-retry classification',()=>{
 assert.deepEqual(mapReadFailure(new Error('HUB_OUTPUT_HTML_404')),{status:502,code:'SOURCE_OUTPUT_HTML_404',retryable:false});
 assert.notEqual(mapReadFailure(new Error('HUB_CUSTOMER_NOT_FOUND')).code,'SOURCE_OUTPUT_HTML_404');
});
test('current Delivery date and complete pagination required, old RAW cannot pass',()=>{
 const rows=[{id:'T1',customer:{erpCode:'S1001'},enteringDatedAt:'2026-08-01T00:00:00+09:00'}],opts={date:'2026-08-01',page:0,pageSize:300,received:0};
 assert.equal(validateDeliveryLivePage({totalElements:1,totalPages:1},rows,opts).complete,true);
 assert.throws(()=>validateDeliveryLivePage({},rows,opts),/INCOMPLETE/);
 assert.throws(()=>validateDeliveryLivePage({totalElements:1,totalPages:1},rows,{...opts,date:'2026-08-02'}),/DATE_UNCONFIRMED/);
});
test('Delivery raw exact task identity never combines source contacts or current master',()=>{
 const headers=['sourceSystem','deliveryDate','deliveryId','customerCode','confirmedVehicle','driverName','driverPhone','deliveryStatus','importKey','rawHash'];
 const rows=[{sourceSystem:'delivery_admin',deliveryDate:'2026-08-02',deliveryId:'T1',customerCode:'S1001',confirmedVehicle:'101',driverName:'DATED_SYNTHETIC',driverPhone:'SYNTHETIC_ONLY',deliveryStatus:'COMPLETED',importKey:'delivery_admin|2026-08-02|T1',rawHash:'HASH'}];
 const sheet={getLastRow:()=>2,getLastColumn:()=>headers.length,getSheetId:()=>1,getRange:(r)=>r===1?{getValues:()=>[headers]}:{createTextFinder:()=>({matchEntireCell(){return this;},useRegularExpression(){return this;},findAll:()=>[{getRow:()=>2}]})}};
 const c=vm.createContext({Date,Number,String,JSON,Error,HUB_DEFAULT_SOURCE_ID:'C',HUB_STAFF_DETAIL_ARCHIVE:'A',DriveApp:{getFileById:()=>({getLastUpdated:()=>new Date(1000)})},SpreadsheetApp:{openById:id=>({getSheetByName:()=>id==='C'?sheet:null})},hubStaffHistoryDate_:v=>v,hubStaffHistoryBatchRead_:()=>rows});
 vm.runInContext(fs.readFileSync(new URL('../integrations/hub/HubDeliveryHistory.js',import.meta.url),'utf8'),c);
 const result=c.hubDeliveryHistorySource_('S1001',range.startDate,range.endDate);
 assert.equal(result.rows[0].driverName,'DATED_SYNTHETIC');assert.equal(result.rows[0].deliveryId,'T1');
 rows[0].customerCode='SOTHER';assert.throws(()=>c.hubDeliveryHistorySource_('S1001',range.startDate,range.endDate),/LOCATOR_CHANGED/);
 rows[0].customerCode='S1001';rows[0].importKey='WRONG';assert.throws(()=>c.hubDeliveryHistorySource_('S1001',range.startDate,range.endDate),/INCOMPLETE/);
});
