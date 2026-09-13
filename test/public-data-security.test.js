import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {redactPublicData,generalMapResponse} from '../src/publicDataSecurity.js';
test('public map removes nested sensitive fields while preserving route totals',()=>{
 const value=redactPublicData({totalStops:27,completedStops:10,remainingStops:17,data:[{customerCode:'TEST',password:'synthetic',rawMemo:'synthetic',location:{message:'synthetic'},accessInfo:'synthetic',phone:'synthetic'}]});
 assert.deepEqual(value,{totalStops:27,completedStops:10,remainingStops:17,data:[{customerCode:'TEST',location:{}}]});
});
test('collector guards use existing authenticated automation token contract',()=>{
 const src=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 for(const name of ['delivery','freshon'])assert.ok(src.includes(`app.get("/api/collector/${name}", requireAdmin,`));
});
test('sensitive namespaces require admin before public views and SPA fallback',()=>{
 const src=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 for(const [namespace,guard] of [['/api/collector','requireAdmin'],['/api/map-phase2b/private','mapStaff.requireStaff']]) {
  const gate=src.indexOf(`app.use('${namespace}', ${guard}`);
  assert.ok(gate>=0);
  assert.ok(gate<src.indexOf('app.use(express.static(publicDir))'));
 }
});
test('PUBLIC_VIEW never bypasses requireAdmin',async()=>{
 process.env.ADMIN_TOKEN='synthetic-test-only-token';
 process.env.PUBLIC_VIEW='true';
 const {requireAdmin,requireView}=await import('../src/auth.js');
 let status=0,passed=false;
 const res={status(v){status=v;return this;},json(){return this;}};
 const req={get:()=>'',query:{}};
 requireView(req,res,()=>{passed=true;});
 assert.equal(passed,true);
 passed=false;requireAdmin(req,res,()=>{passed=true;});
 assert.equal(status,401);assert.equal(passed,false);
 requireAdmin({get:()=>process.env.ADMIN_TOKEN,query:{}},res,()=>{passed=true;});
 assert.equal(passed,true);
});
test('public detail has only five general fields',()=>{
 let result;const res={setHeader(){},json:v=>{result=v;}};
 const req={path:'/detail'};generalMapResponse(req,res,()=>{});req.path='/api/map-phase2b/preview/detail';
 res.json({ok:true,data:{customerCode:'TEST',password:'synthetic',lat:1}});
 assert.deepEqual(Object.keys(result.data),['customerCode','customerName','address','vehicle','status']);
});
