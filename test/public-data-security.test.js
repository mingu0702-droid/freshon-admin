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
test('public detail has only five general fields',()=>{
 let result;const res={setHeader(){},json:v=>{result=v;}};
 generalMapResponse({path:'/detail'},res,()=>{});
 res.json({ok:true,data:{customerCode:'TEST',password:'synthetic',lat:1}});
 assert.deepEqual(Object.keys(result.data),['customerCode','customerName','address','vehicle','status']);
});
