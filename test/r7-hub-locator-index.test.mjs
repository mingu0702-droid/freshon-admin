import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../integrations/hub/r7/HubStaffDetail.locator-index-candidate.js',import.meta.url),'utf8');
function fixture(){
 const cache=new Map(),rows=new Map([[10,['S970001','2026-10-22','SYNTHETIC_ONLY_OLD']],[12,['S970001','2026-10-23','SYNTHETIC_ONLY_NEW']]]);let positions=[10,12],finds=0,batches=0,reads=0,batchError=null;
 const store={get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k)};
 const sheet={getLastRow:()=>1000,getLastColumn:()=>3,getSheetId:()=>1,getParent:()=>({getId:()=> 'SYNTHETIC_SHEET'}),getRange:(r,c,n,w)=>({getValues:()=>{if(r===1)return [['customerCode','deliveryDate','accessMemo']];reads++;return [rows.get(r)||['OTHER','2026-10-23','MUST_NOT_LEAK']];},createTextFinder:()=>({matchEntireCell(){return this;},useRegularExpression(){return this;},findAll(){finds++;return positions.map(row=>({getRow:()=>row}));}})})};
 const key=(name,params)=>name+':'+JSON.stringify(params),context=vm.createContext({CacheService:{getScriptCache:()=>store},hubDataCacheKey_:key,hubStaffDetailDate_:v=>String(v).slice(0,10),hubStaffHistoryDate_:v=>String(v).slice(0,10),hubStaffHistoryBatchRead_:(_id,_sheet,_headers,ids,requested)=>{batches++;assert.deepEqual([...requested],['customerCode','deliveryDate']);if(batchError)throw batchError;return ids.map(row=>({customerCode:rows.get(row)?.[0]||'OTHER',deliveryDate:rows.get(row)?.[1]||'2026-10-23'}));}});vm.runInContext(source,context);
 return {cache,rows,call:()=>{const profile={rowReadMs:0,sourceRowReads:0,lookupMs:0};const result=context.hubStaffDetailRow_(sheet,'S970001','2026-10-23',profile);return {result,profile};},setPositions:v=>positions=v,setError:v=>batchError=v,counts:()=>({finds,batches,reads})};
}
test('cold lookup stores locator metadata only and warm selected row remains freshly read',()=>{
 const f=fixture();assert.equal(f.call().result.accessMemo,'SYNTHETIC_ONLY_NEW');f.rows.get(12)[2]='SYNTHETIC_ONLY_UPDATED';assert.equal(f.call().result.accessMemo,'SYNTHETIC_ONLY_UPDATED');assert.deepEqual(f.counts(),{finds:1,batches:1,reads:2});assert([...f.cache.values()].every(v=>!v.includes('SYNTHETIC_ONLY')));
});
test('failed sparse read is not retried; next independent request reuses existing locator cache',()=>{
 const f=fixture();f.setError(Error('SYNTHETIC_SOURCE_FAILURE'));assert.throws(f.call,/SYNTHETIC_SOURCE_FAILURE/);assert.deepEqual(f.counts(),{finds:1,batches:1,reads:0});f.setError(null);const value=f.call();assert.equal(value.result.accessMemo,'SYNTHETIC_ONLY_NEW');assert.equal(value.profile.candidateIndexHit,true);assert.deepEqual(f.counts(),{finds:1,batches:2,reads:1});
});
test('stale cached index cannot certify absence after in-place customer move',()=>{
 const f=fixture();f.setError(Error('SYNTHETIC_SOURCE_FAILURE'));assert.throws(f.call);f.setError(null);f.rows.delete(12);f.rows.set(14,['S970001','2026-10-23','SYNTHETIC_MOVED']);f.setPositions([10,14]);assert.equal(f.call().result.accessMemo,'SYNTHETIC_MOVED');assert.equal(f.counts().finds,2);assert.equal(f.counts().batches,3);
});
test('invalid row locator and candidate limit preserve existing safeguards',()=>{
 const f=fixture();f.setPositions(Array.from({length:101},(_,i)=>i+2));assert.throws(f.call,/HUB_STAFF_DETAIL_LOOKUP_LIMIT/);assert.equal(f.counts().batches,0);assert.equal(f.counts().reads,0);
});
test('missing target stays absent without negative cache or fabricated memo',()=>{
 const f=fixture();f.setPositions([10]);assert.equal(f.call().result,null);assert.equal([...f.cache.keys()].length,0);assert.equal(f.counts().batches,1);
});
