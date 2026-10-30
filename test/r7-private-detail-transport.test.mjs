import test from 'node:test';import assert from 'node:assert/strict';

for(const modulePath of ['../src/phase2bHubReadClient.js','../src/opsmap-abc/phase2bHubReadClient.js'])test(`${modulePath}: protected reads bound bytes, distinguish source errors, cancel without session/circuit side effects`,async()=>{
 const saved={fetch:global.fetch,info:console.info,warn:console.warn,url:process.env.HUB_API_URL,secret:process.env.HUB_API_SECRET};
 process.env.HUB_API_URL='https://script.google.com/macros/s/SYNTHETIC_ONLY/exec';process.env.HUB_API_SECRET='synthetic-secret-for-transport-fixture-only';
 const log=[];console.info=console.warn=(...args)=>log.push(args.join(' '));
 try{
  const mod=await import(modulePath+'?private-boundary='+Date.now());
  const params={customerCode:'S970001',date:'2026-10-23'},options={useCache:false,privateRead:true};
  let calls=0;
  global.fetch=async()=>{calls++;return new Response(JSON.stringify({ok:false,data:null,error:{code:'INTERNAL_ERROR'},meta:{httpStatus:500}}),{status:500});};
  await assert.rejects(mod.callHub('staffCustomerDetail',params,options),/HUB_INTERNAL_ERROR/);assert.equal(calls,1,'Protected reads must not retry hidden behind a UI retry');
  global.fetch=async()=>new Response(JSON.stringify({ok:false,data:null,error:{code:'NOT_FOUND'},meta:{httpStatus:404}}));
  let notFound;try{await mod.callHub('staffCustomerDetail',params,options);}catch(e){notFound=e;}
  assert.equal(notFound.upstreamStatus,404);assert.equal(mod.hubRequestProfile(notFound).upstreamStatus,200);assert.equal(mod.hubRequestProfile(notFound).action,'staffCustomerDetail');
  global.fetch=async()=>new Response(JSON.stringify({ok:false,data:null,error:{code:'AUTH_FAILED'},meta:{httpStatus:401}}));
  await assert.rejects(mod.callHub('staffCustomerDetail',params,options),e=>e.failureType==='auth'&&e.upstreamStatus===401);
  global.fetch=async(_url,opts)=>{const request=JSON.parse(opts.body);return new Response(JSON.stringify({ok:true,data:{customerCode:params.customerCode,accessMemo:'SYNTHETIC_PRIVATE_VALUE'+ 'x'.repeat(70000)},meta:{requestId:request.requestId}}));};
  await assert.rejects(mod.callHub('staffCustomerDetail',params,options),/HUB_RESPONSE_TOO_LARGE/);
  const before=mod.hubMetrics(),caller=new AbortController();
  global.fetch=async(_url,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true}));
  const pending=mod.callHub('staffCustomerDetail',params,{...options,signal:caller.signal});caller.abort();
  let cancelled;try{await pending;}catch(e){cancelled=e;}
  assert.equal(mod.hubRequestProfile(cancelled).cancelledBy,'CALLER');assert.equal(mod.classifyHubFailure(cancelled),'cancelled');
  const after=mod.hubMetrics();assert.equal(after.timeout,before.timeout);assert.equal(after.error,before.error);assert.equal(after.circuits.staffCustomerDetail.failures,before.circuits.staffCustomerDetail.failures);
  let lateCalls=0;global.fetch=async(_url,opts)=>{lateCalls++;const request=JSON.parse(opts.body);await new Promise(r=>setTimeout(r,25));return new Response(JSON.stringify({ok:true,data:{customerCode:params.customerCode,accessMemo:'SYNTHETIC_PRIVATE_VALUE'},meta:{requestId:request.requestId}}));};
  let late;try{await mod.callHub('staffCustomerDetail',params,{...options,deadline:Date.now()+5});}catch(e){late=e;}
  assert.equal(late.name,'AbortError');assert.equal(mod.hubRequestProfile(late).cancelledBy,'DEADLINE');assert.equal(lateCalls,1);
  assert.equal(log.some(x=>x.includes('SYNTHETIC_PRIVATE_VALUE')),false,'Safe profiles must not contain protected response values');
 }finally{
  global.fetch=saved.fetch;console.info=saved.info;console.warn=saved.warn;
  for(const [key,value] of [['HUB_API_URL',saved.url],['HUB_API_SECRET',saved.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
