import { createHash } from 'node:crypto';
import { cellStatusCounts } from './storeStatus.js';

const ROOT = '/api/map-phase2b/private/shadow-coverage';
const CENTERS = ['all', 'osan', 'yeongnam', 'honam'];

function criteria(query) {
  const days = query.days ?? '90';
  const center = query.center ?? 'all';
  const generation = query.generation;
  if (typeof days !== 'string' || !/^(30|60|90)$/.test(days) || !CENTERS.includes(center) ||
      generation !== undefined && (typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation))) {
    return null;
  }
  return { days: Number(days), center, generation };
}

function resolutionFor(level) {
  if (level <= 2) return 10;
  if (level <= 4) return 9;
  if (level >= 12) return 4;
  if (level >= 10) return 5;
  if (level >= 8) return 6;
  if (level >= 6) return 7;
  return 8;
}

export function mountShadowCoverage({ app, requireStaff, directory, readDirectory, appRoot, store, readPreservedMap, readRunId,
  readProviderCoverage, readStatus, staffResponseGuarded = false } = {}) {
  let imports, current, providerModule;
  const load = async () => {
    const folder = readDirectory ? await readDirectory() : directory;
    if (!store && !folder) throw Error('COVERAGE_DATA_UNAVAILABLE');
    const [model, {createShadowCoverageStore}, h3] = await (imports ??= Promise.all([
      import('./model.js'), import('./store.js'), import('h3-js')
    ]));
    if (store) return {model, h3, reader:store};
    if (current?.folder !== folder) current = {folder, reader:createShadowCoverageStore({directory:folder, appRoot})};
    return {model, h3, reader:current.reader};
  };
  // The operating map authenticates the prefix and rechecks every JSON response.
  const entry = staffResponseGuarded ? [] : [requireStaff];
  const sendData = (res, data) => res.json({ ok: true, data });
  const route = (suffix, parse, handle, reply = sendData, loadReady=load) => app.get(ROOT + suffix, ...entry, async (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie');
    const scope = criteria(req.query);
    const args = scope && parse(req);
    if (!args) return res.status(400).json({ ok: false, error: 'COVERAGE_QUERY_INVALID' });
    try {
      const ready = await loadReady();
      if (res.destroyed || res.writableEnded) return;
      const result = await handle(scope, args, ready);
      if (res.destroyed || res.writableEnded) return;
      const send = () => reply(res.set('Cache-Control', 'private, no-store'), result);
      return staffResponseGuarded ? send() : requireStaff(req, res, send);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const changed = error.message === 'COVERAGE_GENERATION_CHANGED';
      const invalid = error.message === 'COVERAGE_QUERY_INVALID';
      return res.status(changed ? 409 : invalid ? 400 : 503).json({
        ok: false,
        error: changed || invalid ? error.message : 'COVERAGE_DATA_UNAVAILABLE'
      });
    }
  });

  route('/view', req => {
    const box = req.query.box;
    const level = req.query.level ?? '11';
    const resolution = req.query.resolution ?? 'auto';
    if (typeof box !== 'string' || box.length > 100 || typeof level !== 'string' || !/^(?:[1-9]|1[0-4])$/.test(level)) {
      return null;
    }
    if (!['auto','8','9','10'].includes(resolution)) return null;
    const coords = box.split(',');
    const bounds = coords.length === 4 && coords.every(v => /^-?\d+(?:\.\d+)?$/.test(v)) ? coords.map(Number) : null;
    const tag = req.get('X-Coverage-View-Tag');
    return bounds && { bounds, level: Number(level), resolution, tag: /^"coverage-[a-f0-9]{64}"$/.test(tag) ? tag : null };
  }, async ({ days, center }, { bounds, level, resolution: choice, tag }, { reader, model }) => {
    if (!model.boundsOf(bounds)) throw Error('COVERAGE_QUERY_INVALID');
    const data = await reader.readPeriod(days, undefined, { recheck: tag !== null });
    const { window, index, stale, catalog } = data;
    const [preservedMap, statuses] = await Promise.all([
      Promise.resolve().then(readPreservedMap).catch(() => null),
      readStatus?.(catalog, index.sha256, days).catch(() => null)
    ]);
    const sourceRunId=readRunId?.(index.sha256) ?? null;
    const version = createHash('sha256').update(JSON.stringify([3, index.sha256, stale, preservedMap, sourceRunId, days, center, bounds, level,
      choice, statuses?.version, statuses?.evidenceAsOf, statuses?.date, statuses?.counts])).digest('hex');
    const etag = '"coverage-' + version + '"';
    if (etag === tag) return { etag, data: null };
    const base = reader.viewFor(data, center, model.BASE_RESOLUTION);
    const span = Math.max(bounds[2]-bounds[0], bounds[3]-bounds[1]);
    let resolution = Math.min(choice === 'auto' ? resolutionFor(level) : Number(choice), span > .75 ? 8 : span > .22 ? 9 : 10);
    let view, visible;
    const select = () => {
      view = resolution >= model.BASE_RESOLUTION ? base : reader.viewFor(data, center, resolution);
      visible = resolution > model.BASE_RESOLUTION ? model.detailedViewport(base, catalog, bounds, resolution) : model.viewportCells(view, bounds);
    };
    select();
    while (visible.overflow && resolution > 4) {
      resolution--;
      select();
    }
    const nationwide = base;
    const statusPins = [], pinned = new Set();
    const cells = statuses ? visible.cells.map(cell => {
      const codes = model.coverageMembers(view, catalog, cell.id);
      if (resolution >= 9) for (const code of codes) {
        const status = statuses.records.get(code), store = catalog.byCode.get(code);
        if (statusPins.length >= 120 || pinned.has(code) || !(status?.newActive || status?.current || status?.pastNew || status?.pastHeld || status?.heldOrderConflict) || !store?.cell ||
            store.lng < bounds[0] || store.lat < bounds[1] || store.lng > bounds[2] || store.lat > bounds[3]) continue;
        pinned.add(code);
        statusPins.push({ id:cell.id, state:status.current, newActive:status.newActive, heldOrderConflict:status.heldOrderConflict,
          pastNew:status.pastNew, pastHeld:status.pastHeld,
          location:[store.lat, store.lng] });
      }
      return { ...cell, storeStatus:cellStatusCounts(codes, statuses) };
    }) : visible.cells;
    const result = {
      generation: index.sha256,
      sourceRunId,
      kind: index.kind,
      stale,
      refreshedAt: index.generatedAt,
      sourceObservedAt: index.sourceObservedAt,
      period: { days, start: window.start, end: window.end, latest: nationwide.evidence.latestRecorded },
      completeness: {
        ...view.proof, ...nationwide.evidence,
        recordedCenters: window.recorded,
        recordedVisits: center === 'all' ? window.completed : window.recorded[center]
      },
      summary: nationwide.summary,
      summaryResolution: model.BASE_RESOLUTION,
      viewportSummary: visible.summary,
      candidateViewport: model.viewportCandidates(nationwide, bounds, Math.min(resolution, model.BASE_RESOLUTION)),
      preservedMap: preservedMap ?? null,
      candidateList: model.coverageList(nationwide),
      resolution,
      truncated: visible.overflow,
      cells,
      statusPins,
      storeStatus: statuses ? { ...statuses.counts,
        NEW:statuses.counts.NEW || (statuses.counts.ordersUnknown ? null : 0),
        HELD:statuses.counts.HELD || (statuses.counts.currentUnknown ? null : 0),
        pastNew:statuses.evidenceAsOf ? statuses.counts.pastNew : null,
        pastHeld:statuses.evidenceAsOf ? statuses.counts.pastHeld : null,
        fixedCheckedAt:statuses.fixedCheckedAt, evidenceAsOf:statuses.evidenceAsOf, historyStart:statuses.historyStart,
        rollingStart:statuses.rollingStart } : null
    };
    return { etag, data: result };
  }, (res, { etag, data }) => {
    res.set('ETag', etag);
    return data ? sendData(res, data) : res.json({ ok: true, unchanged: true });
  });

  route('/list', req => {
    const { filter = 'candidate', offset = '0' } = req.query;
    return ['candidate', 'delivery', 'review'].includes(filter) &&
      typeof offset === 'string' && /^\d{1,5}$/.test(offset) && Number(offset) <= 48_000
      ? { filter, offset: Number(offset) } : null;
  }, async ({ days, center, generation }, { filter, offset }, { reader, model }) => {
    const data = await reader.readPeriod(days, generation);
    return model.coverageList(reader.viewFor(data, center, model.BASE_RESOLUTION), filter, offset);
  });

  route('/cell', req => {
    const { id, offset = '0' } = req.query;
    if (typeof id !== 'string' || !/^[a-f0-9]{15}$/.test(id) ||
        typeof offset !== 'string' || !/^\d{1,5}$/.test(offset) || Number(offset) > 15_000) return null;
    return { id, offset: Number(offset) };
  }, async ({ days, center, generation }, { id, offset }, { reader, model, h3 }) => {
    if (!h3.isValidCell(id)) throw Error('COVERAGE_QUERY_INVALID');
    const resolution = h3.getResolution(id);
    if (resolution < 4 || resolution > 10) throw Error('COVERAGE_QUERY_INVALID');
    const data = await reader.readPeriod(days, generation);
    const view = reader.viewFor(data, center, Math.min(resolution, model.BASE_RESOLUTION));
    const detail = resolution > model.BASE_RESOLUTION ? model.detailedCell(view, data.catalog, id, offset) : model.cellDetail(view, id, offset);
    const statuses = await readStatus?.(data.catalog, data.index.sha256, days).catch(() => null);
    return { ...detail, resolution, boundary: h3.cellToBoundary(id),
      storeStatus:cellStatusCounts(model.coverageMembers(view, data.catalog, id), statuses),
      stores:detail.stores.map(row => {
        const store = data.catalog.byCode.get(row.code);
        return { ...row, ...(statuses?.records.get(row.code) || {}), location:store?.cell ? [store.lat, store.lng] : null };
      }) };
  });

  route('/search', req => {
    let query;
    try { query = decodeURIComponent(req.get('x-map-customer-query') || '').normalize('NFKC').trim(); }
    catch { return null; }
    const radius = req.query.radius ?? '0', resolution = req.query.resolution ?? '8';
    return query.length >= 2 && query.length <= 200 && !/[\u0000-\u001f]/.test(query) &&
      ['0', '500', '1000'].includes(radius) && ['8','9','10'].includes(resolution) ? { query, radius: Number(radius), resolution:Number(resolution) } : null;
  }, async ({ days, center, generation }, { query, radius, resolution }, { reader, model, h3 }) => {
    const data = await reader.readPeriod(days, generation);
    const view = reader.viewFor(data, center, model.BASE_RESOLUTION);
    return { days, start: data.window.start, end: data.window.end, generation:data.index.sha256,
      results: model.searchCoverage(data.catalog, view, query, center, radius).map(row => row.location && resolution > 8
        ? {...row, detailId:h3.latLngToCell(...row.location, resolution), detailResolution:resolution} : row) };
  });

  route('/point', req => {
    const point = req.get('x-map-coverage-point') || '';
    if (point.length > 55 || !/^-?\d{1,3}(?:\.\d{1,16})?,-?\d{1,3}(?:\.\d{1,16})?$/.test(point)) return null;
    const resolution = req.query.resolution ?? '8';
    return ['8','9','10'].includes(resolution) ? { location:point.split(',').map(Number), resolution:Number(resolution) } : null;
  }, async ({ days, center, generation }, {location,resolution}, { reader, model, h3 }) => {
    if (!model.isPoint(...location)) throw Error('COVERAGE_QUERY_INVALID');
    const data = await reader.readPeriod(days, generation);
    const view = reader.viewFor(data, center, model.BASE_RESOLUTION);
    return { days, start: data.window.start, end: data.window.end, generation:data.index.sha256,
      results: [{...model.coverageAtPoint(data.catalog, view, location, center),
        ...(resolution > 8 ? {detailId:h3.latLngToCell(...location,resolution), detailResolution:resolution} : {})}] };
  });

  route('/provider-overlap',req=>{
    const {cells='',at,box}=req.query;
    if(typeof cells!=='string'||cells.length>1023||at!==undefined&&(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(at)))return null;
    const ids=cells?cells.split(','):[];
    if(box!==undefined&&(cells||typeof box!=='string'||box.length>100||!box.split(',').every(part=>/^-?\d{1,3}(?:\.\d{1,10})?$/.test(part))))return null;
    const bounds=box?.split(',').map(Number);
    if(bounds&&(bounds.length!==4||bounds[0]<-180||bounds[1]<-90||bounds[2]>180||bounds[3]>90||bounds[0]>=bounds[2]||bounds[1]>=bounds[3]))return null;
    return ids.length<=64&&ids.every(id=>/^[a-f0-9]{15}$/.test(id))?{ids:[...new Set(ids)],at,bounds}:null;
  },async({days,center,generation},{ids,at,bounds})=>{
    const [providers,inputs,ready]=await Promise.all([
      providerModule??=import('./providerCoverage.js'),
      Promise.resolve().then(readProviderCoverage).catch(()=>({})),
      load().catch(()=>null)
    ]);
    const date=at||new Date(Date.now()+9*3600000).toISOString().slice(0,10);
    if(new Date(date+'T00:00:00Z').toJSON()?.slice(0,10)!==date||ids.some(id=>!providers.isProviderCell(id))) {
      throw Error('COVERAGE_QUERY_INVALID');
    }
    const viewport=bounds&&providers.providerCellsInBox(inputs,bounds,date);
    if(viewport)ids=viewport.ids;
    let freshon=null;
    const data=await ready?.reader.readPeriod(days,generation).catch(error=>{
      if(error.message==='COVERAGE_GENERATION_CHANGED')throw error;
      return null;
    });
    if(generation&&!data)throw Error('COVERAGE_GENERATION_CHANGED');
    if(data?.index.kind==='OBSERVED'&&data.window.end<=date) {
      const view=ready.reader.viewFor(data,center,providers.PROVIDER_H3_RESOLUTION);
      const {missingDates,unverifiedDates}=view.evidence;
      const complete=!data.stale&&missingDates.length===0&&unverifiedDates.length===0;
      const byCell=new Map(ids.map(id=>{
        const cell=view.groups.get(id);
        const visits=cell?.visits||0;
        return [id,{status:visits?'DELIVERY_OBSERVED':complete&&cell&&cell.status!=='UNKNOWN'?'NO_DELIVERY_HISTORY':'UNVERIFIED',
          observedVisits:visits,candidate:cell?.status==='CANDIDATE',lastDelivery:cell?.lastDelivery||null}];
      }));
      freshon={generation:data.index.sha256,start:data.window.start,end:data.window.end,missingDates,unverifiedDates,
        stale:data.stale,byCell};
    }
    const sources={...inputs,FRESHON:{...inputs?.FRESHON,state:'UNVERIFIED'}};
    const result=providers.providerCoverageView({inputs:sources,freshon,cells:ids,at:date});
    if(!viewport||!ids.length)return result;
    const {cellToBoundary}=await import('h3-js');
    return {...result,truncated:viewport.truncated,cells:result.cells.map(cell=>({...cell,boundary:cellToBoundary(cell.id)}))};
  },sendData,async()=>null);

}
