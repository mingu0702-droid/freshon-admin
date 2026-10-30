// Production integration of the verified Stage lookup/auth routes only.
// Existing collector, Snapshot worker, ETA, route planner and data sources stay in server.js.
import express from 'express';
import compression from 'compression';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createMapStaffAuth} from './mapStaffAuth.js';
import {mountMapStaffEntryGate} from './mapStaffEntryGate.js';
import {staffLatency,addStaffTiming,addHubReadTiming} from './staffLatency.js';
import {staffCustomerDetail,staffStoreDetail} from './mapStaffDetail.js';
import {validatePeriod,selectPeriodStores,compactPeriodStores,readStaffDriverHistory} from './mapPeriod.js';
import {mapReadFailure} from './mapReadFailure.js';
import {historyDeadline} from './readDeadline.js';
import {createStageReadModel,stageReadModelPending} from './stageReadModel.js';
import {publicResponse,publicCustomerDetail,publicMapValue,securityAudit} from './phase2bSecurity.js';
import {callHub as verifiedHubRead,hubRequestProfile} from './phase2bHubReadClient.js';
import {createPhase2bReadCache} from './phase2bReadCache.js';
import {readPaginatedDatedAssignments,uniqueAssignments} from './phase2bAssignments.js';
import {mountMapDataFreshness} from './mapDataFreshness.js';
import {createCoordinateSupplement} from './mapCoordinateSupplement.js';
import {mountHybridMapReadApi} from './hybridMapRouter.js';
import {createPublishedDayPageReader} from './hybridDayIndex.js';
import {createRollingHubIo} from './rollingHubIo.js';
import {createPrivateDetailCache,loadEncryptedPrivateSnapshot} from './privateDetailCache.js';
import {createRoadRouteService,mountRoadRouteRoutes} from './roadRouteService.js';
import {createPreparedCustomerDetailReader} from './preparedCustomerDetails.js';
import {createHubRoadBudget} from './hubRoadBudget.js';
import {createPrivateDetailReadScope,privateDetailFailure} from './privateDetailRequest.js';

export function mountProductionMapApi(app,{
  previewEnabled,requireView,readPhase2bSnapshot,getSnapshotMemory,phase2bKstDate,
  normalizeCell,normalizeDateValue,phase2bSnapshotMeta,phase2bTodayStatus,
  callHub=verifiedHubRead,authOptions={},secret=process.env.HUB_API_SECRET,
  publicDir,getSnapshotWorkerState=()=>({}),readBaseVehicleMaster,
  hybridEnabled=()=>process.env.MAP_HYBRID_90DAY_ENABLED==='true',hybridReadIndexedDay,hybridUiReadiness,hybridReadDateCatalog,hybridReadDatePage,hybridReadVerifiedDayText,hybridStoredIoEnabled=false,hubPublicationCutover=null,
  mountPrivateExtensions,readRecordedRoadRoute,roadRouteService,roadRouteBudget
}){
  const mapStaff=createMapStaffAuth(authOptions);
  const env=authOptions.env||process.env;
  const preparedCustomerDetails=createPreparedCustomerDetailReader({callHub});
  roadRouteBudget??=createHubRoadBudget({callHub});
  const privateCacheEnabled=env.OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED==='1';
  const privateDetails=privateCacheEnabled
    ? createPrivateDetailCache({freshMs:60000,maxStaleMs:Math.min(86400000,Math.max(60000,Number(env.OPSMAP_PRIVATE_DETAIL_MAX_AGE_MS)||3600000)),maxEntries:512})
    : {get:async(_identity,{loader})=>{const loaded=await loader();return {value:loaded.value,meta:{cache:'DISABLED'}};}};
  const privateSnapshotReady=privateCacheEnabled
    ? loadEncryptedPrivateSnapshot({env,appRoot:publicDir?path.resolve(publicDir,'..'):process.cwd(),cache:privateDetails,normalize:staffCustomerDetail})
      .catch(error=>({loaded:false,reason:/^PRIVATE_CACHE_[A-Z_]+$/.test(error.code||'')?error.code:'PRIVATE_CACHE_UNAVAILABLE'}))
    : Promise.resolve({loaded:false,reason:'PRIVATE_CACHE_DISABLED'});
  const stageReadModelEnabled=true;
  const stageReadModel=createStageReadModel({secret,publicPeriodCacheEntries:1});
  const phase2bAssignmentCache=createPhase2bReadCache({name:'assignments',ttlMs:60000,staleMs:120000,maxEntries:8,maxBytes:12*1024*1024});
  const phase2bDatedAssignmentCache=createPhase2bReadCache({name:'datedAssignments',ttlMs:600000,staleMs:0,maxEntries:16,maxBytes:24*1024*1024});
  app.use(staffLatency);
  app.use('/api/map-phase2b/auth',securityAudit,mapStaff.router);
  mountMapStaffEntryGate(app,mapStaff.requireStaff);
  app.use('/api/map-phase2b/private',mapStaff.requireStaff);
  app.get('/api/map-phase2b/private/map-sdk-config',(req,res)=>{
    const javascriptKey=String(env.KAKAO_MAP_JAVASCRIPT_KEY||'').trim();
    if(!/^[a-f0-9]{32}$/i.test(javascriptKey))return res.status(503).json({error:'MAP_JAVASCRIPT_KEY_UNCONFIGURED'});
    return res.set('Cache-Control','private, no-store').json({javascriptKey});
  });
  mountRoadRouteRoutes({app,requireStaff:mapStaff.requireStaff,jsonBody:express.json({limit:'16kb'}),service:roadRouteService||createRoadRouteService({env,budget:roadRouteBudget,requireDurableBudget:true}),env,readRecordedRoute:readRecordedRoadRoute});
  mountPrivateExtensions?.({app,requireStaff:mapStaff.requireStaff,isSessionCurrent:mapStaff.isSessionCurrent,previewEnabled});
  app.use('/api/map-phase2b/private/driver-history',historyDeadline);
  app.use(publicResponse);
  if(hybridStoredIoEnabled){const stored=createRollingHubIo({callHub});hybridReadDateCatalog??=stored.readDateCatalog;hybridReadDatePage??=stored.readDatePage;}
  const hybrid=mountHybridMapReadApi(app,{enabled:hybridEnabled,requireStaff:mapStaff.requireStaff,previewEnabled,callHub,today:phase2bKstDate,readIndexedDay:hybridReadIndexedDay,readDateCatalog:hybridReadDateCatalog,readDatePage:hybridReadDatePage||(hybridReadVerifiedDayText?createPublishedDayPageReader({readVerifiedText:hybridReadVerifiedDayText}):undefined),uiReadiness:hybridUiReadiness,publicationCutover:hubPublicationCutover,legacyBusy:()=>!!getSnapshotWorkerState().running});
  const publishedReads=hybrid.publicationReadGate;
  const pagedRequired=res=>res.status(409).json({ok:false,data:null,error:'HUB_PAGED_READ_REQUIRED',source:'HUB_PUBLISHED',catalog:'/api/map-phase2b/hybrid/catalog',range:'/api/map-phase2b/hybrid/range',manifest:'/api/map-phase2b/hybrid/manifest'});
  // Existing paged B client must be verified before the explicit cutover pin is set.
  // Never emulate the old whole-snapshot response by concatenating all Hub chunks.
  app.get('/api/map-phase2b/preview/snapshot',requireView,(_req,res,next)=>publishedReads.isActive()?pagedRequired(res):next());
  const mapFreshness=mountMapDataFreshness(app,{callHub,requireView,requireBaseVehicleView:mapStaff.requireStaff,previewEnabled,modelStatus:stageReadModel.status,readBaseVehicleMaster});
  const coordinateSupplement=createCoordinateSupplement({callHub});
  if(process.env.RENDER_EXTERNAL_URL==='https://freshon-admin-1.onrender.com')void coordinateSupplement.refresh();
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
    if(publishedReads.isActive())return res.set('Cache-Control','private, no-store').json({enabled:true,readOnly:true,source:'HUB_PUBLISHED',publication:publishedReads.status(),snapshot:null});
    const metadataOnly=_req.query?.metadataOnly==='1';
    // Reuse the existing authenticated handler and memory supplier. This mode
    // NEVER starts a file/body load, Hub request, collection, restore or write.
    const payload=metadataOnly?getSnapshotMemory():await readPhase2bSnapshot(),meta=phase2bSnapshotMeta(payload);
    if(metadataOnly){
      const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v?v:null;
      return res.set('Cache-Control','private, no-store').json({enabled:true,readOnly:true,source:'EXISTING_RENDER_SNAPSHOT_MEMORY',
        loaded:payload!=null,version:typeof meta.version==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(meta.version)?meta.version:null,
        latestDate:day(meta.latestDate),startDate:day(meta.startDate),refreshedThrough:day(meta.refreshedThrough),
        generatedAt:typeof meta.generatedAt==='string'&&meta.generatedAt.length<=40&&Number.isFinite(Date.parse(meta.generatedAt))?new Date(meta.generatedAt).toISOString():null,
        rowCount:payload!=null&&Number.isSafeInteger(meta.rowCount)&&meta.rowCount>=0?meta.rowCount:null,stale:meta.stale!==false,
        publicPointerVerified:false,sourceCompletenessVerified:false,privateSealedVerified:false});
    }
    const worker=getSnapshotWorkerState();
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
  const storeView = req.query.view === 'store';
  if (req.query.view && !storeView) return res.status(400).json({error:'INVALID_DETAIL_VIEW'});
  const detailDate = req.query.date ? normalizeDateValue(req.query.date) : getSnapshotMemory()?.latestDate || phase2bKstDate();
  if (!detailDate) return res.status(400).json({ error: "INVALID_DATE" });
  // A current Customer lookup is independent of a delivery day. For a planned
  // delivery, notes require observed dated evidence rather than an echoed date.
  if (!storeView && detailDate > phase2bKstDate()) {
    let observed=false;
    try { observed=stageReadModel.period(detailDate,detailDate).data.some(row=>row.customerCode===customerCode); } catch {}
    if(!observed)return res.status(202).set('Cache-Control','private, no-store').json({ok:false,data:null,error:'PLANNED_SOURCE_UNOBSERVED',meta:{date:detailDate,planned:true,sourceObserved:false}});
  }
  const scope=createPrivateDetailReadScope(req,res,{deadline:Date.now()+(storeView?15000:20000)});
  try {
    await privateSnapshotReady;
    const detailIdentity={customerCode,date:detailDate,view:storeView?'store':'notes'};
    const legacyLoader=()=>privateDetails.get(detailIdentity,{preferFresh:req.query.refresh==='1',loader:async()=>{
      const upstreamStarted=performance.now();
      let hub;
      try{hub=await callHub(storeView?'customerDetail':'staffCustomerDetail',storeView?{customerCode}:{customerCode,date:detailDate},{useCache:false,privateRead:true,maxResponseBytes:65536,signal:scope.signal,deadline:scope.deadline});}
      finally{if(!res.headersSent)addStaffTiming(res,'upstream',performance.now()-upstreamStarted);}
      if(hub?.ok===false || String(hub?.data?.customerCode||'').toUpperCase()!==customerCode || !storeView && ['memoDate','deliveryDate'].some(key=>hub.data[key] && hub.data[key]!==detailDate))throw Object.assign(new Error('HUB_INVALID_DETAIL_CONTRACT'),{failureType:'contract'});
      const detail=(storeView?staffStoreDetail:staffCustomerDetail)(hub.data,{customerCode,date:storeView?null:detailDate});
      return {value:detail,sourceVersion:hub.meta?.version||hub.meta?.sourceVersion||null};
    }});
    const result=env.OPSMAP_PREPARED_DETAILS_ENABLED==='1'
      ?await preparedCustomerDetails.read(detailIdentity,{legacyLoader,refresh:req.query.refresh==='1'})
      :await legacyLoader();
    // Even a cache HIT must recheck the employee session. Plaintext is never
    // sent to public snapshots, browser persistent storage, or response caches.
    if(!scope.canRespond())return;
    return await mapStaff.requireStaff(req,res,()=>scope.canRespond()&&res.set('Cache-Control','private, no-store').json({ok:true,data:result.value,meta:{cache:result.meta},error:null}));
  } catch (error) {
    const profile = {...hubRequestProfile(error),...(scope.signal.aborted?{cancelledBy:'CALLER'}:{})};
    const failure=privateDetailFailure(error,profile);
    console.warn(JSON.stringify({component:'private-detail-read',...failure,totalMs:Number(profile.totalMs)||0}));
    if(!scope.canRespond())return;
    res.set('X-Detail-Upstream-Status', String(Number(profile.upstreamStatus) || 0));
    res.set('X-Detail-Response-Kind', ['json','health-json','html','invalid-json','none'].includes(profile.responseKind) ? profile.responseKind : 'unknown');
    res.set('X-Detail-Failure-Phase', ['HEADERS','BODY','PARSE','CONTRACT'].includes(profile.phase) ? profile.phase : 'unknown');
    res.set('X-Detail-Failure-Target', ['EXEC','OUTPUT'].includes(profile.requestStage)?profile.requestStage:'unknown');
    for (const key of ['responseHeadersMs','bodyReadMs','parseMs']) addStaffTiming(res, 'hub' + key.replace(/Ms$/, ''), Number(profile[key] || 0));
    return res.status(failure.status).json({ ok: false, data: null, error:failure.code,meta:{failure} });
  } finally {scope.dispose();}
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
  if(publishedReads.isActive())return res.json({source:'HUB_PUBLISHED',publication:publishedReads.status(),range:'/api/map-phase2b/hybrid/range'});
  try { return res.json(stageReadModelEnabled ? stageReadModel.status() : periodJobs.peek(String(req.query.startDate || ''), String(req.query.endDate || ''))); }
  catch { return res.status(400).json({error:'INVALID_PERIOD'}); }
});

app.get("/api/map-phase2b/preview/period", requireView, compression({ threshold: 1024 }), async (req, res) => {
  if(publishedReads.isActive())return pagedRequired(res);
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
    // Separate evidence is preloaded; no full source read blocks a Period query.
    if(process.env.RENDER_EXTERNAL_URL==='https://freshon-admin-1.onrender.com')void coordinateSupplement.refresh();
    result.data=coordinateSupplement.join(result.data);
    result.meta.coordinateSupplement=coordinateSupplement.status();
    result.meta.missingCoordinate = result.data.filter(row => row.lat == null || row.lng == null).length;
    result.data = compactPeriodStores(result.data); result.meta.summaryContract = 'period-store-relations-v1';
  }
  return res.status(result.meta.phase === "ERROR" ? mapReadFailure(new Error(result.error),'PERIOD').status : result.meta.complete ? 200 : 202).json(result);
});


app.get("/api/map-phase2b/preview/assignments", requireView, async (req, res) => {
  if(publishedReads.isActive())return pagedRequired(res);
  if (!previewEnabled()) return res.status(404).json({ error: "PREVIEW_DISABLED" });
  const date = String(req.query.date || "");
  if (date !== "latest" && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || normalizeDateValue(date) !== date)) return res.status(400).json({ error: "INVALID_DATE" });
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
    if(candidate>phase2bKstDate()){
      const observed=loaded.value.data.length>0;
      return res.status(observed?200:202).json({...loaded.value,...(!observed?{ok:false,error:'PLANNED_SOURCE_UNOBSERVED'}:{}),meta:{...loaded.value.meta,planned:true,sourceObserved:observed,...(!observed?{sourceReadComplete:true,complete:false,phase:'PENDING'}:{})}});
    }
    return res.json(loaded.value);
  } catch (error) {
    return res.status(502).json({ ok: false, data: null, error: error.message });
  }
});


  // This request restores only an existing published generation to production.
  // Missing published state must fail closed in Hub; never fall back to BUILD.
  async function requestPublishedModel(attempt=1){
    if(publishedReads.isActive())return; // A feature flag alone is not a verified replacement.
    if(!previewEnabled()||stageReadModel.status().ready)return;
    try{
      const response=await callHub('stageReadModelRequest',{target:'production'},{useCache:false});
      if(response.data?.phase==='BUSY'&&attempt<3)setTimeout(()=>requestPublishedModel(attempt+1),120000).unref();
    }catch(error){
      if(attempt<3&&(error.name==='AbortError'||error.message==='HUB_TIMEOUT'))setTimeout(()=>requestPublishedModel(attempt+1),120000).unref();
      console.warn('Production published lookup restore request not acknowledged.');
    }
  }
  return {requestPublishedModel,status:stageReadModel.status,initializePublishedReads:publishedReads.initialize,usePublishedHubReads:publishedReads.isActive,publishedReadStatus:publishedReads.status};
}
