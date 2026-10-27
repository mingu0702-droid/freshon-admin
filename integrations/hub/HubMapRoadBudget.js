/** Account-wide cumulative allowance. Never resets monthly or on Render restart. */
const HUB_MAP_ROAD_BUDGET_KEY='OPSMAP_ROAD_APPROVED_ALLOWANCE_V1';
function hubMapRoadBudgetState_(){const raw=PropertiesService.getScriptProperties().getProperty(HUB_MAP_ROAD_BUDGET_KEY);if(!raw)throw Error('ROAD_BUDGET_NOT_APPROVED');const s=JSON.parse(raw);if(s.schema!==1||!Number.isSafeInteger(s.limit)||s.limit<1||s.limit>30000||!Number.isSafeInteger(s.used)||s.used<0||s.used>s.limit||typeof s.approvalId!=='string')throw Error('ROAD_BUDGET_INVALID');return s;}
// Operator-only Apps Script function. Deliberately NOT exposed over HTTP.
function hubMapRoadBudgetApprove(limit,approvalId){
 if(!Number.isSafeInteger(limit)||limit<1||limit>30000||typeof approvalId!=='string'||!/^[-A-Za-z0-9_]{8,80}$/.test(approvalId))throw Error('ROAD_BUDGET_APPROVAL_REQUIRED');
 const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw Error('ROAD_BUDGET_BUSY');
 try{const p=PropertiesService.getScriptProperties(),old=p.getProperty(HUB_MAP_ROAD_BUDGET_KEY);if(old)throw Error('ROAD_BUDGET_ALREADY_EXISTS');const value=JSON.stringify({schema:1,limit:limit,used:0,approvalId:approvalId,lastReservation:null});p.setProperty(HUB_MAP_ROAD_BUDGET_KEY,value);if(p.getProperty(HUB_MAP_ROAD_BUDGET_KEY)!==value)throw Error('ROAD_BUDGET_WRITE_UNCONFIRMED');return {limit:limit,used:0};}finally{lock.releaseLock();}
}
function hubMapRoadBudgetStatus_(params){hubMapHttpValidateOnlyKeys_(params,[]);const s=hubMapRoadBudgetState_();return {data:{limit:s.limit,used:s.used,remaining:s.limit-s.used,scope:'CUMULATIVE_APPROVED_ACCOUNT',durable:true},cached:false};}
function hubMapRoadBudgetReserve_(params){
 hubMapHttpValidateOnlyKeys_(params,['reservationId','cost','provider']);if(params.cost!==1||params.provider!=='kakao-directions'||!/^[-A-Za-z0-9_]{16,80}$/.test(params.reservationId||''))throw Error('ROAD_BUDGET_REQUEST');
 const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw Error('ROAD_BUDGET_BUSY');
 try{const s=hubMapRoadBudgetState_();if(s.used>=s.limit)throw Error('ROAD_BUDGET_EXHAUSTED');
  // No transport retry: even a lost acknowledgement consumes a reservation.
  s.used++;s.lastReservation={id:params.reservationId,at:new Date().toISOString()};const value=JSON.stringify(s),p=PropertiesService.getScriptProperties();p.setProperty(HUB_MAP_ROAD_BUDGET_KEY,value);if(p.getProperty(HUB_MAP_ROAD_BUDGET_KEY)!==value)throw Error('ROAD_BUDGET_WRITE_UNCONFIRMED');return {data:{reserved:true,remaining:s.limit-s.used,used:s.used,limit:s.limit,scope:'CUMULATIVE_APPROVED_ACCOUNT'},cached:false};
 }finally{lock.releaseLock();}
}
