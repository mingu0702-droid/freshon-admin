import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
  FIXED_MASTER_EXCEL_SOURCE, createStageDailyFixedMasterReader, stageFixedMasterBaseline,
  stageFixedMasterStorage, syncStageFixedMaster
} from '../src/stageFixedMasterSync.js';
import {readIndependentStageScopes} from '../src/stageIndependentSyncScope.js';
import {fixedTupleData} from '../src/fixedVehicleStore.js';
import {fixedMasterExcelRaw,projectFixedMasterExcel,readFixedMasterExcel} from '../src/stageFixedMasterExcel.js';

const env=process.env;
const centers=['011','012','013'];
const weekdays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const sha256=/^[a-f0-9]{64}$/;
const day=timestamp=>new Date(timestamp+9*3600000).toISOString().slice(0,10);

async function run() {
  const [mode,...extra]=process.argv.slice(2);
  if (extra.length || !['verify','publish'].includes(mode)) throw Error('FIXED_MASTER_EXCEL_USAGE');
  const publish=mode==='publish';
  if (publish && (env.OPSMAP_STAGE_FIXED_MASTER_RECOVERY_APPROVED!=='1' || !env.OPSMAP_STAGE_SYNC_WRITE_TOKEN)) {
    throw Error('FIXED_MASTER_RECOVERY_APPROVAL');
  }
  const store=stageFixedMasterStorage({env,write:publish});
  let input='';
  for await (const chunk of process.stdin) {
    input+=chunk;
    if (Buffer.byteLength(input)>16*1024) throw Error('FIXED_MASTER_EXCEL_MANIFEST');
  }
  const {baselineVersion,exports}=JSON.parse(input);
  const date=day(Date.now());
  if (!sha256.test(baselineVersion || '') || !Array.isArray(exports) || exports.length!==centers.length ||
      new Set(exports.map(item=>item?.sha256)).size!==centers.length || exports.some((item,i)=>{
        const seenAt=Date.parse(item?.observedAt);
        return item?.center!==centers[i] || typeof item.path!=='string' || !item.path ||
          !sha256.test(item.sha256 || '') || !Number.isSafeInteger(item.declaredRows) || item.declaredRows<1 ||
          !Number.isFinite(seenAt) || new Date(seenAt).toISOString()!==item.observedAt ||
          seenAt>Date.now() || day(seenAt)!==date;
      })) throw Error('FIXED_MASTER_EXCEL_MANIFEST');

  const fallback=stageFixedMasterBaseline({env,store});
  const [baseline,{fixedScope:scope}]=await Promise.all([
    createStageDailyFixedMasterReader({store,baseline:fallback}).load(),readIndependentStageScopes(env)
  ]);
  if (baseline?.version!==baselineVersion ||
      exports.some(item=>item.observedAt<=baseline.checkedAt)) throw Error('FIXED_STORE_DAILY_SUPERSEDED');
  const eligible=new Set(scope.codes), seen=new Set(), raw=[], coverage=[];
  for (const item of exports) {
    const {codes,selected}=await readFixedMasterExcel(createReadStream(item.path),{
      codes:eligible,declaredRows:item.declaredRows,sha256:item.sha256
    });
    for(const code of codes){
      if(seen.has(code)) throw Error('FIXED_MASTER_EXCEL_CUSTOMER_KEY');
      seen.add(code);
    }
    raw.push(...selected.map(row=>fixedMasterExcelRaw(row,item.center)));
    coverage.push({center:item.center,sourceRows:codes.length,declaredRows:item.declaredRows,
      duplicateCustomerRows:0,sha256:item.sha256,observedAt:item.observedAt});
  }
  const data=projectFixedMasterExcel(raw);
  const byCode=new Map(data.map(row=>[row.customerCode,row]));
  let changed=0,retainedUnconfirmed=0,observedExisting=0;
  for (const tuple of baseline.rows) {
    const old=fixedTupleData(tuple), current=byCode.get(old.customerCode);
    if (!eligible.has(old.customerCode)) continue;
    if (!current) {retainedUnconfirmed++;continue;}
    observedExisting++;
    if (old.baseVehicle!==current.baseVehicle || old.baseVehicleGroup!==current.baseVehicleGroup ||
        weekdays.some(day=>old.weekdays?.[day]!==current.weekdays[day])) changed++;
  }
  const summary={source:FIXED_MASTER_EXCEL_SOURCE,sourceRows:seen.size,baselineCount:baseline.count,
    registryCount:eligible.size,matchedCount:data.length+retainedUnconfirmed,changed,
    added:data.length-observedExisting,retainedUnconfirmed,
    missingCount:eligible.size-data.length-retainedUnconfirmed};
  if (!publish) {
    console.log(JSON.stringify({state:'SOURCE_VERIFIED',...summary}));
    return;
  }
  const receipt={date,runId:digest(JSON.stringify([FIXED_MASTER_EXCEL_SOURCE,date,...coverage.map(item=>item.sha256)]))};
  const result=await syncStageFixedMaster({store,receipt,scope,loadBaseline:fallback.load,
    readMaster:async()=>({data,meta:{source:FIXED_MASTER_EXCEL_SOURCE,baselineVersion,
      sourceRows:seen.size,uniqueCustomers:seen.size,projectedCustomers:data.length,centers:coverage}})});
  console.log(JSON.stringify({state:result.state,...summary,version:result.version,runId:result.runId}));
  if (!['PUBLISHED','VERIFIED_NOOP'].includes(result.state)) process.exitCode=1;
}

try {
  await run();
} catch (error) {
  const code=error.code || error.message;
  console.error(/^(?:FIXED_(?:MASTER|STORE)|OPSMAP_DURABLE|STAGE_(?:BASELINE|STAFF_REGISTRY))_[A-Z_]{1,70}$/.test(code)
    ? code : 'FIXED_MASTER_EXCEL_FAILED');
  process.exitCode=1;
}
