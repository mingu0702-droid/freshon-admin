// Read-only benchmark of the private minimal projection. No source calls,
// leases, writes, collectors, model recovery or source payload logging.
import {execFileSync} from 'node:child_process';
import express from 'express';
import {createFixedVehicleStore} from '../src/fixedVehicleStore.js';
import {createFixedVehicleCache} from '../src/fixedVehicleCache.js';
try {
 const raw=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',stdio:['pipe','pipe','pipe']});
 const token=raw.split('\n').find(x=>x.startsWith('password='))?.slice(9);
 const remote=createFixedVehicleStore({env:{GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:token}});
 const begin=performance.now();const saved=await remote.load();if(!saved)throw Error('NO_VERIFIED_COPY');
 const durableMs=Math.round(performance.now()-begin);let sourceCalls=0;
 const store={load:()=>remote.load(),acquire:async()=>false};
 const now=process.argv.includes('--expired')?()=>Date.parse(saved.checkedAt)+1800001:()=>Date.parse(saved.checkedAt)+1000;
 const api=createFixedVehicleCache({store,now,reader:async()=>{sourceCalls++;throw Error('SOURCE_FORBIDDEN');}});
 const app=express();app.use(express.json({limit:'128kb'}));app.post('/base',async(q,r)=>r.json(await api.get(q.body.codes)));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const timings=[];let result;
 for(let i=0;i<3;i++){const t=performance.now();const r=await fetch(`http://127.0.0.1:${server.address().port}/base`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({codes:['S99731']})});result=await r.json();timings.push(Math.round((performance.now()-t)*10)/10);}
 await new Promise(r=>server.close(r));
 console.log(JSON.stringify({mode:process.argv.includes('--expired')?'EXPIRED_COLD_PROCESS':'COLD_PROCESS_AND_RECONNECT',durableMs,apiMs:timings,verifiedRows:saved.count,S99731:result.data[0].baseVehicle,stale:result.meta.stale,checkedAt:result.meta.checkedAt,sourceCalls,remoteWrites:0}));
}catch{console.log(JSON.stringify({error:'BENCHMARK_NOT_READY'}));process.exitCode=1;}
