import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { readPaginatedDatedAssignments as read } from "../src/phase2bAssignments.js";
import { createPhase2bReadCache } from "../src/phase2bReadCache.js";
import { classifyHubFailure } from "../src/hubApiClient.js";
const date = "2026-08-11";
test("502 diagnostics distinguish timeout, HTML, JSON, execution, auth and 5xx without changing retry",()=>{
 assert.equal(classifyHubFailure({name:"AbortError"}),"timeout");
 assert.equal(classifyHubFailure({responseKind:"html",failureType:"parse"}),"hub-html");
 assert.equal(classifyHubFailure({failureType:"parse"}),"invalid-json-contract");
 assert.equal(classifyHubFailure({message:"HUB_INTERNAL_ERROR",upstreamStatus:500}),"apps-script-execution");
 assert.equal(classifyHubFailure({upstreamStatus:403,responseKind:"html"}),"auth");
 assert.equal(classifyHubFailure({upstreamStatus:503}),"upstream-5xx");
 assert.equal(classifyHubFailure({}),"network");
});
function source(total, change = p => p) {
  let count = 0;
  return async ({cursor, limit}) => {
    const offset = Number(cursor || 0), end = Math.min(offset + limit, total), more = end < total;
    const data = Array.from({length:end-offset}, (_,i) => ({deliveryDate:date,customerCode:`C${offset+i}`,vehicle:"101",sourceKey:`K${offset+i}`,lat:37,lng:127}));
    return change({ok:true,data,meta:{contract:"dated-assignments-v1",date,totalCount:total,sourceCount:total,pageOffset:offset,count:data.length,pageSize:limit,hasMore:more,nextCursor:more?String(end):null,complete:!more,truncated:false}},count++);
  };
}
for (const n of [0, 964, 1000, 1001, 1964, 2501]) test(`complete pagination for ${n} rows`, async () => {
  const result = await read(date,source(n));
  assert.equal(result.data.length,n); assert.equal(result.meta.rawCount,n); assert.equal(result.meta.sourceCount,n);
  assert.equal(result.meta.pages.reduce((n,p)=>n+p.count,0),n);
  assert.equal(result.meta.complete,true); assert.equal(result.meta.truncated,false);
});
test("duplicate source row across pages rejects the entire result",async()=> {
  await assert.rejects(read(date,source(1001,(p,i)=>{if(i)p.data[0].sourceKey="K0";return p;})),/DUPLICATE_SOURCE_ROW/);
});
test("page offset gap rejects",async()=> {
  await assert.rejects(read(date,source(1964,(p,i)=>{if(i)p.meta.pageOffset++;return p;})),/PAGE_GAP/);
});
for (const error of ["HUB_500","HUB_INVALID_JSON"]) test(`middle-page ${error} is never partial success`,async()=> {
  await assert.rejects(read(date,source(1964,(p,i)=>{if(i)throw new Error(error);return p;})),new RegExp(error));
});
test("hasMore without cursor rejects",async()=> {
  await assert.rejects(read(date,source(1964,p=>{p.meta.nextCursor=null;return p;})),/CURSOR_INVALID/);
});
test("last-page false complete rejects",async()=> {
  await assert.rejects(read(date,source(964,p=>{p.meta.complete=false;return p;})),/CURSOR_INVALID/);
});
test("unlocated and unassigned source rows are retained",async()=> {
  const result=await read(date,source(1001,(p,i)=>{if(i){p.data[0].lat=null;p.data[0].lng=null;p.data[0].vehicle="";}return p;}));
  assert.equal(result.data.length,1001);assert.equal(result.meta.missingCoordinate,1);assert.equal(result.meta.complete,true);
});
test("total changing across pages rejects",async()=> {
  await assert.rejects(read(date,source(1964,(p,i)=>{if(i){p.meta.totalCount++;p.meta.sourceCount++;}return p;})),/TOTAL_CHANGED/);
});
test("last page count must equal source total",async()=> {
  await assert.rejects(read(date,source(1964,(p,i)=>{if(i){p.data.pop();p.meta.count--;}return p;})),/COUNT_MISMATCH/);
});
test("assignment identity dedupe preserves first-page order",async()=> {
  const result=await read(date,source(1001,(p,i)=>{if(i)p.data[0].customerCode="C0";return p;}));
  assert.equal(result.data.length,1000);assert.equal(result.meta.duplicateCount,1);assert.equal(result.data[0].customerCode,"C0");
});
test("repeated cursor rejects",async()=> {
  await assert.rejects(read(date,source(2501,(p,i)=>{if(i)p.meta.nextCursor="1000";return p;})),/CURSOR_REPEATED/);
});
test("failed aggregate is not cached; retry begins at first page",async()=> {
  const cache=createPhase2bReadCache({name:"test",ttlMs:600000,staleMs:0,maxEntries:5,maxBytes:1000000});
  await assert.rejects(cache.load(date,()=>read(date,source(1964,(p,i)=>{if(i)throw new Error("HUB_500");return p;}))));
  assert.equal(cache.stats().entries,0);
  const ok=await cache.load(date,()=>read(date,source(1964)));
  assert.equal(ok.value.data.length,1964);
  assert.equal((await cache.load(date,()=>{throw new Error("must hit");})).cache,"HIT");
});
function hubContext(total) {
 const calls=[];
 const ctx={
  Utilities:{base64EncodeWebSafe:t=>Buffer.from(t).toString("base64url"),base64DecodeWebSafe:t=>Buffer.from(t,"base64url"),newBlob:b=>({getDataAsString:()=>b.toString()})},
  hubMapHttpValidateOnlyKeys_:()=>{},hubMapHttpDate_:x=>x,hubMapHttpLimit_:(n,d)=>n||d,hubMapHttpText_:x=>x,
  hubMapHttpRequireHubOk_:()=>{},hubMapHttpObjects_:p=>p.data,hubMapHttpDateOrNull_:x=>x,
  hubMapHttpRaise_:code=>{throw new Error(code);},
  hubMapPhase2BCoordinateMap_:()=>({}),hubMapPhase2BNumber_:x=>x==null?null:Number(x),
  hubMapPhase2BValidCoordinate_:(a,b)=>a>33&&a<39&&b>124&&b<132,
  getDailyRoutes:request=>{
   calls.push(request);const start=Number(request.nextToken||0),end=Math.min(start+request.limit,total);
   return {ok:true,data:Array.from({length:end-start},(_,i)=>({deliveryDate:date,customerCode:`C${start+i}`,confirmedVehicle:"101",hashKey:`K${start+i}`})),meta:{total,returned:end-start,nextToken:end<total?String(end):null}};
  }
 };vm.createContext(ctx);vm.runInContext(fs.readFileSync(new URL("../integrations/hub/HubDatedAssignments.js",import.meta.url),"utf8"),ctx);
 return {ctx,calls};
}
test("Hub reuses nextToken and retains 1964 source rows including unlocated",async()=>{
 const {ctx,calls}=hubContext(1964);
 const result=await read(date,async p=>({ok:true,...ctx.hubDatedAssignmentsPage_(p)}));
 assert.equal(result.data.length,1964);assert.equal(result.meta.missingCoordinate,1964);
 assert.deepEqual(calls.map(p=>p.limit),[1000,1000]);assert.equal(calls[1].nextToken,"1000");
});
test("Hub rejects cursor reuse for another date",()=>{
 const {ctx}=hubContext(1964);const p=ctx.hubDatedAssignmentsPage_({date,limit:1000});
 assert.throws(()=>ctx.hubDatedAssignmentsPage_({date:"2026-08-12",limit:1000,cursor:p.meta.nextCursor}),/INVALID_CURSOR/);
});
test("Hub validates source actual row date before returning complete",()=>{
 const {ctx}=hubContext(1);ctx.getDailyRoutes=()=>({ok:true,data:[{deliveryDate:"2026-08-12",customerCode:"X"}],meta:{total:1,returned:1}});
 assert.throws(()=>ctx.hubDatedAssignmentsPage_({date,limit:1000}),/DATE_MISMATCH/);
});
