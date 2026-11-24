import {createStageFixedMasterSource,stageFixedMasterBaseline,stageFixedMasterStorage,
  syncStageFixedMaster} from './stageFixedMasterSync.js';
import {createStageFixedMasterExcelSource} from './stageFixedMasterExcel.js';

export async function runStageFixedMaster({env=process.env,receipt,scope,skipRefresh,log=console.info}) {
  if(!scope) throw Error('FIXED_MASTER_DAILY_SCOPE_UNAVAILABLE');
  const store=stageFixedMasterStorage({env,write:true}),baseline=stageFixedMasterBaseline({env,store});
  const emit=(component,evidence)=>log(JSON.stringify({component,runId:receipt.runId,...evidence}));
  const readMaster=env.OPSMAP_STAGE_FIXED_MASTER_SOURCE==='pages' ?
    createStageFixedMasterSource({env,onScan:e=>emit('opsmap-fixed-master-pages',e),
      onPage:e=>emit('opsmap-fixed-master-page-progress',e)}) :
    createStageFixedMasterExcelSource({env,onCenter:({center,sourceRows})=>
      emit('opsmap-fixed-master-excel-center',{center,sourceRows})});
  const result=await syncStageFixedMaster({store,receipt,scope,readMaster,loadBaseline:baseline.load,skipRefresh});
  emit('opsmap-fixed-master-sync',result);
  return result;
}
