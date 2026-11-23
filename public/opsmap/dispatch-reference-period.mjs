export function summarizeDispatchPeriod(period,selected,basis='dispatch') {
  const vehicles=new Map(), areas=new Map(), neighbors=new Map();
  const verified=[], unavailable=[], completed=[], partialCompleted=[], wms=[], exportScoped=[], osanScoped=[];
  function truck(vehicle) {
    if (!vehicles.has(vehicle)) vehicles.set(vehicle,{vehicle,days:0,stops:0,unknown:0,trend:[],first:null,last:null});
    return vehicles.get(vehicle);
  }
  for (const {date,state,dispatchScope,routes,neighbors:nearby,amounts,completed:delivery,wmsVerified} of period.dates) {
    if (state==='VERIFIED') {
      verified.push(date);
      if (dispatchScope==='WMS_EXPORT') exportScoped.push(date);
      if (dispatchScope==='OSAN_SOURCE') osanScoped.push(date);
    } else unavailable.push(date);
    if (delivery) (delivery.coverage==='PARTIAL'?partialCompleted:completed).push(date);
    if (wmsVerified) {
      wms.push(date);
      for (const [vehicle,amount] of amounts) truck(vehicle).trend.push([date,amount]);
    }
    const evidence=basis==='completed'?delivery:state==='VERIFIED'?{routes,neighbors:nearby}:null;
    if (!evidence) continue;
    const shared=new Map();
    for (const [vehicle,[count,unknown,zips]] of Object.entries(evidence.routes)) {
      const group=truck(vehicle);
      group.days++;
      group.stops+=count;
      group.unknown+=unknown;
      group.first??={date,zips:zips.map(([zip])=>zip)};
      group.last={date,zips:zips.map(([zip])=>zip)};
      if (!selected.has(vehicle)) continue;
      for (const [zip,count,point] of zips) {
        const area=areas.get(zip)||{zip,overlapDays:0,members:new Map()};
        const member=area.members.get(vehicle)||{vehicle,days:0,stops:0,point:null};
        member.days++;
        member.stops+=count;
        member.point??=point;
        area.members.set(vehicle,member);
        areas.set(zip,area);
        shared.set(zip,(shared.get(zip)||0)+1);
      }
    }
    for (const [zip,count] of shared) if (count>1) areas.get(zip).overlapDays++;
    for (const [a,b,meters] of evidence.neighbors) if (selected.has(a)&&selected.has(b)) {
      const key=a+'|'+b;
      const pair=neighbors.get(key)||{a,b,days:0,meters};
      pair.days++;
      pair.meters=Math.min(pair.meters,meters);
      neighbors.set(key,pair);
    }
  }
  return {verified,unavailable,completed,partialCompleted,wms,exportScoped,osanScoped,vehicles,areas:[...areas.values()].sort((a,b)=>b.overlapDays-a.overlapDays||a.zip.localeCompare(b.zip)),
    neighbors:[...neighbors.values()].sort((a,b)=>b.days-a.days||a.meters-b.meters)};
}
