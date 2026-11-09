import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {MAX_STAGE_BUNDLE_BYTES,STAGE_ORIGIN,STAGE_SERVICE} from './stageAbValidation.js';

const file='/var/data/opsmap-stage/verified-generation-v1.json.gz';

async function openApprovedFile() {
  if (await realpath(file)!==file) throw Error('STAGE_GENERATION_PATH');
  return open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
}

// A read-only follower. The publisher, source credentials and mount require
// separate owner configuration. A failed read cannot replace a verified bundle.
export function createStageGenerationRestore({env,validation,openFile=openApprovedFile,now=Date.now}) {
  const enabled=env.RENDER_SERVICE_ID===STAGE_SERVICE && env.RENDER_EXTERNAL_URL===STAGE_ORIGIN &&
    env.OPSMAP_STAGE_APPROVED_GENERATION_FILE==='1';
  let attemptAt=null, verifiedAt=null, signature, flight, failures=0;
  let state=enabled?'PENDING':'NOT_CONFIGURED', nextCheck=0;
  const status=()=>({state,lastAttemptAt:attemptAt,lastVerifiedAt:verifiedAt});
  function refresh() {
    if (!enabled||now()<nextCheck) return Promise.resolve(status());
    flight??=(async()=>{
      attemptAt=new Date(now()).toISOString();
      const handle=await openFile();
      try {
        const stat=await handle.stat();
        if(!stat.isFile()||stat.size<1||stat.size>MAX_STAGE_BUNDLE_BYTES||(stat.mode&0o077)!==0) throw Error('STAGE_GENERATION_FILE');
        const key=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
        if (key!==signature) {
          const bytes=Buffer.alloc(stat.size);
          for (let at=0;at<bytes.length;) {
            const {bytesRead}=await handle.read(bytes,at,bytes.length-at,at);
            if (!bytesRead) throw Error('STAGE_GENERATION_INCOMPLETE');
            at+=bytesRead;
          }
          const end=await handle.stat();
          if ([end.dev,end.ino,end.size,end.mtimeMs,end.ctimeMs].join(':')!==key) throw Error('STAGE_GENERATION_CHANGED');
          await validation.activate(bytes,{durableRead:true});
          signature=key;
          verifiedAt=new Date(now()).toISOString();
        }
        failures=0;state='VERIFIED';nextCheck=now()+60_000;
      } finally {await handle.close();}
    })().catch(()=>{
      state=verifiedAt?'LAST_VERIFIED_RETAINED':'UNAVAILABLE';
      nextCheck=now()+Math.min(300_000,30_000*2**Math.min(failures++,4));
    }).then(status).finally(()=>{flight=null;});
    return flight;
  }
  return {refresh,status};
}
