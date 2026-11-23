import {createStageWmsDispatchExportReader} from '../src/opsmapWmsDispatchExport.js';
import {createStageRecentOperationsStore,recoverArchivedOsanDispatch} from '../src/stageRecentOperations.js';

const [date,mode,...rest]=process.argv.slice(2);
const env=process.env;
try {
  const approvedDate=env.OPSMAP_STAGE_RECENT_OPERATIONS_WMS_RECOVERY_DATE;
  if (date!==approvedDate || !['--preview','--publish'].includes(mode) || rest.length ||
      !/^[a-f0-9]{40}$/.test(env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF??'')) {
    throw Error('RECENT_OPERATIONS_RECOVERY_SCOPE');
  }
  const publish=mode==='--publish';
  const store=createStageRecentOperationsStore({env,write:publish,withSha:true});
  const readArchive=createStageWmsDispatchExportReader({env});
  if (!store || readArchive.configurationFailure(date)) throw Error('RECENT_OPERATIONS_RECOVERY_SCOPE');
  const result=await recoverArchivedOsanDispatch({store,readArchive,date,approvedDate,publish});
  console.log(JSON.stringify(result));
  if (result.state==='BUSY') process.exitCode=1;
} catch (error) {
  const code=error.code||error.message;
  console.error(/^(?:RECENT_OPERATIONS|FIXED_STORE|WMS_EXPORT)_[A-Z_]+$/.test(code??'') ?
    code:'RECENT_OPERATIONS_RECOVERY_FAILED');
  process.exitCode=1;
}
