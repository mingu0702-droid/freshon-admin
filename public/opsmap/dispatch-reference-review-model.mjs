import {distance} from './dispatch-reference.mjs';

const maxKm = 0.5;
const codeOrder = (a,b)=>a.customerCode.localeCompare(b.customerCode);
const postalOf = row => /^\d{5}$/.test(row.postalCode??'') ? row.postalCode : null;

function customerOccurrences(model) {
  const counts = new Map();
  for (const route of model.vehicles.values()) {
    for (const stop of route.stops) counts.set(stop.customerCode,(counts.get(stop.customerCode)??0)+1);
  }
  return counts;
}

function postalCounts(stops) {
  const counts = new Map();
  for (const stop of stops) {
    const postal = postalOf(stop);
    if (postal) counts.set(postal,(counts.get(postal)??0)+1);
  }
  return counts;
}

function nearestPoint(stop, destinations) {
  let nearest = null, km = Infinity;
  if (stop.point) {
    for (const other of destinations) {
      if (!other.point) continue;
      const measured = distance(stop.point,other.point);
      if (measured<km || (measured===km && nearest && codeOrder(other,nearest)<0)) {
        nearest=other;
        km=measured;
      }
    }
  }
  return {nearest,km:nearest ? km : null};
}

const candidateOrder = (a,b)=>(a.km??Infinity)-(b.km??Infinity)||codeOrder(a,b);

export function compareDispatchReview(model, targetId, sourceId) {
  return compare(model,targetId,sourceId,customerOccurrences(model));
}

function compare(model,targetId,sourceId,counts) {
  const target=model.vehicles.get(targetId), source=model.vehicles.get(sourceId);
  if (!model.routeVerified || !target?.stops.length || !source?.stops.length || target===source) return null;
  const unique = route=>route.stops.filter(stop=>counts.get(stop.customerCode)===1);
  const sourceStops=unique(source), targetStops=unique(target);
  const sourcePostal=postalCounts(sourceStops), targetPostal=postalCounts(targetStops);
  const sharedPostalCodes=[...sourcePostal.keys()].filter(code=>targetPostal.has(code)).sort();
  const sharedAreaCounts=sharedPostalCodes.map(code=>({code,target:targetPostal.get(code),source:sourcePostal.get(code)}));
  const samePostalCandidates=[], adjacentCandidates=[], nearbyCandidates=[];
  let minimumKm=null;
  for (const stop of sourceStops) {
    const postal=postalOf(stop);
    const amount=model.sameWmsExport && model.amountsVerified ? source.detail?.get(stop.customerCode)??null : null;
    if (postal && targetPostal.has(postal)) {
      const neighbors=targetStops.filter(other=>postalOf(other)===postal);
      const same=nearestPoint(stop,neighbors);
      const fallback=neighbors.reduce((first,next)=>codeOrder(next,first)<0?next:first);
      samePostalCandidates.push({...stop,...same,nearest:same.nearest??fallback,amount,postalOverlap:true});
    }
    const near=nearestPoint(stop,targetStops);
    if (near.km===null) continue;
    minimumKm=minimumKm===null?near.km:Math.min(minimumKm,near.km);
    if (near.km<=maxKm) {
      nearbyCandidates.push({...stop,...near,amount,postalOverlap:Boolean(postal&&postal===postalOf(near.nearest))});
    }
    const adjacent=nearestPoint(stop,targetStops.filter(other=>!postal||postal!==postalOf(other)));
    if (adjacent.km!==null&&adjacent.km<=maxKm) {
      adjacentCandidates.push({...stop,...adjacent,amount,postalOverlap:false});
    }
  }
  return {target,source,sharedPostalCodes,sharedAreaCounts,minimumKm,
    samePostalCandidates:samePostalCandidates.sort(candidateOrder),
    adjacentCandidates:adjacentCandidates.sort(candidateOrder),
    nearbyCandidates:nearbyCandidates.sort(candidateOrder)};
}

export function simulateDispatchReviewMoves(model, moves) {
  if (!model.routeVerified || !model.amountsVerified || !model.sameWmsExport ||
      !Number.isSafeInteger(model.amountTotal) || !Array.isArray(moves) || !moves.length) return null;
  const counts=customerOccurrences(model), seen=new Set(), comparisonCache=new Map(), totals=new Map();
  let movedAmount=0;
  for (const move of moves) {
    if (!move || !['same-postal','adjacent','nearby'].includes(move.mode) || seen.has(move.customerCode)) return null;
    const key=JSON.stringify([move.target,move.source]);
    if (!comparisonCache.has(key)) comparisonCache.set(key,compare(model,move.target,move.source,counts));
    const comparison=comparisonCache.get(key);
    if (!comparison) return null;
    const {source,target}=comparison;
    const candidates=move.mode==='same-postal'?comparison.samePostalCandidates:
      move.mode==='adjacent'?comparison.adjacentCandidates:comparison.nearbyCandidates;
    const candidate=candidates.find(row=>row.customerCode===move.customerCode);
    if (!Number.isSafeInteger(candidate?.amount) || candidate.amount<0 ||
        [source,target].some(route=>!route.detail || !Number.isSafeInteger(route.amount) ||
          !Number.isSafeInteger(route.storeCount) || route.storeCount!==route.stops.length)) return null;
    seen.add(move.customerCode);
    for (const route of [source,target]) {
      if (!totals.has(route.vehicle)) totals.set(route.vehicle,{incoming:0,outgoing:0,count:route.storeCount});
    }
    const from=totals.get(source.vehicle), to=totals.get(target.vehicle);
    from.outgoing+=candidate.amount;
    to.incoming+=candidate.amount;
    from.count--;
    to.count++;
    movedAmount+=candidate.amount;
    if (!Number.isSafeInteger(movedAmount)) return null;
  }
  const vehicles=new Map();
  for (const route of model.vehicles.values()) {
    const draft=totals.get(route.vehicle);
    if (!draft) {
      vehicles.set(route.vehicle,{amount:route.amount,storeCount:route.storeCount});
      continue;
    }
    const amount=route.amount-draft.outgoing+draft.incoming;
    if (route.amount<draft.outgoing || !Number.isSafeInteger(amount) || draft.count<0) return null;
    vehicles.set(route.vehicle,{amount,storeCount:draft.count});
  }
  const touched=[...totals.keys()];
  const sum=(route,field)=>touched.reduce((total,vehicle)=>total+route.get(vehicle)[field],0);
  const verified=['amount','storeCount'].every(field=>{
    const before=sum(model.vehicles,field),after=sum(vehicles,field);
    return Number.isSafeInteger(before)&&before===after;
  });
  return verified?{vehicles,amountTotal:model.amountTotal,movedAmount,moveCount:seen.size}:null;
}

export function groupFixedPostalRoutes(members, fixedVehicle) {
  const counts=new Map();
  const codes=new Set(members.map(member=>member?.code).filter(code=>/^[A-Z]\d{1,20}$/.test(code??'')));
  for (const code of codes) {
    const vehicle=fixedVehicle(code);
    if (typeof vehicle!=='string' || !vehicle.length || vehicle.trim()!==vehicle ||
        vehicle.length>24 || vehicle==='미배정') continue;
    counts.set(vehicle,(counts.get(vehicle)??0)+1);
  }
  return [...counts].map(([vehicle,count])=>({vehicle,count})).sort((a,b)=>
    b.count-a.count||a.vehicle.localeCompare(b.vehicle,'ko',{numeric:true}));
}
