const won = new Intl.NumberFormat('ko-KR');
export const money = value => Number.isSafeInteger(value) ? `${won.format(value)}원` : '미확인';
const postal = value => /^\d{5}$/.test(value ?? '') ? String(value) : null;
const dayKey = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const codeKey = value => /^[A-Z]\d{1,20}$/.test(value ?? '');
const vehicleKey = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 24;
const safePoint = row => row && (row.coordinateVerified === true || row.coordinateStatus === 'CONFIRMED') &&
  row.coordinateStatus !== 'CONFLICT' &&
  !/(?:_LIVE|_TEMPORARY)$/.test(row.coordinateSource || '') && row.resolutionStatus !== 'ADDRESS_CHANGED_REVIEW_REQUIRED' &&
  Number.isFinite(row.lat) && row.lat >= 33 && row.lat <= 39.5 && Number.isFinite(row.lng) && row.lng >= 124 && row.lng <= 132
  ? {lat:row.lat,lng:row.lng} : null;

export function distance(a,b) {
  const rad=Math.PI/180;
  const h=Math.sin((b.lat-a.lat)*rad/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lng-a.lng)*rad/2)**2;
  return 12742*Math.asin(Math.sqrt(h));
}

function detailAmounts(amountRow, stops) {
  if (amountRow?.detailState !== 'VERIFIED' || !Array.isArray(amountRow.detailRows) || !Number.isSafeInteger(amountRow.amount)) {
    return {detail:null, displayAmounts:null, summary:null};
  }
  const detail = new Map();
  let sum = 0;
  let duplicate = 0, unmatched = 0, invalid = 0;
  const customers = new Set(stops.map(stop=>stop.customerCode));
  const seen = new Set();
  for (const row of amountRow.detailRows) {
    if (!codeKey(row?.customerCode) || !Number.isSafeInteger(row.amount)) {invalid++;continue;}
    if (seen.has(row.customerCode)) {duplicate++;continue;}
    seen.add(row.customerCode);
    if (!customers.has(row.customerCode)) unmatched++;
    else detail.set(row.customerCode,row.amount);
    sum += row.amount;
  }
  const missing = customers.size-detail.size;
  const exactSum = duplicate===0 && invalid===0 && Number.isSafeInteger(sum) && Number.isSafeInteger(amountRow.amount-sum);
  const difference = exactSum ? amountRow.amount-sum : null;
  return {
    detail: exactSum&&difference===0&&!unmatched&&!missing ? detail : null,
    displayAmounts:duplicate===0&&invalid===0 ? detail : null,
    summary:{sum:exactSum?sum:null,difference,duplicate,unmatched,missing,invalid},
  };
}

export function detailText(summary) {
  if (!summary) return '상세 금액 미확인';
  const {sum,difference,duplicate,unmatched,missing,invalid}=summary;
  const reasons=[duplicate&&`중복 ${duplicate}건`,unmatched&&`다른 매장 ${unmatched}건`,
    missing&&`누락 ${missing}곳`,invalid&&`형식 오류 ${invalid}건`].filter(Boolean);
  if(difference!==null&&difference!==0&&!reasons.length) reasons.push('호차 합계와 상세 합계 차이');
  return `상세 합계 ${money(sum)} · 차액 ${money(difference)}${reasons.length?' · '+reasons.join(', '):''}`;
}

export function createDispatchReference(day, stores, date) {
  if (!dayKey(date) || day?.date !== date || day.center !== 'osan') throw Error('DISPATCH_REFERENCE_SCOPE');
  const storeByCode = new Map();
  for (const row of stores ?? []) if (codeKey(row?.customerCode)) {
    // An ambiguous registration join supplies no coordinate or postal evidence.
    if (storeByCode.has(row.customerCode)) storeByCode.set(row.customerCode,null);
    else storeByCode.set(row.customerCode,row);
  }
  const routes = new Map(), seen = new Set();
  let routeState = ['VERIFIED','PARTIAL'].includes(day.route?.state) && Array.isArray(day.route.rows) ? day.route.state : 'UNAVAILABLE';
  if (routeState!=='UNAVAILABLE') for (const row of day.route.rows) {
    const key = `${row?.vehicle}|${row?.customerCode}`;
    if (!codeKey(row?.customerCode) || !vehicleKey(row.vehicle)) { routeState='UNAVAILABLE';break; }
    if (seen.has(key)) continue;
    seen.add(key);
    if (!routes.has(row.vehicle)) routes.set(row.vehicle,[]);
    const store=storeByCode.get(row.customerCode);
    routes.get(row.vehicle).push({customerCode:row.customerCode,name:row.customerName || store?.customerName || row.customerCode,
      postalCode:postal(row.postalCode) || postal(store?.postalCode),point:safePoint(row)||safePoint(store)});
  }
  if (routeState==='UNAVAILABLE') routes.clear();
  const routeVerified = routeState==='VERIFIED';
  const amountDate=day.amounts?.date ?? null;
  let amountsVerified = amountDate === date && day.amounts?.state === 'VERIFIED' && Array.isArray(day.amounts.vehicles);
  const amounts=new Map();
  if (amountsVerified) for (const row of day.amounts.vehicles) {
    if (!vehicleKey(row?.vehicle) || !Number.isSafeInteger(row.amount) || amounts.has(row.vehicle)) { amountsVerified=false;break; }
    amounts.set(row.vehicle,row);
  }
  if (!amountsVerified) amounts.clear();
  const amountTotal=amountsVerified ? [...amounts.values()].reduce((sum,row)=>sum+row.amount,0) : null;
  const sameWmsExport=['WMS_CONFIRMED_DISPATCH_EXPORT','WMS_CONFIRMED_DISPATCH_FRESHON_JSON'].includes(day.route?.source)&&
    day.amounts?.source===day.route?.source;
  const reported=day.amounts?.sourceTotals;
  const sourceTotals=amountsVerified&&sameWmsExport&&Number.isSafeInteger(reported?.amount)&&reported.amount===amountTotal&&
    Number.isSafeInteger(reported.deliveryCount)&&reported.deliveryCount>=0
    ?{amount:reported.amount,deliveryCount:reported.deliveryCount}:null;
  const unassigned=routeVerified&&Number.isSafeInteger(day.route.unassigned)&&day.route.unassigned>=0 ? day.route.unassigned : null;
  const vehicles=new Map();
  for (const vehicle of new Set([...routes.keys(),...amounts.keys()])) {
    const stops=routes.get(vehicle), amount=amounts.get(vehicle);
    const {detail,displayAmounts,summary} = routeVerified ? detailAmounts(amount,stops??[]) : {detail:null,displayAmounts:null,summary:null};
    vehicles.set(vehicle,{vehicle,stops:stops??[],storeCount:routeVerified ? stops?.length ?? null : null,
      amount:amount?.amount ?? null, detail,displayAmounts,detailSummary:summary,registryMisses:amount?.unmatched??null});
  }
  return {date, routeVerified,routeState, routeSource:day.route?.source??null, routeObservedAt:day.route?.observedAt ?? null, unassigned, amountDate, amountsVerified,amountTotal,
    sameWmsExport,sourceTotals,
    exportFailure:day.amounts?.exportFailure,
    amountObservedAt:day.amounts?.observedAt ?? null, vehicles};
}

export function compareDispatchRoutes(model, target, source, maxKm, deficit=null) {
  const to=model.vehicles.get(target), from=model.vehicles.get(source);
  if (!to || !from || from===to || !Number.isFinite(maxKm) || maxKm<=0 || maxKm>50) return null;
  const tally=stops=>{
    const counts=new Map();
    for (const {postalCode} of stops) if (postalCode) counts.set(postalCode,(counts.get(postalCode)||0)+1);
    return counts;
  };
  const targetPostal=tally(to.stops), sourcePostal=tally(from.stops);
  const sharedPostalCodes=[...sourcePostal.keys()].filter(code=>targetPostal.has(code)).sort();
  const targetCustomers=new Set(to.stops.map(stop=>stop.customerCode));
  const sharedAreaCounts=sharedPostalCodes.map(code=>({code,target:targetPostal.get(code),source:sourcePostal.get(code)}));
  const sharedCustomers=from.stops.filter(stop=>targetCustomers.has(stop.customerCode)).length;
  const targetPoints=to.stops.filter(stop=>stop.point);
  let minimumKm=null;
  const candidates=[];
  for (const stop of from.stops) {
    if (!stop.point || targetCustomers.has(stop.customerCode)) continue;
    let nearest=null, km=Infinity;
    for (const other of targetPoints) {
      const current=distance(stop.point,other.point);
      if (current<km) {nearest=other;km=current;}
    }
    if (!nearest) continue;
    minimumKm=minimumKm===null ? km : Math.min(minimumKm,km);
    if (km<=maxKm) candidates.push({...stop,km,nearest,postalOverlap:targetPostal.has(stop.postalCode),amount:from.detail?.get(stop.customerCode)??null});
  }
  const shortfall = candidate => Number.isSafeInteger(deficit) && candidate.amount!==null ? Math.abs(deficit-candidate.amount) : Infinity;
  candidates.sort((a,b)=> (Number.isFinite(shortfall(a)) || Number.isFinite(shortfall(b)) ? shortfall(a)-shortfall(b) : 0) ||
    Number(b.postalOverlap)-Number(a.postalOverlap) || a.km-b.km || a.customerCode.localeCompare(b.customerCode));
  return {target:to,source:from,sharedPostalCodes,sharedAreaCounts,sharedCustomers,minimumKm,candidates};
}

export function discoverDispatchRoutes(model,anchor,maxKm=.5) {
  return [...model.vehicles.keys()].filter(vehicle=>vehicle!==anchor&&model.vehicles.get(vehicle).stops.length)
    .map(vehicle=>compareDispatchRoutes(model,anchor,vehicle,maxKm)).filter(Boolean)
    .sort((a,b)=>b.sharedPostalCodes.length-a.sharedPostalCodes.length||
      (a.minimumKm??Infinity)-(b.minimumKm??Infinity)||a.source.vehicle.localeCompare(b.source.vehicle,'ko',{numeric:true}));
}

export function simulateDispatchTransfer(comparison, code) {
  const candidate=comparison?.candidates.find(row=>row.customerCode===code);
  if (!candidate || !Number.isSafeInteger(candidate.amount) || candidate.amount<=0) return null;
  const {target,source}=comparison;
  if (![target.amount, source.amount].every(Number.isSafeInteger) || candidate.amount>source.amount ||
      !Number.isSafeInteger(target.amount+candidate.amount)) return null;
  return {targetAmount:target.amount+candidate.amount,sourceAmount:source.amount-candidate.amount,
    targetCount:target.storeCount+1,sourceCount:source.storeCount-1};
}
