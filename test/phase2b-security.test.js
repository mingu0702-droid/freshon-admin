import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { sensitiveAuth, publicMapValue, publicCustomerDetail, publicResponse } from "../src/phase2bSecurity.js";

test("sensitive endpoints fail closed independently of PUBLIC_VIEW and preserve authorized collector contract", async () => {
  const app=express(); app.use(publicResponse);
  app.get('/api/collector/delivery', sensitiveAuth('test-only-token',{allowLegacyQuery:true}), (_q,s)=>s.json({ok:true}));
  app.get('/api/map-phase2b/private/customer-detail', sensitiveAuth('test-only-token'), (_q,s)=>s.json({ok:true,password:'synthetic-test-only'}));
  app.get('/api/map-phase2b/preview/detail', (_q,s)=>s.json({data:{customerCode:'TEST',password:'synthetic-test-only',location:{message:'synthetic-test-only'},rawMemo:'synthetic-test-only'}}));
  app.get('/unconfigured', sensitiveAuth(''), (_q,s)=>s.json({ok:true}));
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const p of ['/api/collector/delivery','/api/map-phase2b/private/customer-detail','/unconfigured']) assert.equal((await fetch(base+p)).status,401);
    assert.equal((await fetch(base+'/api/map-phase2b/private/customer-detail?token=test-only-token')).status,401);
    const privateResponse=await fetch(base+'/api/map-phase2b/private/customer-detail',{headers:{'x-admin-token':'test-only-token'}});
    assert.equal(privateResponse.status,200);assert.match(privateResponse.headers.get('cache-control'),/no-store/);
    assert.equal((await privateResponse.json()).password,'synthetic-test-only');
    assert.equal((await fetch(base+'/api/collector/delivery?token=test-only-token')).status,200);
    const pub=await (await fetch(base+'/api/map-phase2b/preview/detail')).json();
    assert.deepEqual(pub,{data:{customerCode:'TEST',location:{}}});
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
test("public projection strips nested aliases and memo fields without changing route totals",()=>{
  const row={customerCode:'TEST',customerName:'Synthetic',address:'Test address',vehicle:'101',status:'COMPLETED',password:'synthetic',rawMemo:'synthetic',accessInfo:'synthetic',ownerPhone:'synthetic',messageByCenter:'synthetic',specialRemark:'synthetic',detailAddress:'synthetic'};
  assert.deepEqual(publicCustomerDetail(row),{customerCode:'TEST',customerName:'Synthetic',address:'Test address',vehicle:'101',status:'COMPLETED'});
  const clean=publicMapValue({totalStops:27,completedStops:10,remainingStops:17,stops:[row],location:{message:'synthetic',gps:{lat:1,lng:2}}});
  assert.equal(clean.totalStops,27); assert.equal(clean.stops[0].password,undefined); assert.equal(clean.stops[0].specialRemark,undefined);assert.equal(clean.location.message,undefined);
});
