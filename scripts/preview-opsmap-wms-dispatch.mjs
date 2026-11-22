import express from 'express';
import { execFileSync } from 'node:child_process';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_ORIGIN, STAGE_SERVICE } from '../src/stageScope.js';
import { checkStageVerifiedBaseline, createOpsmapDurableGeneration, stageVerifiedBaselineConfig, STAGE_BASELINE_PREFIX } from '../src/opsmapDurableGeneration.js';
import { createStagePostalAssets } from '../src/shadowCoverage/stagePostalAssets.js';
import { createPostalRuntime } from '../src/shadowCoverage/postal.js';
import { createOpsmapDispatchReferenceReader, mountOpsmapDispatchReference } from '../src/opsmapDispatchReference.js';
import { parseOpsmapWmsDispatchExport } from '../src/opsmapWmsDispatchExport.js';
import { validateFixedEnvelope } from '../src/fixedVehicleStore.js';
import { SYNC_DELIVERY_SOURCES } from '../src/opsmapSyncPolicy.js';

async function main() {
  const [date,workbook,archive,archiveRef,portText='8875',...history] = process.argv.slice(2);
  const port = Number(portText);
  if (!date || !workbook || !archive || !/^refs\/readonly\/[\w-]+$/.test(archiveRef||'') ||
      !Number.isInteger(port) || port<1024 || port>65535) throw Error('WMS_PREVIEW_ARGUMENTS');

  const stage = {...process.env,RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN};
  const baseline = stageVerifiedBaselineConfig(stage,stage.OPSMAP_STAGE_INDEPENDENT_BASELINE_JSON);
  if (!baseline) throw Error('WMS_PREVIEW_REGISTRY_CONFIGURATION');
  const exportsByDate=new Map();
  for (const entry of [date+'='+workbook,...history]) {
    const split=entry.indexOf('='), requested=entry.slice(0,split), file=entry.slice(split+1);
    if (split!==10||exportsByDate.has(requested)) throw Error('WMS_PREVIEW_ARGUMENTS');
    exportsByDate.set(requested,parseOpsmapWmsDispatchExport(await readFile(file),{
      date:requested,observedAt:(await stat(file)).mtime.toISOString()}));
  }
  const root = await mkdtemp(path.join(tmpdir(),'opsmap-wms-preview-'));
  const dir = fileURLToPath(new URL('../public/opsmap/',import.meta.url));
  let result, postal, registry, readHistory, dispatchDates;
  const projected=new Map();
  function readArchived(name) {
    return JSON.parse(execFileSync('git',['--git-dir='+path.resolve(archive),'show',archiveRef+':'+name],
      {encoding:'utf8',maxBuffer:20*1024*1024}));
  }
  process.once('exit',()=>{try { rmSync(root,{recursive:true,force:true}); } catch {}});
  try {
    const storage=createOpsmapDurableGeneration({key:baseline.baselineKey,tempRoot:root,readOnlyView:true,retainCoverageFiles:false,store:{
      async read(name) {
        if (!/^(?:release|day)-[a-f0-9]{64}\.json$/.test(name)) throw Error('WMS_PREVIEW_ARCHIVE_SCOPE');
        const value=readArchived(STAGE_BASELINE_PREFIX+'/'+name);
        return {value};
      },
    }});
    const generation=checkStageVerifiedBaseline(await storage.readBaseline(baseline.ref));
    registry=generation.registry;
    const assetSource=createStagePostalAssets({env:stage,tempRoot:root,log:()=>{}});
    postal=assetSource && createPostalRuntime({assetSource,appRoot:path.resolve(dir,'../..'),
      boundarySha256:assetSource.config.boundary,releaseSha256:assetSource.config.release,
      overviewSha256:assetSource.config.overview,reviewSha256:assetSource.config.review,
      readPublication:()=>({index:generation.index}),});
    dispatchDates=generation.vehicleDelivery.completeSources[SYNC_DELIVERY_SOURCES.osan];
    const readWmsExport=requested=>exportsByDate.get(requested)??null;
    readWmsExport.dates=[...exportsByDate.keys()];
    readHistory=createOpsmapDispatchReferenceReader({
      getPublication:()=>({generation:generation.index.sha256,postalGeneration:generation.index.sha256,registry,dispatchDates,
        readDay:requested=>storage.readDay(requested,generation)}),
      readPostcodes:(codes,generationId)=>postal?.dispatchPostcodes(codes,generationId),
      readWmsExport,
      readAmounts:()=>null,
    });
    for (const requested of exportsByDate.keys()) projected.set(requested,await readHistory(requested));
    result=projected.get(date);
  } catch (error) {
    await rm(root,{recursive:true,force:true});
    throw error;
  }
  // The preview reads shared Stage registry assets at startup only. Requests never see upstream credentials.
  for (const name of ['OPSMAP_STAGE_INDEPENDENT_BASELINE_JSON','OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64','OPSMAP_SNAPSHOT_STORE_TOKEN']) delete process.env[name];
  const app=express();
  app.disable('x-powered-by');
  const host='127.0.0.1:'+port, origin='http://'+host;
  const local=(req,res,next)=>{
    if (req.socket.remoteAddress!=='127.0.0.1'||req.get('Host')!==host||
        (req.get('Origin')&&req.get('Origin')!==origin)||req.get('Sec-Fetch-Site')==='cross-site') return res.status(403).end();
    res.set({'Cache-Control':'private, no-store','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'"});
    next();
  };
  app.use(local);
  app.use((req,_res,next)=>{
    if (/^\/opsmap\/(?:api\/|(?:vehicle-data|new-area-data|admin-features)\.js)/.test(req.url)) req.url=req.url.slice('/opsmap'.length);
    next();
  });
  const stores=new Map();
  for (const row of [...projected.values()].flatMap(day=>day.route.rows)) {
    if (stores.has(row.customerCode)||!row.registryMatched) continue;
    const match=registry.get(row.customerCode);
    stores.set(row.customerCode,{center:'osan',customerCode:row.customerCode,customerName:row.customerName,
      address:match?.address||'',lat:row.lat,lng:row.lng,postalCode:row.postalCode,vehicle:row.vehicle,
      coordinateStatus:row.coordinateVerified?'CONFIRMED':'UNKNOWN',coordinateSource:row.coordinateVerified?'SNAPSHOT':'',
      lastDeliveryDate:date,visitCount:1});
  }
  let master;
  try {
    const prefix='opsmap-stage/fixed-master-daily-v1/';
    const {current}=readArchived(prefix+'head.json');
    if (!/^[a-f0-9]{64}$/.test(current?.version||'')) throw Error('WMS_PREVIEW_FIXED_POINTER');
    master=validateFixedEnvelope(readArchived(prefix+'projection-'+current.version+'.json'));
    if (master.envelope.version!==current.version||master.envelope.count!==current.count) throw Error('WMS_PREVIEW_FIXED_POINTER');
  } catch {
    master=null;
  }
  const fixedData=new Map((master?.data||[]).filter(row=>stores.has(row.customerCode)).map(row=>[row.customerCode,row]));
  app.get('/api/map-phase2b/auth/session',(_req,res)=>{
    const expiresAt=Date.now()+3600000;
    res.json({authenticated:true,expiresAt,idleExpiresAt:expiresAt});
  });
  app.get('/api/map-phase2b/preview/snapshot',(_req,res)=>res.json({data:[...stores.values()],
    meta:{complete:true,latestDate:date,startDate:date,endDate:date}}));
  app.post('/api/map-phase2b/preview/base-vehicles',express.json({limit:'32kb'}),(req,res)=>{
    const {customerCodes}=req.body||{};
    if (!Array.isArray(customerCodes)||customerCodes.length>5000||
        customerCodes.some(code=>typeof code!=='string'||!/^[A-Z]\d{1,20}$/.test(code))) return res.status(400).end();
    if (!master) return res.json({ok:false,phase:'ERROR'});
    const {version,checkedAt}=master.envelope;
    const data=customerCodes.map(customerCode=>({customerCode,baseVehicleState:'UNKNOWN',...fixedData.get(customerCode),
      baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleCheckedAt:checkedAt,baseVehicleStale:false}));
    return res.json({ok:true,data,meta:{basis:'FIXED_DISPATCH_PRIMARY',version,checkedAt,stale:false,refresh:'IDLE'}});
  });
  app.get('/api/map-phase2b/private/map-sdk-config',(_req,res)=>res.json({allowExternalAddressLookup:false}));
  app.get('/api/map-phase2b/private/shadow-coverage/postal/outline',async (req,res)=>{
    const {id}=req.query;
    if (Object.keys(req.query).length!==1||typeof id!=='string'||!/^\d{5}$/.test(id)) return res.status(400).end();
    try { return res.json({ok:true,data:await postal?.outline(Number(id))||null}); }
    catch { return res.status(503).json({error:'POSTAL_DATA_UNAVAILABLE'}); }
  });
  app.get('/vehicle-data.js',(_req,res)=>res.type('js').send('window.VEHICLE_AREA_DATA = {"vehicles":[]};'));
  app.get('/opsmap/dispatch-local-sdk.js',(_req,res)=>res.sendFile(path.resolve(dir,'../../test/fixtures/opsmap-dispatch-preview-map.js')));
  const read=requested=>projected.get(requested)??readHistory(requested);
  read.period=readHistory.period;
  mountOpsmapDispatchReference(app,{requireStaff:local,read,today:()=>date});
  app.get(['/', '/opsmap/'],async (_req,res)=>{
    const html=await readFile(path.join(dir,'map-phase2b-preview.html'),'utf8');
    const badge='<div style="position:fixed;bottom:3px;left:6px;z-index:1000;pointer-events:none;background:#fffffff5;padding:3px 7px;font-size:11px;border-radius:4px">로컬 개발 · WMS 실데이터 · Kakao SDK 테스트 모드</div>';
    return res.type('html').send(html.replace('</body>',badge+'<script src="/opsmap/dispatch-local-sdk.js"></script></body>'));
  });
  app.use('/opsmap',express.static(dir,{index:false,maxAge:0}));
  app.get(/^\/api\/map-phase2b\//,(_req,res)=>res.json({ok:true,data:[],meta:{}}));

  app.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({state:'READY',url:origin+'/',date,
    vehicles:result.amounts.vehicles.length,matched:result.route.rows.filter(row=>row.registryMatched).length,
    located:result.route.rows.filter(row=>row.coordinateVerified).length,postal:result.route.rows.filter(row=>row.postalCode).length,
    archivedDispatch:dispatchDates.slice(-12),verifiedWmsDates:[...exportsByDate.keys()].sort()})));
}

main().catch(error=>{
  console.error(/^[A-Z][A-Z_0-9]{1,95}$/.test(error?.message||'')?error.message:'WMS_PREVIEW_FAILED');
  process.exitCode=1;
});
