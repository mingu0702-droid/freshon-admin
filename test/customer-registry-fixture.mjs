import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const originalDate=Date;
export const fixtureTime='2026-11-04T00:00:00.000Z';
export function registryFixture({rows,lifecycleField=null}={}){
 let stamp=Date.parse(fixtureTime),afterRead=null;
 const data=rows||[
  ['S970001','합성 A','서울 합성로 1','DO_NOT_READ',37,127,'DO_NOT_READ','2026-11-03T00:00:00.000Z',false,'DO_NOT_READ'],
  ['S970002','합성 B','서울 합성로 2','DO_NOT_READ',37,127,'DO_NOT_READ',fixtureTime,false,'DO_NOT_READ'],
  ['S970001','합성 최신 A','서울 합성로 11','DO_NOT_READ',37,127,'DO_NOT_READ',fixtureTime,false,'DO_NOT_READ'],
  ['S970003','합성 C','서울 합성로 3','DO_NOT_READ',37,127,'DO_NOT_READ',fixtureTime,false,'DO_NOT_READ']
 ];
 const headers=['customerCode','customerName','customerAddress','detailAddress','lat','lng','accessMemo','updatedAt','isDeleted','phone'],cache=new Map(),reads=[];
 const props={PROTECTED_CUSTOMER_ID:'SYNTHETIC_CUSTOMER_METADATA',HUB_MAP_API_HMAC_SECRET:'SYNTHETIC_HMAC_SECRET_0000000000000000',...(lifecycleField?{PROTECTED_CUSTOMER_LIFECYCLE_FIELD:lifecycleField}:{})};
 const get=key=>{const v=cache.get(key);return v&&v.expiresAt>stamp?v.value:null;};
 const userCache={get,getAll:keys=>Object.fromEntries(keys.map(k=>[k,get(k)]).filter(([,v])=>v!==null)),put:(k,value,ttl)=>cache.set(k,{value,expiresAt:stamp+ttl*1000}),putAll:(values,ttl)=>Object.entries(values).forEach(([k,value])=>cache.set(k,{value,expiresAt:stamp+ttl*1000}))};
 const column=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
 function values(range){
  reads.push(range);if(range==="'customers'!1:1")return [headers];
  const m=range.match(/^'customers'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);assert(m,range);assert.equal(m[1],m[3]);const col=column(m[1]);
  assert([0,1,2,7,...(lifecycleField?[8]:[])].includes(col),'private value columns must never be read: '+range);
  const result=data.slice(+m[2]-2,+m[4]-1).map(row=>row[col]==null?[]:[row[col]]);while(result.length&&(!result.at(-1).length||result.at(-1)[0]===''))result.pop();return structuredClone(result);
 }
 class TestDate extends originalDate{static now(){return stamp;}}
 const context=vm.createContext({Date:TestDate,Map,Set,JSON,String,Number,Math,isFinite,PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null})},CacheService:{getUserCache:()=>userCache,getScriptCache:()=>assert.fail('bulk index must not use HMAC nonce/rate-limit ScriptCache')},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_algorithm,value)=>[...crypto.createHash('sha256').update(value).digest()]},HUB_MAP_HTTP_API:{SECRET_PROPERTY:'HUB_MAP_API_HMAC_SECRET'},hubMapHttpHmac_:(body,secret)=>crypto.createHmac('sha256',secret).update(body).digest('base64url'),hubMapHttpConstantTimeEqual_:(a,b)=>a===b,protectedReaderProfile_:{},Sheets:{Spreadsheets:{get:()=>({sheets:[{properties:{title:'customers',gridProperties:{columnCount:headers.length,rowCount:Math.max(1000,data.length+2)}}}]}),Values:{get:(_id,range)=>({values:values(range)}),batchGet:(_id,{ranges})=>{const result={valueRanges:ranges.map(range=>({range,values:values(range)}))};if(afterRead&&ranges.some(r=>/'!B\d+/.test(r))){const fn=afterRead;afterRead=null;fn();}return result;}}}}});
 for(const file of ['CustomerSearch.js','CustomerRegistry.js'])vm.runInContext(fs.readFileSync(new URL('../integrations/hub/protected-reader/'+file,import.meta.url),'utf8'),context);
 return {data,props,reads,cache,context,tick:(ms=60001)=>{stamp+=ms;},now:()=>stamp,afterPrivateRead:fn=>{afterRead=fn;},feed:(params={})=>JSON.parse(JSON.stringify(context.protectedReaderRegistry_(params))),readPage:async params=>({ok:true,data:JSON.parse(JSON.stringify(context.protectedReaderRegistry_(params)))})};
}
