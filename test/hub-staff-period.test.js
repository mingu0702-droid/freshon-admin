import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('../integrations/hub/HubStaffPeriod.js', import.meta.url),'utf8');
function fixture(rows, total, nextToken=null) {
 let request;
 const read = filters => {request=filters;return {ok:true,data:rows,meta:{returned:rows.length,total,nextToken}};};
 const context=vm.createContext({Date,Number,JSON,String,Error,HUB_MAP_HTTP_API:{SECRET_PROPERTY:'TEST'},
   hubMapHttpValidateOnlyKeys_:(p,allowed)=>{for(const key of Object.keys(p)) if(!allowed.includes(key)) throw new Error('BAD_KEY');},
   hubMapHttpDate_:x=>x, hubMapHttpCustomerCode_:x=>x, hubMapHttpLimit_:(x,d,max)=>Math.min(x||d,max),
   hubMapHttpText_:x=>{if(x.length>200)throw new Error('INVALID_PARAMS');return x;}, hubMapHttpDateOrNull_:x=>x,
   hubMapHttpRequireHubOk_:x=>assert.equal(x.ok,true),hubMapHttpObjects_:x=>x.data,
   hubMapHttpRaise_:code=>{throw new Error(code);},getDailyRoutes:read,CustomerDataApi:{getDailyRoutes:read},
   PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'SYNTHETIC_HMAC_KEY'})},
   Utilities:{base64EncodeWebSafe:x=>Buffer.from(x).toString('base64url'),base64DecodeWebSafe:x=>Buffer.from(x,'base64url'),
     newBlob:x=>({getDataAsString:()=>Buffer.from(x).toString()}),computeHmacSha256Signature:(text,key)=>crypto.createHmac('sha256',key).update(text).digest()}
 });
 vm.runInContext(source,context);
 return {context,request:()=>request};
}
const params={startDate:'2026-08-01',endDate:'2026-08-28',limit:1000};
test('Stage facade uses range cursor, strips memo/phone from public pages and preserves historical driver identity',()=>{
 const records=Array.from({length:1000},(_,i)=>({deliveryDate:'2026-08-02',customerCode:'S'+(1000+i),confirmedVehicle:'101',driverName:'합성기사',driverPhone:'SYNTHETIC_CONTACT',accessMemo:'NEVER',hashKey:'K'+i}));
 const f=fixture(records,1001,'SOURCE_CURSOR'),p=f.context.hubPeriodAssignmentsPage_(params);
 assert.equal(p.data.length,1000);assert.equal(p.meta.complete,false);assert.equal(f.request().startDate,params.startDate);
 assert.equal('driverPhone' in p.data[0],false);assert.equal('accessMemo' in p.data[0],false);assert.equal(p.data[0].kind,'ASSIGNED');
 const next=fixture([{...records[0],customerCode:'S9999',hashKey:'K1000'}],1001);
 const last=next.context.hubPeriodAssignmentsPage_({...params,cursor:p.meta.nextCursor});
 assert.equal(last.meta.pageOffset,1000);assert.equal(last.meta.complete,true);assert.equal(next.request().nextToken,'SOURCE_CURSOR');
 assert.equal(p.data[0].driverKey,last.data[0].driverKey);
});
test('private history is customer-filtered, does not expose source memo and fails incomplete totals',()=>{
 const f=fixture([{deliveryDate:'2026-08-02',customerCode:'S1234',confirmedVehicle:'101',driverName:'합성',driverPhone:'SYNTHETIC_CONTACT',accessMemo:'NEVER'}],1);
 const p=f.context.hubStaffDriverHistoryPage_({...params,customerCode:'S1234',limit:200});
 assert.equal(f.request().customerCode,'S1234');assert.equal(p.data[0].driverPhone,'SYNTHETIC_CONTACT');assert.equal('accessMemo' in p.data[0],false);
 assert.throws(()=>fixture([],1).context.hubPeriodAssignmentsPage_(params));
});

test('range cursor over 200 chars round-trips with a strict local bound; malformed/oversized fail closed',()=>{
 const record={deliveryDate:'2026-08-02',customerCode:'S1234',confirmedVehicle:'101',hashKey:'FIRST'};
 const first=fixture([record],2,'SYNTHETIC_NEXT_TOKEN_'.repeat(15)).context.hubPeriodAssignmentsPage_(params);
 assert.ok(first.meta.nextCursor.length>200);
 const next=fixture([{...record,hashKey:'SECOND'}],2);
 assert.equal(next.context.hubPeriodAssignmentsPage_({...params,cursor:first.meta.nextCursor}).meta.complete,true);
 for(const cursor of ['A'.repeat(3001),'not base64!']) assert.throws(()=>next.context.hubPeriodAssignmentsPage_({...params,cursor}),/INVALID_CURSOR/);
 assert.throws(()=>next.context.hubPeriodAssignmentsPage_({...params,startDate:'2026-08-03',cursor:first.meta.nextCursor}),/INVALID_CURSOR/);
});
