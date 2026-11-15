import { performance } from 'node:perf_hooks';
import { POSTAL_BOOTSTRAP_METADATA_LIMIT, POSTAL_VIEWPORT_TILE_BYTES } from '../../public/opsmap/postal-geometry.mjs';

const postalRoot = '/api/map-phase2b/private/shadow-coverage/postal';
const centers = ['all', 'osan', 'yeongnam', 'honam'];
const hash = /^[a-f0-9]{64}$/;
const historyQueryKeys = new Set(['area', 'center', 'days', 'generation', 'offset']);

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
        const timing = {};
        const value = await perform(req,scope,modules,timing);
        if (res.destroyed || res.writableEnded) return;
        const parts = Object.entries({ postal:performance.now() - started, ...timing });
        res.set('Server-Timing',parts.map(([key, ms]) => key + ';dur=' + ms.toFixed(2)).join(', '));
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
          POSTAL_BOOTSTRAP_UNAVAILABLE: 404,
          POSTAL_DETAILS_UNCONFIGURED: 503,
          POSTAL_DETAILS_INTEGRITY: 503,
        };
        const code = Object.hasOwn(reasons, problem.message) ? problem.message : 'POSTAL_DATA_UNAVAILABLE';
        return res.status(reasons[code] || 503).json({ ok: false, error: code });
      }
    });
  }
  function view(req, scope, { runtime, postalBounds }, timing) {
    const { box, level, indexed } = req.query;
    if (typeof box !== 'string' || box.length > 100 || !/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(box) ||
        typeof level !== 'string' || !/^(?:[1-9]|1[01234])$/.test(level) ||
        indexed !== undefined && indexed !== '1') throw Error('POSTAL_QUERY_INVALID');
    const coords = box.split(',').map(Number);
    if (!postalBounds(coords)) throw Error('POSTAL_QUERY_INVALID');
    return runtime.view({ ...scope, box:coords, indexed:indexed === '1', timing });
  }
  function binary(res, { bytes, gzip }) {
    if (gzip) res.set('Content-Encoding','gzip');
    res.set('X-Content-Type-Options','nosniff').vary('Accept-Encoding').type('application/octet-stream').send(bytes);
  }
  route('/view',view);
  route('/bootstrap',async (req,scope,modules,timing) => {
    const data = await view(req,scope,modules,timing);
    const metadata = Buffer.from(JSON.stringify(data));
    const size = data.tiles.reduce((sum,tile) => sum + tile[1],0);
    if (!data.overview || !size || metadata.length > POSTAL_BOOTSTRAP_METADATA_LIMIT ||
        size > POSTAL_VIEWPORT_TILE_BYTES || data.tiles.length > 32) throw Error('POSTAL_BOOTSTRAP_UNAVAILABLE');
    const prefix = Buffer.allocUnsafe(8 + metadata.length);
    prefix.write('PVF1');
    prefix.writeUInt32LE(metadata.length,4);
    metadata.copy(prefix,8);
    const gzip = req.acceptsEncodings('gzip','identity') === 'gzip';
    const bytes = await modules.runtime.tiles(data.tiles.map(([id]) => id),data.overview,gzip,timing,prefix);
    return { bytes, gzip };
  },binary);
  route('/geometry', async (req, _scope, { runtime }, timing) => {
    const { ids, v } = req.query;
    if (typeof ids !== 'string' || ids.length > 950 || typeof v !== 'string' || !hash.test(v)) {
      throw Error('POSTAL_QUERY_INVALID');
    }
    const gzip = req.acceptsEncodings('gzip', 'identity') === 'gzip';
    return { bytes:await runtime.tiles(ids.split(','),v,gzip,timing), gzip };
  },binary);
  route('/area', (req, scope, { runtime }) => {
    if (typeof req.query.id !== 'string' || !/^\d{5}$/.test(req.query.id)) throw Error('POSTAL_QUERY_INVALID');
    return runtime.area({ ...scope, id: Number(req.query.id) });
  });
  function memberScope(req, scope) {
    const { area, offset = '0' } = req.query;
    if (!scope.generation || typeof area !== 'string' || !/^(?:unmatched|\d{5})$/.test(area) ||
        typeof offset !== 'string' || !/^\d{1,5}$/.test(offset) || Number(offset) > 15000) throw Error('POSTAL_QUERY_INVALID');
    return { ...scope, area:area === 'unmatched' ? null : Number(area), offset:Number(offset) };
  }
  route('/stores', async (req, scope, { runtime }) => {
    const { filter = 'all' } = req.query;
    const { POSTAL_STORE_FILTERS } = await import('./postalDetails.js');
    let q;
    try { q=decodeURIComponent(req.get('X-Map-Customer-Query')||'').normalize('NFKC').trim(); }
    catch { throw Error('POSTAL_QUERY_INVALID'); }
    if (!POSTAL_STORE_FILTERS.includes(filter) || q.length > 200 || /[\x00-\x1f]/.test(q)) throw Error('POSTAL_QUERY_INVALID');
    return runtime.stores({ ...memberScope(req,scope), filter, q });
  });
  route('/history', (req, scope, { runtime }) => {
    const code = req.get('X-Map-Customer-Code');
    if (Object.keys(req.query).some(key => !historyQueryKeys.has(key)) ||
        typeof code !== 'string' || !/^[A-Z]\d{1,20}$/.test(code)) throw Error('POSTAL_QUERY_INVALID');
    return runtime.history({ ...memberScope(req,scope), code });
  });
  route('/point', (req, scope, { runtime }, timing) => {
    const point = req.get('X-Map-Coverage-Point') || '';
    const radius = req.query.radius ?? '0';
    if (!/^[-]?\d{1,3}(?:\.\d{1,12})?,-?\d{1,3}(?:\.\d{1,12})?$/.test(point) || !['0','500','1000'].includes(radius)) {
      throw Error('POSTAL_QUERY_INVALID');
    }
    const [lat, lng] = point.split(',').map(Number);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw Error('POSTAL_QUERY_INVALID');
    return runtime.point({ ...scope, lat, lng, radius:Number(radius), timing });
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
