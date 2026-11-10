import { createHash } from 'node:crypto';

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
  if (level >= 12) return 4;
  if (level >= 10) return 5;
  if (level >= 8) return 6;
  if (level >= 6) return 7;
  return 8;
}

export function mountShadowCoverage({ app, requireStaff, directory, readDirectory, appRoot, store, readPreservedMap, readRunId,
  readProviderCoverage, staffResponseGuarded = false } = {}) {
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
    if (typeof box !== 'string' || box.length > 100 || typeof level !== 'string' || !/^(?:[1-9]|1[0-4])$/.test(level)) {
      return null;
    }
    const coords = box.split(',');
    const bounds = coords.length === 4 && coords.every(v => /^-?\d+(?:\.\d+)?$/.test(v)) ? coords.map(Number) : null;
    const tag = req.get('X-Coverage-View-Tag');
    return bounds && { bounds, level: Number(level), tag: /^"coverage-[a-f0-9]{64}"$/.test(tag) ? tag : null };
  }, async ({ days, center }, { bounds, level, tag }, { reader, model }) => {
    if (!model.boundsOf(bounds)) throw Error('COVERAGE_QUERY_INVALID');
    const data = await reader.readPeriod(days, undefined, { recheck: tag !== null });
    const { window, index, stale } = data;
    const preservedMap = (await Promise.resolve().then(readPreservedMap).catch(() => null)) ?? null;
    const sourceRunId=readRunId?.(index.sha256) ?? null;
    const version = createHash('sha256').update(JSON.stringify([1, index.sha256, stale, preservedMap, sourceRunId, days, center, bounds, level])).digest('hex');
    const etag = '"coverage-' + version + '"';
    if (etag === tag) return { etag, data: null };
    let resolution = resolutionFor(level);
    let view = reader.viewFor(data, center, resolution);
    let visible = model.viewportCells(view, bounds);
    while (visible.overflow && resolution > 4) {
      resolution--;
      view = reader.viewFor(data, center, resolution);
      visible = model.viewportCells(view, bounds);
    }
    const nationwide = resolution === model.BASE_RESOLUTION ? view : reader.viewFor(data, center, model.BASE_RESOLUTION);
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
      candidateViewport: model.viewportCandidates(nationwide, bounds, resolution),
      preservedMap,
      candidateList: model.coverageList(nationwide),
      resolution,
      truncated: visible.overflow,
      cells: visible.cells
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
    if (resolution < 4 || resolution > 8) throw Error('COVERAGE_QUERY_INVALID');
    const data = await reader.readPeriod(days, generation);
    const detail = model.cellDetail(reader.viewFor(data, center, resolution), id, offset);
    return { ...detail, boundary: h3.cellToBoundary(id) };
  });

  route('/search', req => {
    let query;
    try { query = decodeURIComponent(req.get('x-map-customer-query') || '').normalize('NFKC').trim(); }
    catch { return null; }
    const radius = req.query.radius ?? '0';
    return query.length >= 2 && query.length <= 200 && !/[\u0000-\u001f]/.test(query) &&
      ['0', '500', '1000'].includes(radius) ? { query, radius: Number(radius) } : null;
  }, async ({ days, center, generation }, { query, radius }, { reader, model }) => {
    const data = await reader.readPeriod(days, generation);
    const view = reader.viewFor(data, center, model.BASE_RESOLUTION);
    return { days, start: data.window.start, end: data.window.end, generation:data.index.sha256,
      results: model.searchCoverage(data.catalog, view, query, center, radius) };
  });

  route('/point', req => {
    const point = req.get('x-map-coverage-point') || '';
    if (point.length > 55 || !/^-?\d{1,3}(?:\.\d{1,16})?,-?\d{1,3}(?:\.\d{1,16})?$/.test(point)) return null;
    return point.split(',').map(Number);
  }, async ({ days, center, generation }, location, { reader, model }) => {
    if (!model.isPoint(...location)) throw Error('COVERAGE_QUERY_INVALID');
    const data = await reader.readPeriod(days, generation);
    const view = reader.viewFor(data, center, model.BASE_RESOLUTION);
    return { days, start: data.window.start, end: data.window.end, generation:data.index.sha256,
      results: [model.coverageAtPoint(data.catalog, view, location, center)] };
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
