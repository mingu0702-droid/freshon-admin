const integer=n=>Number.isSafeInteger(n)&&n>=0;
// https://developers.kakaomobility.com/price/
const dailyLimits=Object.freeze({directions:10000,waypoints:5000});
export const supportedRoadApis=Object.freeze(Object.keys(dailyLimits));
const supportedApis=supportedRoadApis;
const kst=value=>new Date(value+9*3600000).toISOString().slice(0,10);
const fail=code=>{throw Object.assign(Error(code),{code});};

export function createApprovedRoadBudgetPolicy({accountHash,requireExplicitApis=false}){
 function validate(state,time){
  const b=state?.roadBudget;
  if(!b)fail('ROAD_BUDGET_LEDGER_MISSING');
  if(b.accountHash!==accountHash||b.scope!=='CUMULATIVE_APPROVED_ACCOUNT')fail('ROAD_BUDGET_ACCOUNT_MISMATCH');
  if(b.policy!=='FREE_ONLY'||b.providerPaidDisabled!==true||b.servicePermissionVerified!==true||!/^[-A-Za-z0-9_]{8,100}$/.test(b.approvalId||''))fail('ROAD_BUDGET_APPROVAL_REQUIRED');
  if((requireExplicitApis||b.approvedApis!==undefined)&&(!Array.isArray(b.approvedApis)||!b.approvedApis.length||new Set(b.approvedApis).size!==b.approvedApis.length||b.approvedApis.some(api=>!supportedApis.includes(api))))fail('ROAD_BUDGET_APPROVAL_REQUIRED');
  const observed=b.providerDailyUsedAtApproval;
  if((requireExplicitApis||observed!==undefined)&&(!b.approvedApis||!observed||typeof observed!=='object'||Array.isArray(observed)||
   Object.keys(observed).length!==b.approvedApis.length||b.approvedApis.some(api=>!integer(observed[api])||
    observed[api]+b.apis?.[api]?.freeRemainingAtApproval>dailyLimits[api])))fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  const verified=Date.parse(b.verifiedAt),expires=Date.parse(b.expiresAt);
  if(!Number.isFinite(verified)||!Number.isFinite(expires)||verified>time||expires<=time||expires<=verified)fail('ROAD_BUDGET_APPROVAL_EXPIRED');
  if(b.monthlyApproval){
   const m=b.monthlyApproval,period=kst(verified).slice(0,7);
   // Basic Directions refuses overage under a verified free-only approval.
   // The ledger reserves local calls; the provider still enforces shared use.
   const hardFreeLimit=m.providerRejectsFreeOverage===true&&b.approvedApis?.length===1&&b.approvedApis[0]==='directions'&&integer(observed?.directions);
   if(m.period!==period||kst(time).slice(0,7)!==period||kst(expires-1).slice(0,7)!==period||
      (m.exclusiveDirectionsUsage!==true&&!hardFreeLimit))fail('ROAD_BUDGET_MONTHLY_APPROVAL_REQUIRED');
   if(!m.dailyUsage||typeof m.dailyUsage!=='object'||Array.isArray(m.dailyUsage)||Object.keys(m.dailyUsage).length>31)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   for(const [day,counts]of Object.entries(m.dailyUsage)){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||day.slice(0,7)!==period||day>kst(time))fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
    for(const [api,max]of Object.entries(dailyLimits))if(!integer(counts?.[api])||counts[api]>max)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   }
  }else if(expires-verified>86400000||kst(verified)!==kst(time)||kst(verified)!==kst(expires-1))fail('ROAD_BUDGET_APPROVAL_EXPIRED');
  if(!integer(b.limit)||b.limit<1||b.limit>30000||!integer(b.used)||b.used>b.limit||!integer(b.monthlyFreeRemainingAtApproval)||b.monthlyFreeRemainingAtApproval>3000000||b.limit>b.monthlyFreeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  let total=0;
  for(const [api,max]of Object.entries(dailyLimits)){
   const entry=b.apis?.[api];
   if(!entry||!integer(entry.freeRemainingAtApproval)||entry.freeRemainingAtApproval>max||!integer(entry.used)||!b.monthlyApproval&&entry.used>entry.freeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   if(b.monthlyApproval){
    const m=b.monthlyApproval,prior=m.usedBeforeWindow?.[api];
    if(!integer(prior)||prior+Object.values(m.dailyUsage).reduce((sum,counts)=>sum+counts[api],0)!==entry.used||(m.dailyUsage[kst(verified)]?.[api]||0)>entry.freeRemainingAtApproval)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
   }
   total+=entry.used;
  }
  if(total!==b.used)fail('ROAD_BUDGET_QUOTA_UNVERIFIED');
  return b;
 }
 function stateStatus(b,time){
  const day=kst(time),approvalDay=kst(Date.parse(b.verifiedAt));
  // Earlier verified ledgers covered both endpoints. A scoped approval stays
  // scoped across daily rollover and still accounts for prior calls to either.
  const approved=b.approvedApis??supportedApis;
  const apis=Object.fromEntries(supportedApis.map(api=>{
   if(!approved.includes(api))return [api,0];
   const value=b.apis[api];
   const remaining=b.monthlyApproval?(day===approvalDay?value.freeRemainingAtApproval:dailyLimits[api])-(b.monthlyApproval.dailyUsage[day]?.[api]||0):value.freeRemainingAtApproval-value.used;
   return [api,Math.max(0,remaining)];
  }));
  return {durable:true,scope:b.scope,remaining:Math.max(0,Math.min(b.limit-b.used,b.monthlyFreeRemainingAtApproval-b.used,apis.directions+apis.waypoints)),apiRemaining:apis,approvedApis:approved.slice(),freeOnly:true,approvalExpiresAt:b.expiresAt,approvalWindow:b.monthlyApproval?'KST_MONTH':'KST_DAY',usageDate:day};
 }
 return {validate,stateStatus};
}
