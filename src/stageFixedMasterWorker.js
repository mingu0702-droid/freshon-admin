import {createStageFixedMasterSource,stageFixedMasterBaseline,stageFixedMasterStorage,
  syncStageFixedMaster} from './stageFixedMasterSync.js';
import {createStageFixedMasterExcelSource} from './stageFixedMasterExcel.js';

const centerByGroup={osan:'011',yeongnam:'012',honam:'013'};
function diagnostic(code,details={}){
  const center=details.center??centerByGroup[details.group];
  const validRow=value=>Number.isSafeInteger(value)&&value>0&&value<=120001;
  return {
    code:/^FIXED_(?:MASTER|STORE)_[A-Z_]{1,70}$/.test(code??'')?code:'FIXED_MASTER_DAILY_FAILED',
    phase:/^[A-Z_]{1,30}$/.test(details.phase??'')?details.phase:'SOURCE_READ',
    ...(['011','012','013'].includes(center)?{center}:{}),
    ...(validRow(details.row)?{worksheetRow:details.row}:validRow(details.rowIndex+1)?{projectionRow:details.rowIndex+1}:{}),
    ...(/^(?:estCd|logCd|totalCnt|mainCarSeqNm|carSeq(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)Nm|customerCode|baseVehicle(?:Group|State|EmptyVerified)?|checkedAt|row|rows|weekdays(?:\.(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?)$/.test(details.field??'')?
      {field:details.field}:{}),
    ...(/^[A-Z_]{1,40}$/.test(details.reason??'')?{reason:details.reason}:{}),
    ...(Number.isSafeInteger(details.status)&&details.status>=100&&details.status<600?{status:details.status}:{})
  };
}

export async function runStageFixedMaster({env=process.env,receipt,scope,skipRefresh,log=console.info}) {
  if(!scope) throw Error('FIXED_MASTER_DAILY_SCOPE_UNAVAILABLE');
  const emit=(component,evidence)=>log(JSON.stringify({component,runId:receipt.runId,...evidence}));
  const store=stageFixedMasterStorage({env,write:true,retryReads:true,
    onReadRetry:({code,...details})=>emit('opsmap-fixed-master-read-retry',diagnostic(code,{...details,phase:'STORE_READ'}))});
  const baseline=stageFixedMasterBaseline({env,store});
  const readMaster=env.OPSMAP_STAGE_FIXED_MASTER_SOURCE==='pages' ?
    createStageFixedMasterSource({env,onScan:e=>emit('opsmap-fixed-master-pages',e),
      onPage:e=>emit('opsmap-fixed-master-page-progress',e)}) :
    createStageFixedMasterExcelSource({env,onCenter:({center,sourceRows})=>
      emit('opsmap-fixed-master-excel-center',{center,sourceRows}),
      onRetry:({code,...details})=>emit('opsmap-fixed-master-read-retry',diagnostic(code,details))});
  try{
    const result=await syncStageFixedMaster({store,receipt,scope,readMaster,loadBaseline:baseline.load,skipRefresh});
    emit('opsmap-fixed-master-sync',result);
    return result;
  }catch(error){
    emit('opsmap-fixed-master-failure',diagnostic(error.code??error.message,error.fixedDiagnostic));
    throw error;
  }
}
