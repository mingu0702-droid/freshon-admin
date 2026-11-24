import {open} from 'node:fs/promises';
import path from 'node:path';
import {createStageWmsDispatchExportReader} from '../src/opsmapWmsDispatchExport.js';
import {createStageRecentOperationsStore,recoverArchivedOsanDispatch} from '../src/stageRecentOperations.js';

const [date,mode,...rest]=process.argv.slice(2);
const env=process.env;
async function readWorkbook(filename) {
  const maxBytes=4*1024*1024;
  const file=await open(filename,'r');
  try {
    const {size}=await file.stat();
    if (!size || size>maxBytes) throw Error('WMS_EXPORT_WORKBOOK_INVALID');
    const bytes=Buffer.alloc(size+1);
    let offset=0;
    while (offset<bytes.length) {
      const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);
      if (!bytesRead) break;
      offset+=bytesRead;
    }
    if (offset!==size) throw Error('WMS_EXPORT_WORKBOOK_INVALID');
    return bytes.subarray(0,offset);
  } finally {await file.close();}
}

try {
  const approvedDate=env.OPSMAP_STAGE_RECENT_OPERATIONS_WMS_RECOVERY_DATE;
  const workbook=rest.length===2&&rest[0]==='--workbook'&&path.isAbsolute(rest[1])?rest[1]:null;
  if (date!==approvedDate || !['--preview','--publish'].includes(mode) || rest.length&&!workbook ||
      !/^[a-f0-9]{40}$/.test(env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF??'')) {
    throw Error('RECENT_OPERATIONS_RECOVERY_SCOPE');
  }
  const publish=mode==='--publish';
  const store=createStageRecentOperationsStore({env,write:publish,withSha:true});
  const exportReader=createStageWmsDispatchExportReader({env});
  if (!store || exportReader.recoveryConfigurationFailure(date,{workbook:Boolean(workbook)})) {
    throw Error('RECENT_OPERATIONS_RECOVERY_SCOPE');
  }
  const readArchive=workbook?async selected=>exportReader.verifyWorkbook(selected,await readWorkbook(workbook)):exportReader;
  const result=await recoverArchivedOsanDispatch({store,readArchive,date,approvedDate,publish});
  console.log(JSON.stringify(result));
  if (result.state==='BUSY') process.exitCode=1;
} catch (error) {
  const code=error.code||error.message;
  console.error(/^(?:RECENT_OPERATIONS|FIXED_STORE|WMS_EXPORT)_[A-Z_]+$/.test(code??'') ?
    code:'RECENT_OPERATIONS_RECOVERY_FAILED');
  process.exitCode=1;
}
