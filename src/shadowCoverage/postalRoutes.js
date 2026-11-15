import { performance } from 'node:perf_hooks';

const postalRoot = '/api/map-phase2b/private/shadow-coverage/postal';
const centers = ['all', 'osan', 'yeongnam', 'honam'];
const hash = /^[a-f0-9]{64}$/;

function criteria(query) {
  const { days = '90', center = 'all', generation } = query;
  if (!['30', '60', '90'].includes(days) || !centers.includes(center) ||
    generation !== undefined && (typeof generation !== 'string' || !hash.test(generation))) return null;
  return { days: Number(days), center, generation };
}

export function mountPostalCoverage({ app, requireStaff, readDirectory, appRoot, staffResponseGuarded, postal }) {
  let runtime;
  const load = async () => {
    const { createPostalRuntime, postalBounds } = await import('./postal.js');
    runtime ||= createPostalRuntime({ ...postal, appRoot, readDirectory });
    return { runtime, postalBounds };
  };
  const entry = staffResponseGuarded ? [] : [requireStaff];
  const json = (res, data) => res.json({ ok: true, data });
  function route(path, perform, send = json) {
    app.get(postalRoot + path, ...entry, async (req, res) => {
      res.set('Cache-Control', 'private, no-store').vary('Cookie');
      const scope = criteria(req.query);
      if (!scope) return res.status(400).json({ ok: false, error: 'POSTAL_QUERY_INVALID' });
      const started = performance.now();
      try {
        const modules = await load();
        const value = await perform(req, scope, modules);
        if (res.destroyed || res.writableEnded) return;
        res.set('Server-Timing', 'postal;dur=' + (performance.now() - started).toFixed(2));
        const respond = () => send(res, value);
        return staffResponseGuarded ? respond() : requireStaff(req, res, respond);
      } catch (problem) {
        if (res.destroyed || res.writableEnded) return;
        const reasons = {
          POSTAL_QUERY_INVALID: 400,
          COVERAGE_GENERATION_CHANGED: 409,
          POSTAL_READ_BUSY: 503,
          POSTAL_RELEASE_INTEGRITY: 503,
          POSTAL_GENERATION_MISMATCH: 503,
          POSTAL_DATA_UNCONFIGURED: 503,
        };
        const code = Object.hasOwn(reasons, problem.message) ? problem.message : 'POSTAL_DATA_UNAVAILABLE';
        return res.status(reasons[code] || 503).json({ ok: false, error: code });
      }
    });
  }
  route('/view', (req, scope, { runtime, postalBounds }) => {
    const { box, level } = req.query;
    if (typeof box !== 'string' || box.length > 100 || !/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(box) ||
        typeof level !== 'string' || !/^(?:[1-9]|1[01234])$/.test(level)) throw Error('POSTAL_QUERY_INVALID');
    const coords = box.split(',').map(Number);
    if (!postalBounds(coords)) throw Error('POSTAL_QUERY_INVALID');
    return runtime.view({ ...scope, box: coords, level: Number(level) });
  });
  route('/geometry', async (req, _scope, { runtime }) => {
    const { ids, v } = req.query;
    if (typeof ids !== 'string' || ids.length > 950 || typeof v !== 'string' || !hash.test(v)) {
      throw Error('POSTAL_QUERY_INVALID');
    }
    const gzip = req.acceptsEncodings('gzip', 'identity') === 'gzip';
    return { bytes: await runtime.tiles(ids.split(','), v, gzip), gzip };
  }, (res, { bytes, gzip }) => {
    if (gzip) res.set('Content-Encoding', 'gzip');
    res.set('X-Content-Type-Options', 'nosniff').vary('Accept-Encoding').type('application/octet-stream').send(bytes);
  });
  route('/area', (req, scope, { runtime }) => {
    if (typeof req.query.id !== 'string' || !/^\d{5}$/.test(req.query.id)) throw Error('POSTAL_QUERY_INVALID');
    return runtime.area({ ...scope, id: Number(req.query.id) });
  });
  route('/point', (req, scope, { runtime }) => {
    const point = req.get('X-Map-Coverage-Point') || '';
    const radius = req.query.radius ?? '0';
    if (!/^[-]?\d{1,3}(?:\.\d{1,12})?,-?\d{1,3}(?:\.\d{1,12})?$/.test(point) || !['0','500','1000'].includes(radius)) {
      throw Error('POSTAL_QUERY_INVALID');
    }
    const [lat, lng] = point.split(',').map(Number);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw Error('POSTAL_QUERY_INVALID');
    return runtime.point({ ...scope, lat, lng, radius: Number(radius) });
  });
  route('/search', (req, scope, { runtime }) => {
    let query;
    try { query = decodeURIComponent(req.get('X-Map-Customer-Query') || '').normalize('NFKC').trim(); }
    catch { throw Error('POSTAL_QUERY_INVALID'); }
    if (query.length < 2 || query.length > 200 || /[\x00-\x1f]/.test(query)) throw Error('POSTAL_QUERY_INVALID');
    return runtime.search({ ...scope, query });
  });
  return {
    async prepareDefaultPointData() {
      const started = performance.now();
      const { runtime } = await load();
      await runtime.warm();
      return { restoreMs: 0, dataMs: Math.round(performance.now() - started) };
    },
  };
}
