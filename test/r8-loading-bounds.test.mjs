import test from 'node:test';import assert from 'node:assert/strict';
for(const modulePath of ['../src/phase2bHubReadClient.js','../src/opsmap-abc/phase2bHubReadClient.js'])test(modulePath+' deduplicates only same unbound map reads, without caching forced fresh results',async()=>{
 const previous={url:process.env.HUB_API_URL,secret:process.env.HUB_API_SECRET,fetch:globalThis.fetch};
 process.env.HUB_API_URL='https://script.google.com/macros/s/SYNTHETIC_ONLY/exec';process.env.HUB_API_SECRET='synthetic-test-hmac-only-not-a-real-key';
 const pending=[],calls=[];
 globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return new Promise(resolve=>pending.push((ok=true)=>resolve({ok:true,status:200,text:async()=>JSON.stringify({ok,data:[],meta:{requestId:body.requestId,httpStatus:ok?200:404,durationMs:0},error:ok?null:{code:'NOT_FOUND'}})})));};
 try{
  const {callHub}=await import(modulePath+'?r8-test='+Date.now()),params={mode:'DATE_ROUTE',date:'2026-10-31',vehicle:'101',bounds:{south:37,west:126,north:38,east:127},limit:2000};
  const a=callHub('mapBounds',params,{useCache:false}),b=callHub('mapBounds',params,{useCache:false});assert.equal(calls.length,1);pending.shift()();assert.deepEqual(await a,await b);
  const c=callHub('mapBounds',params,{useCache:false});assert.equal(calls.length,2);pending.shift()();await c;
  const d=callHub('mapBounds',params,{useCache:false}),e=callHub('mapBounds',{...params,date:'2026-11-02'},{useCache:false});assert.equal(calls.length,4);pending.shift()();pending.shift()();await Promise.all([d,e]);
  const f=callHub('mapBounds',params,{useCache:false,signal:new AbortController().signal}),g=callHub('mapBounds',params,{useCache:false,signal:new AbortController().signal});assert.equal(calls.length,6);pending.shift()();pending.shift()();await Promise.all([f,g]);
  const h=callHub('mapBounds',params,{useCache:false}),i=callHub('mapBounds',params,{useCache:false});const failed=Promise.all([assert.rejects(h,/HUB_NOT_FOUND/),assert.rejects(i,/HUB_NOT_FOUND/)]);pending.shift()(false);await failed;
  const j=callHub('mapBounds',params,{useCache:false});assert.equal(calls.length,8);pending.shift()();await j;
 }finally{
  globalThis.fetch=previous.fetch;if(previous.url===undefined)delete process.env.HUB_API_URL;else process.env.HUB_API_URL=previous.url;if(previous.secret===undefined)delete process.env.HUB_API_SECRET;else process.env.HUB_API_SECRET=previous.secret;
 }
});
