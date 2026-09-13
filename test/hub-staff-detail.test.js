import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../integrations/hub/HubStaffDetail.js',import.meta.url),'utf8');
function fixture(){
 const data=[['deliveryDate','customerCode','customerName','customerAddress','accessMemo'],
 ['2026-08-27','S1234','Synthetic','Test','old'],
 ['2026-08-28','S9999','Synthetic','Test','OTHER_SECRET'],
 ['2026-08-28','S1234','Synthetic','Test','SYNTHETIC_MEMO']];
 const cache=new Map(),reads=[];
 const sheet={getLastRow:()=>data.length,getLastColumn:()=>5,getParent:()=>({getId:()=> 'CURRENT'}),getSheetId:()=>1,
 getRange:(row,col,rows,cols)=>({
   getValues:()=>{assert.ok(rows===1||cols===1,'never read many full rows');reads.push({row,col,rows,cols});return data.slice(row-1,row-1+rows).map(r=>r.slice(col-1,col-1+cols));},
   createTextFinder:needle=>{const finder={matchEntireCell:()=>finder,useRegularExpression:()=>finder,findAll:()=>data.map((r,i)=>i+1>=row&&i+1<row+rows&&r[col-1]===needle?{getRow:()=>i+1}:null).filter(Boolean)};return finder;}
 })};
 const context=vm.createContext({Date,Number,String,JSON,Object,Math,Error,HUB_DEFAULT_SOURCE_ID:'CURRENT',
 SpreadsheetApp:{openById:()=>({getSheetByName:()=>sheet})},
 CacheService:{getScriptCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k)})},
 hubMapHttpValidateOnlyKeys_:()=>{},hubMapHttpCustomerCode_:x=>x,hubMapHttpDate_:x=>x,
 hubMapHttpRaise_:code=>{throw new Error(code);}
 });vm.runInContext(source,context);return{context,data,cache,reads};
}
test('private detail reads one matching customer row, caches coordinates only, and rereads changed memo',()=>{
 const f=fixture(),p={customerCode:'S1234',date:'2026-08-28'};
 const first=f.context.hubStaffCustomerDetail_(p);
 assert.equal(first.data.customerCode,'S1234');assert.equal(first.data.accessMemo,'SYNTHETIC_MEMO');
 assert.equal(first.meta.privateCache,'NONE');assert.equal(first.meta.detailProfile.sourceRowReads,1);
 for(const value of f.cache.values())assert.deepEqual(Object.keys(JSON.parse(value)),['row']);
 f.data[3][4]='SYNTHETIC_CHANGED';
 const second=f.context.hubStaffCustomerDetail_(p);
 assert.equal(second.data.accessMemo,'SYNTHETIC_CHANGED');assert.equal(second.meta.detailProfile.metadataHit,true);
 assert.ok(!JSON.stringify([...f.cache.values()]).includes('SYNTHETIC'));
});
test('stale row locator never returns a different customer after source rows move',()=>{
 const f=fixture(),p={customerCode:'S1234',date:'2026-08-28'};
 f.context.hubStaffCustomerDetail_(p);
 [f.data[2],f.data[3]]=[f.data[3],f.data[2]];
 const found=f.context.hubStaffCustomerDetail_(p);
 assert.equal(found.data.customerCode,'S1234');assert.equal(found.data.accessMemo,'SYNTHETIC_MEMO');
 assert.throws(()=>f.context.hubStaffCustomerDetail_({customerCode:'S0000',date:p.date}),/NOT_FOUND/);
});
test('staff UI resolves login before detail, uses modeless reads, and no post-detail session round trip',()=>{
 const ui=fs.readFileSync(new URL('../public/map-staff.js',import.meta.url),'utf8');
 assert.ok(ui.includes('void showRequested(id)'));assert.ok(!ui.includes('await showRequested(id)'));
 assert.ok(ui.includes('else dialog.show()'));assert.ok(ui.includes('detailPending &&'));
 const detail=ui.slice(ui.indexOf('async function showRequested'),ui.indexOf('async function open'));
 assert.ok(!detail.includes("request('auth/session')"));
 assert.ok(!/localStorage|sessionStorage/.test(ui));
});
