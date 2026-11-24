import {createHash} from 'node:crypto';
import {isDay} from './shadowCoverage/coverageFiles.js';
import {SYNC_CENTERS} from './opsmapSyncPolicy.js';

const dayMs=86400000;
const isoDay=stamp=>new Date(stamp).toISOString().slice(0,10);

// The current verified order reader proves positive orders only. A missing or
// partial center/day, including a successful empty HTTP response, proves no absence.
export function stageNightOrderScope(ledger, runDate) {
  if(!isDay(runDate))throw Error('NIGHT_ORDER_SCOPE_DATE');
  const closed=Date.parse(runDate)-dayMs, end=isoDay(closed), start=isoDay(closed-89*dayMs);
  const byCenter=new Map(SYNC_CENTERS.map(center=>[center,new Set()]));
  const orderCodes=new Set(), completelyRead=new Set();
  if(ledger?.endDate<=end){
    for(const day of ledger.days){
      if(day.source!=='freshon_orders'||day.date<start||day.date>end)continue;
      const customers=byCenter.get(day.centerKey);
      if(!customers)continue;
      if(day.coverage==='complete'&&day.completeNightOrders===true)
        completelyRead.add(day.date+':'+day.centerKey);
      for(const row of day.rows){
        if(row.evidence!=='order_confirmed'||row.nightOrder!==true)continue;
        customers.add(row.customerCode);
        orderCodes.add(row.customerCode);
      }
    }
  }
  return {byCenter,orderCodes,end,allDaysVerified:completelyRead.size===90*SYNC_CENTERS.length};
}

// Excluding refreshes preserves the current and historical rows. Any proposed
// exclusion larger than 1% of the roster or 100 codes needs an exact review.
export function planStageNightOrderExclusions(scope, codes, protectedCodes, approvedSha256) {
  if(!scope.allDaysVerified)return {skip:new Set(),proposed:0,reviewSha256:null};
  const absent=[...new Set(codes)].filter(code=>!scope.orderCodes.has(code)&&!protectedCodes.has(code)).sort();
  const reviewSha256=absent.length?createHash('sha256').update(JSON.stringify([scope.end,absent])).digest('hex'):null;
  const automaticLimit=Math.min(100,Math.floor(codes.length/100));
  const skip=absent.length<=automaticLimit||reviewSha256===approvedSha256?new Set(absent):new Set();
  return {skip,proposed:absent.length,reviewSha256:skip.size===absent.length?null:reviewSha256};
}
