import { archivedDatedDispatch } from './datedDeliveryContract.js';
import { projectOpsmapWmsDispatch } from './opsmapWmsDispatchExport.js';
import { DISPATCH_PERIODS, dispatchPeriodDates, projectDispatchPeriodDay } from './opsmapDispatchPeriod.js';
import { assertDeliverySourceObservation } from './snapshotRefreshEvidence.js';
import { coordinateAddressHash } from './opsmap-abc/opsmapAutoCoordinates.js';

const CONTRACT = 'opsmap-dispatch-reference-v1';
const CENTER = 'osan';
const unavailableRoute = () => ({state:'UNAVAILABLE', observedAt:null, rows:[], unassigned:null});
const unavailableAmounts = date => ({state:'UNAVAILABLE', date, observedAt:null, vehicles:[]});
const exportFailures = new Set([
  'WMS_EXPORT_APPROVAL_MISSING','WMS_EXPORT_MANIFEST_INVALID','WMS_EXPORT_DATE_NOT_APPROVED',
  'WMS_EXPORT_WAREHOUSE_INVALID','WMS_EXPORT_MANIFEST_ENTRY_INVALID','WMS_EXPORT_ARCHIVE_REF_INVALID',
  'WMS_EXPORT_ARCHIVE_KEY_INVALID','WMS_EXPORT_ARCHIVE_TOKEN_MISSING','WMS_EXPORT_ARCHIVE_PERMISSION',
  'WMS_EXPORT_ARCHIVE_READ','WMS_EXPORT_ARCHIVE_NOT_FOUND','WMS_EXPORT_ARCHIVE_FORMAT','WMS_EXPORT_ARCHIVE_INTEGRITY',
  'WMS_EXPORT_SECRET_FILE_READ','WMS_EXPORT_ENCODING','WMS_EXPORT_DIGEST','WMS_EXPORT_WORKBOOK_INVALID',
]);
const safeExportFailure = code => code==='WMS_EXPORT_DATE_MISMATCH'?'DATE_MISMATCH':
  exportFailures.has(code)?code:'EXPORT_NOT_VERIFIED';

function exactDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}

export function createOpsmapDispatchReferenceReader({getPublication, readAmounts, readPostcodes, readWmsExport, readDated,
  readRetainedDated, retainedDatedDates}) {
  async function withPostcodes(rows,publication) {
    const codes=[...new Set(rows.filter(row=>row.addressMatches).map(row=>row.customerCode))];
    return codes.length&&readPostcodes
      ? await Promise.resolve().then(()=>readPostcodes(codes,publication?.postalGeneration)).catch(()=>null)
      : null;
  }

  async function projectRecords(records,publication,includeCompleted) {
    const scoped=[...records.values()];
    const postcodes=await withPostcodes(scoped,publication);
    const rows=scoped.map(({store,addressMatches,delivered,...row})=>{
      const located=addressMatches&&store.hasPoint===true&&Number.isFinite(store.lat)&&Number.isFinite(store.lng);
      return {...row,postalCode:addressMatches?postcodes?.get(row.customerCode)??null:null,
        lat:located?store.lat:null,lng:located?store.lng:null,coordinateVerified:Boolean(located)};
    });
    return {rows,...(includeCompleted?{completedRows:rows.filter((_,index)=>scoped[index].delivered)}:{})};
  }

  async function confirmedRoute(date,publication,reader,includeCompleted) {
    const value=await reader(date);
    if (value?.date!==date||value.centerScope!==CENTER||!['LIVE_VERIFIED','STALE_VERIFIED'].includes(value.sourceReadState)||
        !Array.isArray(value.vehicles)) return null;
    assertDeliverySourceObservation(value.sourceObservation,date);
    const records=new Map();
    for (const {vehicle,stops} of value.vehicles) {
      if (vehicle==='미확인'||!vehicle) continue;
      for (const {customerCode,customerName,address,appRecorded} of stops) {
        const addressHash=coordinateAddressHash(address);
        const store=publication?.registry?.get(customerCode);
        const key=vehicle+'|'+customerCode;
        const prior=records.get(key);
        const addressMatches=Boolean(addressHash&&store?.addressHash===addressHash&&(prior?.addressMatches??true));
        records.set(key,{vehicle,customerCode,customerName:customerName||store?.name||customerCode,store,addressMatches,
          delivered:appRecorded===true||prior?.delivered===true});
      }
    }
    return {state:'VERIFIED',source:'DATED_DELIVERY_SOURCE',observedAt:value.generatedAt,unassigned:value.sourceObservation.unassignedRows,
      ...await projectRecords(records,publication,includeCompleted)};
  }

  async function archivedRoute(date,publication,includeCompleted) {
    const archive=await Promise.resolve().then(()=>publication?.readDay?.(date)).catch(()=>null);
    if (archive?.date!==date||archive.planningOnly) return unavailableRoute();
    const evidence=Array.isArray(archive.dispatch?.sources)?archivedDatedDispatch(archive,{
      center:CENTER,generation:publication.generation,sourceRunId:publication.runId,
      publishedAt:publication.publishedAt,lastSuccessAt:publication.observedAt?.(date),error:null}):null;
    const complete=evidence?.sourceComplete===true&&evidence.scopeComplete===true;
    const addresses=new Map((complete?archive.tasks:archive.visits??[]).map(([id,,,,addressHash])=>[id,addressHash]));
    const observed=complete?evidence.rows:(archive.visits??[]).flatMap(([deliveryId,customerCode,vehicle,center])=>
      center===CENTER?[{deliveryId,customerCode,vehicle}]:[]);
    if (!complete&&!observed.length) return unavailableRoute();
    const records=new Map();
    for (const row of observed) {
      if (row.state==='CANCELLED'||!row.vehicle||!/^[A-Z]\d{1,20}$/.test(row.customerCode)) continue;
      const key=row.vehicle+'|'+row.customerCode;
      const store=publication.registry?.get(row.customerCode);
      const knownHash=complete||archive.tasks?store?.addressHash:store?.matchHash;
      const prior=records.get(key);
      const addressMatches=Boolean(knownHash&&addresses.get(row.deliveryId)===knownHash&&(prior?.addressMatches??true));
      records.set(key,{vehicle:row.vehicle,customerCode:row.customerCode,customerName:store?.name??row.customerCode,store,addressMatches,
        delivered:row.state==='COMPLETED'||prior?.delivered===true});
    }
    return {state:complete?'VERIFIED':'PARTIAL',observedAt:publication.observedAt?.(date)??null,publishedAt:publication.publishedAt??null,
      source:complete?'PUBLISHED_DELIVERY_ARCHIVE':'PUBLISHED_COMPLETED_OBSERVATIONS',unassigned:complete?evidence.source.unassigned:null,
      ...await projectRecords(records,publication,includeCompleted&&complete)};
  }

  async function read(date,publication=getPublication(),allowSource=false,includeCompleted=false) {
    let wmsFailure = null;
    const wms = await Promise.resolve().then(()=>readWmsExport?.(date)).catch(error=>{
      wmsFailure = safeExportFailure(error?.code);
      return null;
    });
    if (!wms && !wmsFailure) {
      const failure=readWmsExport?.configurationFailure?.(date);
      if (failure) wmsFailure=safeExportFailure(failure);
    }
    let projectionFailure = null;
    if (wms?.date===date && wms.center===CENTER) try {
      const codes = [...new Set(wms.vehicles.flatMap(({details})=>details.filter(row=>
        row.addressHash && publication?.registry?.get(row.customerCode)?.addressHash===row.addressHash).map(row=>row.customerCode)))];
      const postcodes = codes.length && readPostcodes
        ? await Promise.resolve().then(()=>readPostcodes(codes,publication?.postalGeneration)).catch(()=>null)
        : null;
      let completed;
      if (includeCompleted) {
        completed=(await archivedRoute(date,publication,true)).completedRows;
        if (!completed&&readRetainedDated) {
          completed=(await confirmedRoute(date,publication,readRetainedDated,true).catch(()=>null))?.completedRows;
        }
      }
      const current = getPublication();
      const matching = current?.generation===publication?.generation;
      const projected=projectOpsmapWmsDispatch(wms,matching?publication?.registry:null,matching?postcodes??undefined:undefined);
      if (matching&&completed) projected.route.completedRows=completed;
      if (!matching) projected.route.projectionFailure='PROJECTION_PUBLICATION_CHANGED';
      else if (projected.route.rows.length && !projected.route.rows.some(row=>row.coordinateVerified)) {
        projected.route.projectionFailure='PROJECTION_NO_VERIFIED_COORDINATES';
      }
      return {contract:CONTRACT,...projected};
    } catch {
      projectionFailure='PROJECTION_FAILED';
      // A registry/projection error can still leave verified amounts intact.
      try {
        const projected=projectOpsmapWmsDispatch(wms,null);
        return {contract:CONTRACT,...projected,route:{...projected.route,projectionFailure}};
      } catch { /* Existing verified dispatch and amount sources remain available below. */ }
    } else if (wms) wmsFailure=wms.date!==date?'DATE_MISMATCH':'WMS_EXPORT_WAREHOUSE_INVALID';
    const amountsRead = Promise.resolve().then(() => readAmounts?.(date)).catch(() => null);
    let route=await archivedRoute(date,publication,includeCompleted);
    if (route.state!=='VERIFIED'&&readRetainedDated) {
      route=await confirmedRoute(date,publication,readRetainedDated,includeCompleted).catch(()=>null)||route;
    }
    if (route.state!=='VERIFIED'&&allowSource&&readDated) {
      route=await confirmedRoute(date,publication,readDated,includeCompleted).catch(()=>null)||route;
    }
    const amounts = await amountsRead;
    return {contract:CONTRACT,date,center:CENTER,
      route:{...(publication && getPublication()?.generation !== publication.generation ? unavailableRoute() : route),
        ...(projectionFailure?{projectionFailure}:{})},
      amounts:{...(amounts?.date===date ? amounts : unavailableAmounts(date)), ...(wmsFailure?{exportFailure:wmsFailure}:{})}};
  }
  read.dated=date=>read(date,getPublication(),true);

  const dayJobs=new Map();
  function periodDay(date,publication) {
    const key=(publication?.generation??'')+'|'+date;
    const cached=dayJobs.get(key);
    if (cached&&cached.until>Date.now()) return cached.promise;
    if (dayJobs.size>=180) dayJobs.delete(dayJobs.keys().next().value);
    const promise=read(date,publication,false,true).then(projectDispatchPeriodDay);
    const entry={until:Date.now()+60_000,promise};
    dayJobs.set(key,entry);
    const expire=()=>{if (dayJobs.get(key)===entry) dayJobs.delete(key);};
    promise.then(result=>{if(result.state!=='VERIFIED') expire();},expire);
    return promise;
  }
  read.period=async (end,days)=>{
    const publication=getPublication();
    const dates=dispatchPeriodDates(end,days);
    const indexed=Array.isArray(publication?.dispatchDates)?new Set(publication.dispatchDates):null;
    const exports=new Set(readWmsExport?.dates??[]);
    const retained=new Set(retainedDatedDates?.()??[]);
    const latest=await Promise.resolve().then(()=>readAmounts?.latest?.()).catch(()=>null);
    const result=dates.map(date=>({date,state:'UNAVAILABLE'}));
    const eligible=dates.map((date,index)=>({date,index})).filter(({date})=>
      exports.has(date)||retained.has(date)||latest?.date===date||Boolean(publication?.readDay&&(!indexed||indexed.has(date))));
    let position=0;
    await Promise.all(Array.from({length:Math.min(eligible.length,3)},async ()=>{
      while (position<eligible.length) {
        const {date,index}=eligible[position++];
        result[index]=await periodDay(date,publication);
      }
    }));
    if (getPublication()?.generation!==publication?.generation) throw Error('DISPATCH_PERIOD_PUBLICATION_CHANGED');
    return {contract:'opsmap-dispatch-period-v1',center:CENTER,end,days,start:dates[0],dates:result};
  };
  return read;
}

export function mountOpsmapDispatchReference(app,{requireStaff, read, today, onDay}) {
  app.get('/api/map-phase2b/private/dispatch-reference-day',requireStaff,async (req,res) => {
    res.set('Cache-Control','private, no-store').vary('Cookie');
    const {date,source} = req.query;
    if (!exactDay(date)||date>today()||source!==undefined&&(source!=='dated'||date>=today())||
        Object.keys(req.query).some(key=>key!=='date'&&key!=='source')) {
      return res.status(400).json({error:'DISPATCH_REFERENCE_DATE_INVALID'});
    }
    try {
      const result = await (source==='dated'&&read.dated?read.dated(date):read(date));
      if (res.destroyed || res.writableEnded) return;
      return requireStaff(req,res,()=>{
        onDay?.(result);
        return res.json(result);
      });
    } catch {
      if (res.destroyed || res.writableEnded) return;
      return requireStaff(req,res,()=>res.status(503).json({error:'DISPATCH_REFERENCE_UNAVAILABLE'}));
    }
  });
  app.get('/api/map-phase2b/private/dispatch-reference-period',requireStaff,async (req,res)=>{
    res.set('Cache-Control','private, no-store').vary('Cookie');
    const {end,days}=req.query;
    if (!exactDay(end)||end>today()||typeof days!=='string'||!DISPATCH_PERIODS.some(period=>String(period)===days)||
        Object.keys(req.query).length!==2) return res.status(400).json({error:'DISPATCH_REFERENCE_PERIOD_INVALID'});
    try {
      const result=await read.period(end,Number(days));
      if (res.destroyed||res.writableEnded) return;
      return requireStaff(req,res,()=>res.json(result));
    } catch {
      if (res.destroyed||res.writableEnded) return;
      return requireStaff(req,res,()=>res.status(503).json({error:'DISPATCH_REFERENCE_PERIOD_UNAVAILABLE'}));
    }
  });
}
