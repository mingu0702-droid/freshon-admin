import test from 'node:test';
import assert from 'node:assert/strict';

for (const modulePath of ['../src/phase2bHubReadClient.js','../src/opsmap-abc/phase2bHubReadClient.js']) {
 test(`${modulePath}: shared status/restore call preserves signed EXEC POST and bounded output GET`,async()=>{
  const saved={fetch:global.fetch,setTimeout:global.setTimeout,url:process.env.HUB_API_URL,secret:process.env.HUB_API_SECRET};
  process.env.HUB_API_URL='https://script.google.com/macros/s/SYNTHETIC_R7/exec';
  process.env.HUB_API_SECRET='synthetic-only-hub-auth-secret-000000000';
  const timers=[],calls=[];
  global.setTimeout=(fn,ms,...args)=>{timers.push(ms);return saved.setTimeout(fn,ms,...args);};
  try {
   const {callHub}=await import(modulePath+'?r7='+Date.now());
   for(const [action,timeout] of [['mapModelStatus',15000],['stageReadModelRequest',30000]]){
    let release;const gate=new Promise(r=>release=r);let postCount=0;
    global.fetch=async(url,opts)=>{
     calls.push({method:opts.method,hasBody:opts.body!==undefined,headers:opts.headers});
     if(opts.method==='POST'){
      postCount++;const request=JSON.parse(opts.body);assert.equal(request.action,action);assert.match(request.auth.signature,/^[A-Za-z0-9_-]+$/);
      await gate;return new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?user_content_key=SYNTHETIC_ONLY'}});
     }
     return new Response(JSON.stringify({ok:true,data:action==='mapModelStatus'?{customer:{},published:null}:{phase:'BUSY'},meta:{httpStatus:200}}),{headers:{'content-type':'application/json'}});
    };
    const a=callHub(action,{}, {useCache:false}),b=callHub(action,{}, {useCache:false});
    assert.equal(postCount,1,'Concurrent UI callers must share the same source operation');release();
    const [one,two]=await Promise.all([a,b]);assert.deepEqual(one,two);assert(timers.includes(timeout));
    assert.deepEqual(calls.splice(0).map(x=>({method:x.method,hasBody:x.hasBody})),[{method:'POST',hasBody:true},{method:'GET',hasBody:false}]);
   }
   let attempts=0;global.fetch=async()=>{attempts++;return new Response(JSON.stringify({ok:false,data:null,error:{code:'BUSY'},meta:{httpStatus:503}}),{status:503,headers:{'content-type':'application/json'}});};
   await assert.rejects(callHub('stageReadModelRequest',{}, {useCache:false}),/HUB_BUSY/);assert.equal(attempts,1,'No automatic duplicate restore request after a failed acknowledgement');
   global.fetch=async()=>new Response(JSON.stringify({ok:true,data:{service:'hub-map-api',status:'UP'},meta:{}}),{headers:{'content-type':'application/json'}});
   await assert.rejects(callHub('mapModelStatus',{}, {useCache:false}),/HUB_INVALID_CONTROL_CONTRACT/);
  } finally {
   global.fetch=saved.fetch;global.setTimeout=saved.setTimeout;
   for(const [key,value] of [['HUB_API_URL',saved.url],['HUB_API_SECRET',saved.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 });
}
