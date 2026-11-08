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

export function mountShadowCoverage({ app, requireStaff, directory, appRoot, store, staffResponseGuarded = false } = {}) {
  let dependencies;
  const load = () => {
    if (!store && !directory) throw Error('COVERAGE_DATA_UNAVAILABLE');
    dependencies ||= Promise.all([import('./model.js'), import('./store.js'), import('h3-js')])
      .then(([model, { createShadowCoverageStore }, h3]) =>
        ({ model, h3, reader: store || createShadowCoverageStore({ directory, appRoot }) }));
    return dependencies;
  };
  // Stage already authenticates the prefix and rechecks every JSON response.
  const entry = staffResponseGuarded ? [] : [requireStaff];
  const route = (suffix, parse, handle) => app.get(ROOT + suffix, ...entry, async (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie');
    const scope = criteria(req.query);
    const args = scope && parse(req);
    if (!args) return res.status(400).json({ ok: false, error: 'COVERAGE_QUERY_INVALID' });
    try {
      const result = await handle(scope, args, await load());
      if (res.destroyed || res.writableEnded) return;
      const send = () => res.set('Cache-Control', 'private, no-store').json({ ok: true, data: result });
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
    return bounds && { bounds, level: Number(level) };
  }, async ({ days, center }, { bounds, level }, { reader, model }) => {
    if (!model.boundsOf(bounds)) throw Error('COVERAGE_QUERY_INVALID');
    const data = await reader.readPeriod(days);
    let resolution = resolutionFor(level);
    let view = reader.viewFor(data, center, resolution);
    let visible = model.viewportCells(view, bounds);
    while (visible.overflow && resolution > 4) {
      resolution--;
      view = reader.viewFor(data, center, resolution);
      visible = model.viewportCells(view, bounds);
    }
    const { window, index, stale } = data;
    return {
      generation: index.sha256,
      kind: index.kind,
      stale,
      refreshedAt: index.generatedAt,
      sourceObservedAt: index.sourceObservedAt,
      period: { days, start: window.start, end: window.end, latest: window.latest },
      completeness: {
        ...view.proof, missingDates: window.missing, unverifiedDates: window.unverified[center],
        recordedCenters: window.recorded,
        recordedVisits: center === 'all' ? window.completed : window.recorded[center]
      },
      summary: view.summary,
      resolution,
      truncated: visible.overflow,
      cells: visible.cells
    };
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
  }, async ({ center, generation }, { query, radius }, { reader, model }) => {
    const data = await reader.readPeriod(90, generation);
    const view = reader.viewFor(data, center, 8);
    return { start: data.window.start, end: data.window.end, results: model.searchCoverage(data.catalog, view, query, center, radius) };
  });

}
