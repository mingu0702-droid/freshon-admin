import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationalPhotoTaskReader, createOperationalPhotoMetadataReader} from '../src/opsmapOperationalPhotos.js';

const date='2026-11-04', customerCode='S990001';
const task=id=>({id:String(id),customer:{erpCode:customerCode},enteringDatedAt:date+'T00:00:00+09:00'});
const page=(rows,totalElements,totalPages)=>Response.json({data:{content:rows,...(totalElements===undefined?{}:{totalElements,totalPages})}});

test('bounded task reader preserves the existing GET query, validates pagination and forwards its signal',async()=>{
  let calls=0;const external=new AbortController();
  const read=createOperationalPhotoTaskReader({rawRequest:async(path,options)=>{
    const url=new URL(path,'https://synthetic.invalid');
    assert.equal(url.pathname,'/api/bali/task');assert.equal(url.searchParams.get('logisticsCenterId'),'1');assert.equal(url.searchParams.get('pageSize'),'300');
    assert.deepEqual(url.searchParams.getAll('enteringDatedAtBetween'),[date+'T00:00:00+09:00',date+'T00:00:00+09:00']);
    assert.equal(url.searchParams.get('page'),String(calls));assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.equal(options.maxResponseBytes,1048576);assert(options.signal instanceof AbortSignal);assert(options.timeoutMs<=15000);calls++;
    return calls===1?page(Array.from({length:300},(_,i)=>task(i+1)),301,2):page([task(301)],301,2);
  }});
  const rows=await read(date,{signal:external.signal});assert.equal(calls,2);assert.equal(rows.length,301);assert.equal(rows.sourceObservation.complete,true);
});
test('a certified complete empty day is distinct from partial/unknown metadata and a partial matching record',async()=>{
  for(const [response,complete] of [[()=>page([],0,0),true],[()=>page([]),false],[()=>page([task(1)]),false],[()=>page([task(1)],2,1),false]]){
    const read=createOperationalPhotoTaskReader({rawRequest:async()=>response()});const rows=await read(date);assert.equal(rows.sourceObservation.complete,complete);
    const metadata=createOperationalPhotoMetadataReader({readTaskRows:async()=>rows});
    if(rows.length)assert.equal((await metadata({customerCode,date}))[0].deliveryId,'1');
    else if(complete)assert.deepEqual(await metadata({customerCode,date}),[]);
    else await assert.rejects(metadata({customerCode,date}),{code:'SOURCE_UNAVAILABLE'});
  }
  await assert.rejects(createOperationalPhotoMetadataReader({readTaskRows:async()=>[]})({customerCode,date}),{code:'SOURCE_UNAVAILABLE'});
});
test('duplicate IDs, missing/conflicting/wrong dates and malformed page shapes fail closed',async()=>{
  for(const response of [
    ()=>Response.json({content:[task(1)],totalElements:1,totalPages:1,number:1}),
    ()=>page([task(1),task(1)],2,1),
    ()=>page([{...task(1),customer:undefined}],1,1),
    ()=>page([{...task(1),enteringDatedAt:undefined}],1,1),
    ()=>page([{...task(1),carrier:{enteringDatedAt:'2026-11-03'}}],1,1),
    ()=>page([{...task(1),enteringDatedAt:'2026-11-03'}],1,1)
  ])await assert.rejects(createOperationalPhotoTaskReader({rawRequest:async()=>response()})(date),{code:'PHOTO_IDENTITY_UNVERIFIED'});
  await assert.rejects(createOperationalPhotoTaskReader({rawRequest:async()=>Response.json({data:{content:{}}})})(date),{code:'INVALID_PHOTO_RESPONSE'});
});
test('401 does not retry/login; permission and source failures remain separate and bodies are discarded',async()=>{
  for(const [status,code] of [[401,'UPSTREAM_AUTH_REQUIRED'],[403,'PHOTO_FORBIDDEN'],[429,'PHOTO_RATE_LIMITED'],[500,'PHOTO_LOOKUP_FAILED']]){
    let calls=0;const read=createOperationalPhotoTaskReader({rawRequest:async()=>{calls++;return new Response('PRIVATE_SENTINEL',{status});}});
    await assert.rejects(read(date),{code});assert.equal(calls,1);
  }
});
test('the 1 MiB JSON limit covers declared and chunked bodies without retaining error text',async()=>{
  for(const response of [
    ()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'1048577'}}),
    ()=>new Response('x'.repeat(1048577),{headers:{'content-type':'application/json'}})
  ])await assert.rejects(createOperationalPhotoTaskReader({rawRequest:async()=>response()})(date),{code:'PHOTO_JSON_TOO_LARGE'});
});
test('abort stops a noncooperative pending fetch and cancels a late response body without fetching more pages',async()=>{
  let calls=0, observed,resolve,cancelled=false;
  const external=new AbortController(),pending=new Promise(r=>{resolve=r;});
  const read=createOperationalPhotoTaskReader({rawRequest:async(_path,options)=>{calls++;observed=options.signal;return pending;}});
  const result=read(date,{signal:external.signal});await new Promise(r=>setTimeout(r,5));external.abort();
  await assert.rejects(result,{code:'PHOTO_TIMEOUT'});assert.equal(observed.aborted,true);assert.equal(calls,1);
  resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));
  await new Promise(r=>setTimeout(r,5));assert.equal(cancelled,true);assert.equal(calls,1);
});
test('one whole-reader deadline covers multiple pages and a stalled JSON body',async()=>{
  for(const stallBody of [false,true]){
    let calls=0,cancelled=false,observed;
    const read=createOperationalPhotoTaskReader({timeoutMs:30,rawRequest:async(_path,options)=>{
      calls++;observed=options.signal;
      if(calls===1&&!stallBody)return page(Array.from({length:300},(_,i)=>task(i+1)),600,2);
      if(stallBody)return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
      return new Promise(()=>{});
    }});
    const started=Date.now();await assert.rejects(read(date),{code:'PHOTO_TIMEOUT'});assert(Date.now()-started<500);assert(observed.aborted);assert.equal(calls,stallBody?1:2);if(stallBody)assert(cancelled);
  }
});
test('pagination never exceeds twenty pages, retains verified partial matches and never certifies missing totals',async()=>{
  let calls=0;const read=createOperationalPhotoTaskReader({rawRequest:async()=>{
    const base=calls++*300;return page(Array.from({length:300},(_,i)=>task(base+i+1)),9000,30);
  }});
  const rows=await read(date);assert.equal(calls,20);assert.equal(rows.length,6000);assert.equal(rows.sourceObservation.complete,false);
});
