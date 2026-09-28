import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../integrations/hub/HubStaffDetail.js',import.meta.url),'utf8');
function fixture({cached=null,changed=false,partial=false,formatted=false}={}){
 let batch=0,full=0,dateCells=0;const cachedValues=[];
 const headers=['deliveryDate','customerCode','accessMemo'];
 const sheet={getLastRow:()=>101,getLastColumn:()=>3,getParent:()=>({getId:()=> 'source'}),getSheetId:()=>1,getRange(row,col,count,width){
  return{getValues(){if(row===1)return[headers];if(width===1){dateCells++;throw Error('N_PLUS_ONE');}full++;return[['2026-09-19',changed?'S2':'S1','synthetic private memo']];},createTextFinder:()=>({matchEntireCell(){return this;},useRegularExpression(){return this;},findAll:()=>Array.from({length:90},(_,i)=>({getRow:()=>i+2}))})};}};
 const ctx=vm.createContext({Date,JSON,hubStaffHistoryDate_:v=>v==='2026. 9. 19'?'2026-09-19':v,CacheService:{getScriptCache:()=>({get:()=>cached?JSON.stringify(cached):null,remove(){},put:(_k,v)=>cachedValues.push(v)})},hubStaffHistoryBatchRead_:(_id,_sheet,cols,positions,requested)=>{batch++;assert.deepEqual(Array.from(requested),['deliveryDate','customerCode']);return positions.slice(0,partial?-1:undefined).map((_,i)=>({deliveryDate:i===89?(formatted?'2026. 9. 19':'2026-09-19'):'2026-09-18',customerCode:'S1'}));}});
 vm.runInContext(source,ctx);const profile={lookupMs:0,rowReadMs:0,sourceRowReads:0};
 return{run:()=>ctx.hubStaffDetailRow_(sheet,'S1','2026-09-19',profile),get metrics(){return{batch,full,dateCells};},cachedValues,profile};
}
test('90 candidate dates use one bounded metadata batch and one fresh protected row',()=>{const f=fixture();assert.equal(f.run().customerCode,'S1');assert.deepEqual(f.metrics,{batch:1,full:1,dateCells:0});assert.equal(f.cachedValues.length,1);assert(!f.cachedValues[0].includes('memo'));});
test('valid cached locator still reads fresh private row, never memo cache',()=>{const f=fixture({cached:{row:5}});f.run();assert.deepEqual(f.metrics,{batch:0,full:1,dateCells:0});assert.equal(f.profile.metadataHit,true);});
test('source changed after metadata selection cannot leak another customer',()=>{const f=fixture({changed:true});assert.equal(f.run(),null);assert.equal(f.cachedValues.length,0);});
test('incomplete candidate metadata fails before private row read',()=>{const f=fixture({partial:true});assert.throws(f.run,/PRIVATE_LOOKUP_INCOMPLETE/);assert.equal(f.metrics.full,0);});
test('formatted Sheet date uses existing strict history date normalization',()=>{const f=fixture({formatted:true});assert.equal(f.run().customerCode,'S1');assert.equal(f.metrics.full,1);});
