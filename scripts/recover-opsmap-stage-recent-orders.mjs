import {open} from 'node:fs/promises';
import path from 'node:path';
import {createStageRecentOperationsStore,recentOperationsKey,recoverSealedRecentOrders} from '../src/stageRecentOperations.js';

const [date,mode,filename,...extra]=process.argv.slice(2);
const env=process.env;
try {
  const approvedDate=env.OPSMAP_STAGE_RECENT_OPERATIONS_ORDER_ARCHIVE_DATE;
  const approvedSha256=env.OPSMAP_STAGE_RECENT_OPERATIONS_ORDER_ARCHIVE_SHA256;
  if (date!==approvedDate||!['--preview','--publish'].includes(mode)||!filename||!path.isAbsolute(filename)||extra.length) {
    throw Error('RECENT_OPERATIONS_RECOVERY_SCOPE');
  }
  const publish=mode==='--publish';
  const result=await recoverSealedRecentOrders({
    store:createStageRecentOperationsStore({env,write:publish,withSha:true}),
    date,approvedDate,approvedSha256,publish,key:recentOperationsKey(env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64),
    async readArchive() {
      const file=await open(filename,'r');
      try {
        const {size}=await file.stat();
        if(!size||size>4*1024*1024+1024)throw Error('RECENT_OPERATIONS_EVIDENCE_INVALID');
        const bytes=Buffer.alloc(size+1);
        let offset=0;
        while(offset<bytes.length) {
          const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);
          if(!bytesRead)break;
          offset+=bytesRead;
        }
        if(offset!==size)throw Error('RECENT_OPERATIONS_EVIDENCE_INVALID');
        return bytes.subarray(0,offset);
      } finally {await file.close();}
    }
  });
  console.log(JSON.stringify(result));
  if(result.state==='BUSY')process.exitCode=1;
} catch(error) {
  const code=error.code||error.message;
  console.error(/^(?:RECENT_OPERATIONS|FIXED_STORE)_[A-Z_]+$/.test(code??'')?code:'RECENT_OPERATIONS_RECOVERY_FAILED');
  process.exitCode=1;
}
