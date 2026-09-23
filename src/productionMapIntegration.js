// Production integration of the verified Stage lookup/auth routes only.
// Existing collector, Snapshot worker, ETA, route planner and data sources stay in server.js.
import express from 'express';
import compression from 'compression';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createMapStaffAuth} from './mapStaffAuth.js';
import {staffLatency,addStaffTiming,addHubReadTiming} from './staffLatency.js';
import {staffCustomerDetail} from './mapStaffDetail.js';
import {validatePeriod,selectPeriodStores,compactPeriodStores,readStaffDriverHistory} from './mapPeriod.js';
import {mapReadFailure} from './mapReadFailure.js';
import {historyDeadline} from './readDeadline.js';
import {createStageReadModel,stageReadModelPending} from './stageReadModel.js';
import {publicResponse,publicCustomerDetail,publicMapValue,securityAudit} from './phase2bSecurity.js';
import {callHub as verifiedHubRead,hubRequestProfile} from './phase2bHubReadClient.js';
import {createPhase2bReadCache} from './phase2bReadCache.js';
import {readPaginatedDatedAssignments,uniqueAssignments} from './phase2bAssignments.js';
import {mountMapDataFreshness} from './mapDataFreshness.js';

export function mountProductionMapApi(app,{
  previewEnabled,requireView,readPhase2bSnapshot,getSnapshotMemory,phase2bKstDate,
  normalizeCell,normalizeDateValue,phase2bSnapshotMeta,phase2bTodayStatus,
  callHub=verifiedHubRead,authOptions={},secret=process.env.HUB_API_SECRET,
  publicDir,getSnapshotWorkerState=()=>({}),readBaseVehicleMaster
}){
  const mapStaff=createMapStaffAuth(authOptions);
  const stageReadModelEnabled=true;
  const stageReadModel=createStageReadModel({secret});
  const phase2bAssignmentCache=createPhase2bReadCache({name:'assignments',ttlMs:60000,staleMs:120000,maxEntries:8,maxBytes:12*1024*1024});
  const phase2bDatedAssignmentCache=createPhase2bReadCache({name:'datedAssignments',ttlMs:600000,staleMs:0,maxEntries:16,maxBytes:24*1024*1024});
  app.use(staffLatency);
  app.use('/api/map-phase2b/auth',securityAudit,mapStaff.router);
  app.use('/api/map-phase2b/private',mapStaff.requireStaff);
  app.use('/api/map-phase2b/private/driver-history',historyDeadline);
  app.use(publicResponse);
  const mapFreshness=mountMapDataFreshness(app,{callHub,requireView,previewEnabled,modelStatus:stageReadModel.status,readBaseVehicleMaster});
  if(publicDir)app.get(['/map-phase2b-snapshot.json','/customer-master-20260604.json','/vehicle-data.js','/new-area-data.js'],async(req,res)=>{
    try{
      const raw=await fs.readFile(path.join(publicDir,path.basename(req.path)),'utf8');
      const assignment=raw.match(/^\s*(window\.[A-Z_]+)\s*=\s*([\s\S]*?);?\s*$/);
      const clean=publicMapValue(JSON.parse(assignment?assignment[2]:raw));
      res.set('Cache-Control','no-store');
      return assignment?res.type('application/javascript').send(assignment[1]+' = '+JSON.stringify(clean)+';'):res.json(clean);
    }catch{return res.status(503).json({error:'PUBLIC_DATA_UNAVAILABLE'});}
  });
  // Read-only UI projection; does not change or schedule the existing Snapshot worker.
  app.get('/api/map-phase2b/preview/status',requireView,async(_req,res)=>{
    if(!previewEnabled())return res.status(404).json({error:'PREVIEW_DISABLED'});
    const payload=await readPhase2bSnapshot(),meta=phase2bSnapshotMeta(payload),worker=getSnapshotWorkerState();
    const phase=worker.running?'RUNNING':!meta.stale?'DONE':'WAITING';
    return res.json({enabled:true,hubAuth:null,snapshot:{phase,latest:meta.latestDate,targetLatest:phase2bKstDate(),stale:meta.stale,
      progress:phase==='DONE'?100:null,continuation:worker.continuation?'ACTIVE':'NONE',updatedAt:meta.generatedAt}});
  });
  app.post('/internal/stage-read-model',express.json({limit:'10mb'}),(req,res)=>{
    res.set('Cache-Control','private, no-store');
    if(!previewEnabled())return res.status(404).end();
    try{stageReadModel.ingest(req.body,req.get('x-stage-model-signature'));return res.json({ok:true});}
    catch(error){return res.status(['MODEL_AUTH','MODEL_REPLAY'].includes(error.message)?401:409).json({ok:false,error:'MODEL_REJECTED'});}
  });
app.get("/api/map-phase2b/preview/detail", requireView, async (req, res) => {
  if (!previewEnabled()) return res.status(404).json({ error: "PREVIEW_DISABLED" });
  const customerCode = normalizeCell(req.query.customerCode).toUpperCase();
  if (!/^[A-Z]\d{3,}$/.test(customerCode)) return res.status(400).json({ error: "INVALID_CUSTOMER_CODE" });
  try {
    const publicStarted = performance.now();
    const snapshot = await readPhase2bSnapshot();
    const row = snapshot?.rows?.find(item => String(item.customerCode || item.code) === customerCode);
    if (!row) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    const data = publicCustomerDetail({ ...row, customerCode });
    addStaffTiming(res, 'parseNormalize', performance.now() - publicStarted);
    return res.json({ ok: true, data, error: null });
  } catch { return res.status(503).json({ ok: false, error: "PUBLIC_DETAIL_UNAVAILABLE" }); }
});

app.get("/api/map-phase2b/private/customer-detail", async (req, res) => {
  if (!previewEnabled()) return res.status(404).json({ error: "PREVIEW_DISABLED" });
  const customerCode = normalizeCell(req.query.customerCode).toUpperCase();
  if (!/^[A-Z]\d{3,}$/.test(customerCode)) return res.status(400).json({ error: "INVALID_CUSTOMER_CODE" });
  const detailDate = req.query.date ? normalizeDateValue(req.query.date) : getSnapshotMemory()?.latestDate || phase2bKstDate();
  if (!detailDate || detailDate > phase2bKstDate()) return res.status(400).json({ error: "INVALID_DATE" });
  try {
    const upstreamStarted = performance.now();
    let hub;
    try { hub = await callHub("staffCustomerDetail", { customerCode, date: detailDate }, { useCache: false, privateRead: true }); }
    finally { addStaffTiming(res, 'upstream', performance.now() - upstreamStarted); }
    addStaffTiming(res, 'hub', Number(hub.meta?.durationMs || 0));
    for (const key of ['responseHeadersMs','bodyReadMs','parseMs']) addStaffTiming(res, 'hub' + key.replace(/Ms$/, ''), Number(hubRequestProfile(hub)[key] || 0));
    for (const key of ['openMs','lookupMs','rowReadMs','normalizeMs']) addStaffTiming(res, 'source' + key.replace(/Ms$/, ''), Number(hub.meta?.detailProfile?.[key] || 0));
    if (String(hub.data?.customerCode || '').toUpperCase() !== customerCode) throw new Error('HUB_INVALID_DETAIL_CONTRACT');
    const normalizeStarted = performance.now();
    const detail = staffCustomerDetail(hub.data, { customerCode, date: detailDate });
    addStaffTiming(res, 'parseNormalize', performance.now() - normalizeStarted);
    // Recheck after slow Hub reads: logout/expiry must revoke in-flight responses.
    return mapStaff.requireStaff(req, res, () => res.json({ ok: true, data: detail, error: null }));
  } catch (error) {
    const profile = hubRequestProfile(error);
    res.set('X-Detail-Upstream-Status', String(Number(profile.upstreamStatus) || 0));
    res.set('X-Detail-Response-Kind', ['json','health-json','html','invalid-json','none'].includes(profile.responseKind) ? profile.responseKind : 'unknown');
    res.set('X-Detail-Failure-Phase', ['HEADERS','BODY','PARSE','CONTRACT'].includes(profile.phase) ? profile.phase : 'unknown');
    for (const key of ['responseHeadersMs','bodyReadMs','parseMs']) addStaffTiming(res, 'hub' + key.replace(/Ms$/, ''), Number(profile[key] || 0));
    const timeout = error?.name === 'AbortError';
    const status = timeout ? 504 : Number(error?.upstreamStatus) === 404 && error?.failureType === "upstream" ? 404 : 502;
    return res.status(status).json({ ok: false, data: null, error: timeout ? 'DETAIL_UPSTREAM_TIMEOUT' : 'PRIVATE_DETAIL_UNAVAILABLE' });
  }
});

app.get("/api/map-phase2b/private/driver-history", async (req, res) => {
  if (!previewEnabled()) return res.status(404).json({ error: "PREVIEW_DISABLED" });
  const customerCode = normalizeCell(req.query.customerCode).toUpperCase();
  if (!/^[A-Z]\d{3,}$/.test(customerCode)) return res.status(400).json({ error: "INVALID_CUSTOMER_CODE" });
  const endDate = String(req.query.endDate || req.query.date || phase2bKstDate());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(Date.parse(endDate))) return res.status(400).json({ error: "INVALID_PERIOD" });
  const startDate = String(req.query.startDate || new Date(Date.parse(endDate) - 59 * 86400000).toISOString().slice(0, 10));
  try { validatePeriod(startDate, endDate); if (endDate > phase2bKstDate()) throw new Error(); }
  catch { return res.status(400).json({ error: "INVALID_PERIOD" }); }
  try {
    const readAt = performance.now(); let upstreamMs = 0;
    req.historyBudget.check();
    const data = stageReadModelEnabled ? stageReadModel.history({customerCode,startDate,endDate}) : await readStaffDriverHistory({ customerCode, startDate, endDate }, async (params, options) => {
      const at = performance.now();
      try {
        const payload = await callHub("staffDriverHistory", params, { useCache: false, privateRead: true, ...options });
        addHubReadTiming(res, hubRequestProfile(payload));
        return payload;
      } finally { const elapsed = performance.now() - at; upstreamMs += elapsed; addStaffTiming(res, 'upstream', elapsed); }
    }, { budget: req.historyBudget, requireDelivery: true });
    addStaffTiming(res, 'parseNormalize', Math.max(0, performance.now() - readAt - upstreamMs));
    req.historyBudget.check();
    const dates = [...new Set(data.map(row => row.deliveryDate))].sort();
    const unconfirmedDates = [];
    for (let at = Date.parse(startDate); at <= Date.parse(endDate); at += 86400000) unconfirmedDates.push(new Date(at).toISOString().slice(0,10));
    // A stored task proves that task, not completeness of a whole business date.
    return mapStaff.requireStaff(req, res, () => res.json({ ok: true, data, meta: { complete: true, ...mapFreshness.coverage(startDate,endDate,'history'),
      coverage: stageReadModelEnabled ? 'AUDITED_STORED_TASKS_DATE_COMPLETENESS_UNCONFIRMED' : 'PARTIAL_UNAUDITED', availableRecordDates: dates, startDate, endDate, source: 'Delivery.delivery_admin_raw', readModel:stageReadModelEnabled?'Hub.StageReadModel':null } }));
  } catch(error) {
    if(stageReadModelEnabled && /^READ_MODEL_/.test(error.message))return res.status(503).json({error:error.message,retryable:true});
    const failure = mapReadFailure(error, 'HISTORY');
    if (res.destroyed) return;
    addHubReadTiming(res, hubRequestProfile(error));
    res.set('X-History-Failure', failure.code);
    return res.status(failure.status).json({ error: failure.code, retryable: failure.retryable });
  }
});

app.get('/api/map-phase2b/preview/period-status', requireView, (req, res) => {
  if (!previewEnabled()) return res.status(404).json({error:'PREVIEW_DISABLED'});
  try { return res.json(stageReadModelEnabled ? stageReadModel.status() : periodJobs.peek(String(req.query.startDate || ''), String(req.query.endDate || ''))); }
  catch { return res.status(400).json({error:'INVALID_PERIOD'}); }
});

app.get("/api/map-phase2b/preview/period", requireView, compression({ threshold: 1024 }), async (req, res) => {
  if (!previewEnabled()) return res.status(404).json({ error: "PREVIEW_DISABLED" });
  const startDate = String(req.query.startDate || ""), endDate = String(req.query.endDate || "");
  const vehicle=String(req.query.vehicle||''),driverKey=String(req.query.driverKey||'');
  if((vehicle&&driverKey)||(vehicle&&!/^\d{1,3}$/.test(vehicle))||(driverKey&&!/^[A-Za-z0-9_-]{1,128}$/.test(driverKey)))return res.status(400).json({error:'INVALID_PERIOD_FILTER'});
  try { validatePeriod(startDate, endDate); if (endDate > phase2bKstDate()) throw new Error(); }
  catch { return res.status(400).json({ error: "INVALID_PERIOD" }); }
  let result;
  try { result = stageReadModelEnabled ? stageReadModel.period(startDate,endDate) : periodJobs.read(startDate, endDate,{retry:req.query.retry==='1'}); }
  catch(error){if(/^READ_MODEL_/.test(error.message)){const pending=stageReadModelPending(stageReadModel,error);return res.status(pending.status).json(pending.body);}throw error;}
  if (result.meta.complete) {
    Object.assign(result.meta,mapFreshness.coverage(startDate,endDate,'period'));
    result.data=selectPeriodStores(result.data,{vehicle,driverKey});
    result.meta.storeCount=result.data.length;result.meta.filterMode=driverKey?'driver':vehicle?'vehicle':'all';
    const snapshot = await readPhase2bSnapshot();
    const coords = new Map((snapshot?.rows || []).map(row => [row.customerCode, row]));
    result.data = result.data.map(row => ({ ...row, customerName: row.customerName || coords.get(row.customerCode)?.customerName || '', address: row.address || coords.get(row.customerCode)?.address || '', lat: coords.get(row.customerCode)?.lat ?? null, lng: coords.get(row.customerCode)?.lng ?? null }));
    result.meta.missingCoordinate = result.data.filter(row => row.lat == null || row.lng == null).length;
    result.data = compactPeriodStores(result.data); result.meta.summaryContract = 'period-store-relations-v1';
  }
  return res.status(result.meta.phase === "ERROR" ? mapReadFailure(new Error(result.error),'PERIOD').status : result.meta.complete ? 200 : 202).json(result);
});


app.get("/api/map-phase2b/preview/assignments", requireView, async (req, res) => {
  if (!previewEnabled()) return res.status(404).json({ error: "PREVIEW_DISABLED" });
  const date = String(req.query.date || "");
  if (date !== "latest" && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || normalizeDateValue(date) !== date || date > phase2bKstDate())) return res.status(400).json({ error: "INVALID_DATE" });
  try {
    const snapshot = await readPhase2bSnapshot();
    const readDate = (candidate) => (candidate === phase2bKstDate() ? phase2bAssignmentCache : phase2bDatedAssignmentCache).load(`datedAssignments:${candidate}`, async () => {
      if (candidate === phase2bKstDate()) {
        // Current dispatch is already available through the approved read-only
        // Delivery adapter. It is not a rolling Hub vehicle relationship.
        try {
          const live = await phase2bTodayStatus(candidate);
          const coordinates = new Map((snapshot?.rows || []).map((row) => [String(row.customerCode || row.code), row]));
          const actual = live.vehicles.flatMap((vehicle) => vehicle.stops.map((stop) => {
            const code = String(stop.customerCode || stop.code || "");
            const point = coordinates.get(code) || {};
            return { ...stop, customerCode: code, vehicle: vehicle.vehicle, deliveryDate: candidate,
              lat: stop.lat ?? point.lat ?? null, lng: stop.lng ?? point.lng ?? null };
          }));
          const data = uniqueAssignments(actual, candidate);
          if (data.length) return { ok: true, data, meta: { date: candidate, source: "Delivery Admin current dispatch", complete: true, rowCount: data.length, generatedAt: live.generatedAt }, error: null };
        } catch (error) {
          console.warn(JSON.stringify({ component: "phase2b-assignments", source: "Delivery", error: error.message }));
        }
      }
      // Only a verified final page resolves this loader and enters the cache.
      return readPaginatedDatedAssignments(candidate, params => callHub("datedAssignments", params, { useCache: false }));
    });
    const verifiedSnapshotDate = snapshot && !phase2bSnapshotMeta(snapshot).stale && snapshot.refreshedThrough >= phase2bKstDate() ? snapshot.latestDate : "";
    let candidate = date === "latest" ? phase2bKstDate() : date;
    let loaded;
    for (let offset = 0; offset < (date === "latest" ? 8 : 1); offset++) {
      loaded = await readDate(candidate);
      if (loaded.value.data.length || date !== "latest") break;
      candidate = verifiedSnapshotDate && offset === 0 && verifiedSnapshotDate < candidate ? verifiedSnapshotDate : new Date(Date.parse(`${candidate}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    }
    if (date === "latest" && !loaded.value.data.length) return res.status(503).json({ ok: false, error: "LATEST_BUSINESS_DATE_UNAVAILABLE" });
    res.setHeader("X-Phase2B-Cache", loaded.cache);
    return res.json(loaded.value);
  } catch (error) {
    return res.status(502).json({ ok: false, data: null, error: error.message });
  }
});


  // This request restores only an existing published generation to production.
  // Missing published state must fail closed in Hub; never fall back to BUILD.
  async function requestPublishedModel(attempt=1){
    if(!previewEnabled()||stageReadModel.status().ready)return;
    try{
      const response=await callHub('stageReadModelRequest',{target:'production'},{useCache:false});
      if(response.data?.phase==='BUSY'&&attempt<3)setTimeout(()=>requestPublishedModel(attempt+1),120000).unref();
    }catch(error){
      if(attempt<3&&(error.name==='AbortError'||error.message==='HUB_TIMEOUT'))setTimeout(()=>requestPublishedModel(attempt+1),120000).unref();
      console.warn('Production published lookup restore request not acknowledged.');
    }
  }
  return {requestPublishedModel,status:stageReadModel.status};
}
