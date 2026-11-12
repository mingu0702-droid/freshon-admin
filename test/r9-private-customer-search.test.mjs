import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import crypto from 'node:crypto';
import express from 'express';
import {mountPrivateCustomerSearch,preparePreservedAddressIndex,searchCustomerSummaries,searchPreservedRegistry} from '../src/privateCustomerSearch.js';
const source=fs.readFileSync(new URL('../integrations/hub/protected-reader/CustomerSearch.js',import.meta.url),'utf8');
const now='2026-11-03T00:00:00Z';
function fixture(extra=[],mutate=false){
 const headers=['customerCode','customerName','customerAddress','updatedAt','password'],data=[['S970001','합성 같은건물 A','서울특별시 강남구 합성로 10',now,'DO_NOT_READ'],['S970002','합성 같은건물 B','서울 강남구 합성로 10',now,'DO_NOT_READ'],['S970003','합성 다른번지','서울 강남구 합성로 100',now,'DO_NOT_READ'],...extra],reads=[];let batches=0;
 const values=range=>{reads.push(range);if(range.endsWith('1:1'))return [headers];const m=range.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);assert(m,range);assert.equal(m[1],m[3]);const col=m[1].charCodeAt(0)-65;assert(col<4,'private value column must never be read');return data.slice(+m[2]-2,+m[4]-1).map(r=>[r[col]]);};
 const context=vm.createContext({Date,Map,JSON,String,Number,Math,isFinite,PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'SYNTHETIC_METADATA_SOURCE'})},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_a,s)=>[...crypto.createHash('sha256').update(s).digest()]},protectedReaderProfile_:{},hubMapHttpRaise_:(c)=>{throw Error(c);},Sheets:{Spreadsheets:{get:()=>({sheets:[{properties:{title:'customers',gridProperties:{columnCount:5,rowCount:1000}}}]}),Values:{get:(_id,r)=>({values:values(r)}),batchGet:(_id,{ranges})=>{batches++;const result={valueRanges:ranges.map(r=>({range:r,values:values(r)}))};if(mutate&&batches===2)result.valueRanges[1].values[0][0]='2026-11-04T00:00:00Z';return result;}}}}});vm.runInContext(source,context);
 return {search:q=>JSON.parse(JSON.stringify(context.protectedReaderSearch_({q,limit:50}))),reads};
}
test('official province aliases/whitespace match one building, retaining separate customer identities',()=>{const f=fixture(),r=f.search('서울 강남구 합성로10');assert.equal(r.complete,true);assert.deepEqual(r.rows.map(x=>x.customerCode),['S970001','S970002']);assert(r.rows.every(x=>x.matchedBy==='ADDRESS'));assert(!JSON.stringify(r).includes('DO_NOT_READ'));assert(!JSON.stringify(r).includes('합성로'));});
test('full-address building number is not a prefix of a different building',()=>{assert.equal(fixture().search('서울특별시강남구합성로100').rows[0].customerCode,'S970003');assert.equal(fixture().search('서울 강남구 합성로 1').rows.length,0);});
test('current metadata revision changing mid-read cannot declare no matching customer',()=>assert.throws(()=>fixture([],true).search('없는 주소 55'),/SEARCH_SOURCE_CHANGED/));
test('conflicting current rows are withheld and absence is unverified',()=>{const r=fixture([['S970001','합성 같은건물 A','서울 강남구 다른로 90',now]]).search('서울 강남구 합성로10');assert.equal(r.complete,false);assert.equal(r.conflicts,1);assert.deepEqual(r.rows.map(x=>x.customerCode),['S970002']);});
test('search never reads memo/credential value columns and never returns a bulk source',()=>{const f=fixture();f.search('합성');assert(f.reads.length<15);assert(f.reads.every(r=>!r.includes('!E2')));assert.equal(f.search('()').rows.length,0);});
test('exact known customer remains selectable while the master is unavailable',async()=>{const result=await searchCustomerSummaries({query:'S970001',snapshot:{rows:[{customerCode:'S970001',customerName:'합성',lat:37,lng:127,password:'DO_NOT_RETURN',address:'DO_NOT_RETURN'}]},searchMaster:()=>assert.fail('unneeded source call')});assert.equal(result.data[0].lat,37);assert(!JSON.stringify(result).includes('DO_NOT_RETURN'));});
test('authenticated current address matches join by code without returning private addresses',async()=>{const f=fixture();const r=await searchCustomerSummaries({query:'서울 강남구 합성로10',snapshot:{rows:[{customerCode:'S970001',lat:37,lng:127}]},searchMaster:async q=>({ok:true,data:f.search(q)})});assert.equal(r.meta.customerMatchVerified,true);assert.equal(r.data.length,2);assert.equal(r.data[0].lat,37);assert.equal(r.data[1].lat,null);assert(!JSON.stringify(r).includes('합성로'));});
test('changed address hash cannot reuse a previously verified coordinate',async()=>{const f=fixture();const r=await searchCustomerSummaries({query:'서울 강남구 합성로10',snapshot:{rows:[{customerCode:'S970001',lat:37,lng:127,originalAddressHash:'f'.repeat(64)}]},searchMaster:async q=>({ok:true,data:f.search(q)})});const row=r.data.find(x=>x.customerCode==='S970001');assert.equal(row.lat,null);assert.equal(row.coordinateStatus,'CONFLICT');assert.equal(row.addressChanged,true);});
test('master failure does not break known names or certify unknown addresses',async()=>{const searchMaster=async()=>{throw Error('HUB_TIMEOUT');};const r=await searchCustomerSummaries({query:'합성',snapshot:{rows:[{customerCode:'S970001',customerName:'합성'}]},searchMaster});assert.equal(r.data.length,1);assert.equal(r.meta.customerMatchVerified,false);await assert.rejects(searchCustomerSummaries({query:'서울 미등록로 99',snapshot:{rows:[]},searchMaster}),/HUB_TIMEOUT/);});

test('a failed source lookup cannot substitute a nearby number or a different province', async () => {
 const snapshot={rows:[
  {customerCode:'S970001',address:'경기 광주시 합성로 560'},
  {customerCode:'S970002',address:'전남 광주시 합성로 56'}
 ]};
 const searchMaster=async()=>{throw Error('HUB_TIMEOUT');};
 await assert.rejects(searchCustomerSummaries({query:'경기 광주시 합성로 56',snapshot,searchMaster}),/HUB_TIMEOUT/);
 const matched=await searchCustomerSummaries({query:'경기도 광주시 합성로 560',snapshot,searchMaster});
 assert.deepEqual(matched.data.map(row=>[row.customerCode,row.matchedBy]),[['S970001','ADDRESS']]);
});

test('preparing a private address index coalesces callers and preserves exact matches', async () => {
 const rows=Array.from({length:130},(_,i)=>({customerCode:`S98${String(i).padStart(4,'0')}`,address:`서울 강남구 합성로 ${i+10}`}));
 const snapshot={rows,sourceGeneration:'a'.repeat(64)};
 const preparing=preparePreservedAddressIndex(snapshot);
 assert.equal(preparePreservedAddressIndex(snapshot),preparing);
 await preparing;
 const result=searchPreservedRegistry('서울특별시 강남구 합성로 139',snapshot);
 assert.deepEqual(result.data.map(row=>row.customerCode),['S980129']);
 assert.equal(result.data[0].address,undefined);
});

test('only a verified Stage batch can use preserved address matching without a current source request',async t=>{
 const app=express();let upstream=0;
 const rows=[{customerCode:'S970001',customerName:'합성 A',address:'서울특별시 강남구 합성로 10',lat:37,lng:127},
  {customerCode:'S970002',customerName:'합성 B',address:'서울 강남구 합성로 100',lat:37,lng:127}];
 mountPrivateCustomerSearch({app,allowPreservedBatch:true,
  requireStaff:(req,res,next)=>req.get('x-test-staff')==='1'?next():res.sendStatus(401),
  readSnapshot:async()=>({source:'STAGE_VERIFIED_REGISTRY',rows}),
  searchMaster:async()=>{upstream++;throw Error('HUB_TIMEOUT');}});
 const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const query=(value,headers)=>fetch(`http://127.0.0.1:${server.address().port}/api/map-phase2b/private/customer-search`,
  {headers:{'x-map-customer-query':encodeURIComponent(value),...headers}});
 assert.equal((await query('서울 강남구 합성로10',{'x-map-search-scope':'new-area'})).status,401);
 const auth={'x-test-staff':'1','x-map-search-scope':'new-area'};
 const exact=await query('서울 강남구 합성로10',auth).then(r=>r.json());
 assert.deepEqual(exact.data.map(row=>row.customerCode),['S970001']);
 assert.equal(exact.data[0].address,undefined);
 assert.equal(exact.meta.customerMatchVerified,false);
 const none=await query('서울 강남구 합성로 1',auth).then(r=>r.json());
 assert.deepEqual(none.data,[]);
 assert.equal(none.meta.currentness,'PRESERVED_VALIDATION');
 assert.equal(upstream,0);
 assert.equal((await query('서울 강남구 없는로 3',{'x-test-staff':'1'})).status,503);
 assert.equal(upstream,1);
});
