import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createGzip } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { readSource } from './source.mjs';

const modules = {
  h3: { module: './h3.mjs', label: 'H3 벌집', title: 'H3 배송분포', description: '전국 R8부터 매장 주변 R11까지 화면에 맞춰 표시합니다.' },
  admin: { module: './admin.mjs', label: '읍면동', title: '읍면동별 배송분포', description: '공식 행정 읍면동 경계 안의 관측 배송을 집계합니다.' },
  postal: { module: './postal.mjs', label: '5자리 우편번호', title: '우편번호별 배송분포', description: '공식 국가기초구역 경계 안의 관측 배송을 집계합니다.' },
};
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
  ['/basemap.json', ['basemap.json', 'application/json']],
]);
const koreaBounds = [124, 32.99, 132.08, 39.55];
const overlaps = ([a,b,c,d], [w,s,e,n]) => a<=e && c>=w && b<=n && d>=s;

export function statusFor(feature) {
  if (feature.visits > 0) return 'delivered';
  return feature.stores > 0 && feature.eligibleStores === feature.stores ? 'candidate' : 'unknown';
}
export function densityLevel(feature) {
  const density = feature.visits / feature.areaKm2;
  return density < 15 ? 0 : density < 100 ? 1 : density < 500 ? 2 : 3;
}
function summarize(features) {
  const summary = { count: features.length, delivered: 0, candidate: 0, unknown: 0, stores: 0, visits: 0,
    newActive: 0, newUnknown: 0, held: 0 };
  for (const feature of features) {
    summary[statusFor(feature)]++;
    for (const key of ['stores', 'visits', 'newActive', 'newUnknown', 'held']) summary[key] += feature[key];
  }
  return summary;
}
function validateQuery(query) {
  const values = query.get('bbox')?.split(',').map(Number);
  const zoom = Number(query.get('z'));
  const width = Number(query.get('w')), height = Number(query.get('h'));
  if (!values || values.length !== 4 || values.some(x => !Number.isFinite(x)) || values[0] >= values[2] || values[1] >= values[3] ||
      values[0] < 100 || values[2] > 155 || values[1] < 20 || values[3] > 50 ||
      !Number.isFinite(zoom) || zoom < 5 || zoom > 17 || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 240 || width > 2200 || height < 240 || height > 1500) return null;
  return { bbox: values, zoom, width, height };
}

export async function startServer(mode, { port = 0, sourceOptions, postalBoundaryDir } = {}) {
  const spec = modules[mode];
  if (!spec) throw Error('PROTOTYPE_MODE_REQUIRED');
  const boot = performance.now();
  const data = await readSource(sourceOptions);
  const { createLayer } = await import(spec.module);
  const layer = await createLayer(data.records, { postalBoundaryDir });
  const startupMs = Math.round(performance.now() - boot);
  const totals = { visitScope: data.meta.bound, mappedStores: layer.diagnostics.mappedStores,
    mappedVisits: layer.diagnostics.mappedVisits };
  if (!['BOUNDARIES_UNAVAILABLE', 'BOUNDARIES_INVALID'].includes(layer.diagnostics.state) &&
      (totals.mappedStores + (layer.diagnostics.unmappedStores ?? 0) !== data.meta.stores ||
        totals.mappedVisits + (layer.diagnostics.unmappedVisits ?? 0) !== data.meta.bound)) throw Error('PROTOTYPE_LAYER_CONSERVATION');
  const index = new Map(data.records.map(record => [record.code, record]));
  let cached, queue = Promise.resolve(), activeClients = 0;
  const limitMiB = 512;
  function getMeasurement() {
    const { rss, heapUsed } = process.memoryUsage();
    return { processId: process.pid, platform: process.platform, rssMiB: +(rss / 1048576).toFixed(2),
      heapMiB: +(heapUsed / 1048576).toFixed(2), peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2), limitMiB };
  }
  function getPoints(bbox, zoom) {
    if (zoom < 12.5) return [];
    const [w,s,e,n] = bbox;
    return [...index.values()].filter(row => row.lng >=w && row.lng <=e && row.lat >=s && row.lat <=n)
      .map(({ lng, lat, newActive, newUnknown, held }) => [lng, lat, held ? 2 : newActive ? 1 : newUnknown ? 3 : 0]);
  }
  async function getView(view) {
    const key = JSON.stringify(view);
    if (cached?.key === key) return { ...cached, cached: true, buildMs: 0 };
    const start = performance.now();
    const { resolution, features } = overlaps(koreaBounds, view.bbox)
      ? await layer.view(view) : { resolution: layer.unit, features: [] };
    const body = { resolution, summary: summarize(features),
      features: features.map(feature => ({ ...feature, tone: statusFor(feature), intensity: densityLevel(feature) })),
      points: getPoints(view.bbox, view.zoom) };
    const json = JSON.stringify(body);
    const measurement = getMeasurement();
    if (measurement.rssMiB >= limitMiB) throw Error('PROTOTYPE_RSS_LIMIT');
    cached = { key, json, featureCount: features.length, buildMs: Math.round(performance.now() - start), cached: false };
    return cached;
  }
  const info = { ...spec, mode, unit: layer.unit, boundary: layer.source, diagnostics: layer.diagnostics,
    evidence: data.meta, startupMs, memoryLimitMiB: limitMiB };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        const buf = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, { 'Content-Type': type }).end(buf);
        return;
      }
      if (url.pathname === '/api/meta' || url.pathname === '/api/metrics') {
        const value = url.pathname === '/api/meta' ? info : getMeasurement();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
        return;
      }
      if (url.pathname !== '/api/view') { res.writeHead(404).end(); return; }
      const view = validateQuery(url.searchParams);
      if (!view) { res.writeHead(400).end(); return; }
      if (activeClients >= 3) { res.writeHead(429).end(); return; }
      activeClients++;
      const work = queue.then(() => res.destroyed ? null : getView(view));
      queue = work.catch(() => {});
      let result;
      try { result = await work; } finally { activeClients--; }
      if (!result || res.destroyed) return;
      res.setHeader('Server-Timing', 'layer;dur=' + result.buildMs);
      res.setHeader('X-View-Cache', result.cached ? 'hit' : 'miss');
      res.setHeader('Content-Type', 'application/json');
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        res.setHeader('Content-Encoding', 'gzip');
        const zip = createGzip({ level: 4 });
        zip.on('error', () => res.destroy());
        zip.pipe(res);
        zip.end(result.json);
      } else res.end(result.json);
    } catch (error) {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        error: /^(?:PROTOTYPE|ADMIN_PROTOTYPE|POSTAL_BOUNDARY)_[A-Z_]+$/.test(error.message) ? error.message : 'LAYER_UNAVAILABLE'
      }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port, startupMs, info };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  try {
    const { url, startupMs } = await startServer(process.argv[2], { port: Number(process.env.OPSMAP_PROTOTYPE_PORT || 4317),
      sourceOptions: { snapshotRoot: process.env.OPSMAP_PROTOTYPE_SNAPSHOT, statusFile: process.env.OPSMAP_PROTOTYPE_STATUS },
      postalBoundaryDir: process.env.OPSMAP_POSTAL_BOUNDARIES });
    console.log(JSON.stringify({ url, startupMs, pid: process.pid }));
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'PROTOTYPE_START_FAILED');
    process.exitCode = 1;
  }
}
