// One-time migration of the already verified Production projection into the
// existing private cache repository. No raw payload or credentials on disk/logs.
import {execFileSync} from 'node:child_process';
import {createFixedVehicleStore,fixedEnvelope} from '../src/fixedVehicleStore.js';
try {
  const response=await fetch('https://freshon-admin-1.onrender.com/api/map-phase2b/preview/base-vehicles');
  const payload=await response.json();
  if(response.status!==200){console.log(JSON.stringify({http:response.status,phase:payload.phase,progress:payload.progress}));process.exitCode=2;}
  else {
    if(payload.meta?.basis!=='FIXED_DISPATCH_PRIMARY'||payload.meta?.read?.readHttp!==200||payload.data?.length!==87972||payload.meta.read.sourceRows!==87982)throw Error('BASELINE_MISMATCH');
    const envelope=fixedEnvelope(payload.data,payload.meta.checkedAt);
    const auth=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',stdio:['pipe','pipe','pipe']});
    const token=auth.split('\n').find(line=>line.startsWith('password='))?.slice(9);
    const store=createFixedVehicleStore({env:{GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:token}});
    await store.save(envelope);const verified=await store.load();
    console.log(JSON.stringify({http:200,privateStore:'VERIFIED',count:verified.count,checkedAt:verified.checkedAt,integrity:verified.version===envelope.version,S99731:verified.rows.find(r=>r[0]==='S99731')?.[1],sourcePayloadSaved:false}));
  }
}catch(e){console.log(JSON.stringify({error:/^(FIXED_STORE_[A-Z_]+|BASELINE_MISMATCH)$/.test(e.code||e.message)?e.code||e.message:'PRESERVE_FAILED'}));process.exitCode=1;}
