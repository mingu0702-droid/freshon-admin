const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('ko-KR');
const fixedViews = {
  nation: { center: [127.86, 35.88], zoom: 7.2 },
  region: { center: [126.985, 37.197], zoom: 10.65 },
  detail: { center: [127.057, 37.150], zoom: 14.25 },
};
const labels = [
  ['서울', 126.978, 37.566], ['인천', 126.706, 37.456], ['대전', 127.390, 36.350],
  ['광주', 126.852, 35.159], ['대구', 128.601, 35.871], ['부산', 129.076, 35.179],
  ['강릉', 128.877, 37.751], ['목포', 126.392, 34.812], ['제주', 126.535, 33.50],
  ['전주', 127.148, 35.825], ['포항', 129.343, 36.032], ['춘천', 127.730, 37.881],
];
const localLabels = [
  ['수원', 127.028, 37.274], ['화성', 126.831, 37.202], ['오산', 127.077, 37.149],
  ['동탄', 127.071, 37.206], ['평택', 127.114, 36.997], ['안산', 126.831, 37.322],
  ['봉담', 126.949, 37.218], ['향남', 126.92, 37.135], ['세교', 127.043, 37.161],
  ['금암동', 127.046, 37.168], ['세마역', 127.0435, 37.1764],
  ['물향기수목원', 127.0569, 37.1677], ['오산대역', 127.0641, 37.1691],
  ['오산역', 127.066, 37.1458], ['오산시청', 127.0772, 37.1499],
  ['가수동', 127.0476, 37.1396], ['궐동', 127.0589, 37.1575],
  ['원동', 127.0757, 37.1367], ['탑동', 127.035, 37.150],
];
const colors = {
  water: '#dbe8f1', land: '#eff0e7', grid: '#aec2d2',
  fills: ['#a5cbea', '#7fb0de', '#518dd0', '#2a5ea9'],
  strokes: ['#5489bc', '#487fbb', '#376bad', '#224b93'],
  points: ['#4b7294', '#098276', '#8247a7', '#098276'],
};
const states = { delivered: '배송기록 있음', candidate: '관측기간 미배송 후보', unknown: '자료 부족' };
const unavailable = value => ['BOUNDARIES_UNAVAILABLE', 'BOUNDARIES_INVALID'].includes(value);
const map = $('map');
const canvas = $('display');
const screen = canvas.getContext('2d', { alpha: false });
const layers = document.createElement('canvas');
const base = layers.getContext('2d', { alpha: false });
const featurePaths = [];
const metrics = { ready: false, cycles: [], renderCount: 0, benchmark: null };
const toX = lon => (lon + 180) / 360;
const toY = lat => {
  const angle = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(angle) + 1 / Math.cos(angle)) / Math.PI) / 2;
};
const toLng = x => x * 360 - 180;
const toLat = y => 180 * Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / Math.PI;
const factorAt = zoom => 256 * 2 ** zoom;
const geometry = { result: null, camera: null, size: null, startedAt: null };
let view = 'nation';
let camera = { center: fixedViews.nation.center, zoom: fixedViews.nation.zoom };
let width = 0, height = 0, dpr = 1;
let meta, basemap, viewData, selected, latestRequest, revision = 0, canvasRaf, fetchTimer, drag, noticeTimer;
let phase = 'loading', previousScale = '';
let currentInteraction = null;

function project([lng, lat], current = camera) {
  const scale = factorAt(current.zoom);
  return [(toX(lng) - toX(current.center[0])) * scale + width / 2,
    (toY(lat) - toY(current.center[1])) * scale + height / 2];
}
function unproject(x, y, current = camera) {
  const scale = factorAt(current.zoom);
  return [toLng(toX(current.center[0]) + (x - width / 2) / scale),
    toLat(toY(current.center[1]) + (y - height / 2) / scale)];
}
function bounds() {
  const [w, s] = unproject(0, height);
  const [e, n] = unproject(width, 0);
  const margin = 0.055;
  return [w - (e - w) * margin, s - (n - s) * margin, e + (e - w) * margin, n + (n - s) * margin];
}
function fitCamera() {
  const spec = fixedViews[view];
  const small = width < 520;
  if (view === 'nation') {
    const v = small
      ? Math.log2(Math.min(width * 0.88 / (toX(132) - toX(124.58)), height * 0.84 / (toY(33.02) - toY(38.68))) / 256)
      : Math.log2(Math.min(width * 0.75 / (toX(132) - toX(124.58)), height * 0.89 / (toY(32.82) - toY(38.85))) / 256);
    camera = { center: spec.center, zoom: Math.max(5.5, Math.min(8.6, v)) };
  } else {
    camera = { center: spec.center, zoom: spec.zoom };
  }
}

function polygonPath(rings, current) {
  const p = new Path2D();
  for (const polygon of rings) {
    for (const points of polygon) {
      if (points.length < 3) continue;
      let [x, y] = project(points[0], current);
      p.moveTo(x, y);
      for (const point of points.slice(1)) {
        [x, y] = project(point, current);
        p.lineTo(x, y);
      }
      p.closePath();
    }
  }
  return p;
}

function paintBase(ctx, current) {
  ctx.fillStyle = colors.water;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = colors.land;
  ctx.strokeStyle = '#bfcacf';
  ctx.lineWidth = 0.7;
  for (const country of basemap.features) {
    const p = polygonPath(country.rings, current);
    ctx.fill(p, 'evenodd');
    ctx.stroke(p);
  }
  const [w,s,e,n] = bounds();
  const step = current.zoom < 8 ? 1 : current.zoom < 12.5 ? 0.10 : 0.01;
  ctx.lineWidth = 0.55;
  ctx.strokeStyle = current.zoom < 8 ? '#a7bdcf80' : '#a7b7c141';
  ctx.beginPath();
  for (let x = Math.ceil(w / step) * step; x < e; x += step) {
    const [px] = project([x, (s + n) / 2], current);
    ctx.moveTo(px, 0); ctx.lineTo(px, height);
  }
  for (let y = Math.ceil(s / step) * step; y < n; y += step) {
    const [,py] = project([(w + e) / 2, y], current);
    ctx.moveTo(0, py); ctx.lineTo(width, py);
  }
  ctx.stroke();
}
function paintLabels(ctx, current) {
  const work = [];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = current.zoom < 8 ? '600 11px "Malgun Gothic", sans-serif' : '650 11px "Malgun Gothic", sans-serif';
  const types = current.zoom < 9.1 ? labels : localLabels;
  for (const [name, x, y] of types) {
    const [sx, sy] = project([x, y], current);
    if (sx < 24 || sx > width - 24 || sy < 52 || sy > height - 40) continue;
    const w = ctx.measureText(name).width + 12;
    if (work.some(([a,b,c]) => Math.abs(sx - a) < (w+c)/2 && Math.abs(sy - b) < 14)) continue;
    work.push([sx, sy, w]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#f7fafb';
    ctx.strokeText(name, sx, sy);
    ctx.fillStyle = '#36526c';
    ctx.fillText(name, sx, sy);
  }
}
function paintFeature(ctx, feature, current) {
  const [x, y] = project(feature.center, current);
  const samples = feature.rings[0]?.[0];
  if (!samples?.length) return;
  const tiny = meta.mode === 'h3' && Math.abs(project(samples[0], current)[1] - y) < 1.55 &&
    Math.abs(project(samples[0], current)[0] - x) < 1.55 && current.zoom < 9;
  if (tiny) {
    const baseRadius = feature.tone === 'unknown' ? 1.12 : 1.58;
    const actual = feature.tone === 'delivered' ? baseRadius + feature.intensity * 0.22 : baseRadius;
    const dot = new Path2D();
    dot.arc(x, y, actual, 0, Math.PI * 2);
    ctx.fillStyle = feature.tone === 'delivered' ? colors.strokes[feature.intensity] :
      feature.tone === 'candidate' ? '#c87c26' : '#667e94';
    ctx.fill(dot);
    featurePaths.push({ feature, path: dot });
    return;
  }
  const path = polygonPath(feature.rings, current);
  if (feature.tone === 'delivered') {
    ctx.fillStyle = colors.fills[feature.intensity];
    ctx.strokeStyle = colors.strokes[feature.intensity];
    ctx.lineWidth = current.zoom < 9 ? 0.45 : 0.8;
    ctx.fill(path, 'evenodd'); ctx.stroke(path);
  } else if (feature.tone === 'candidate') {
    ctx.fillStyle = '#f6c180';
    ctx.strokeStyle = '#bd7840';
    ctx.lineWidth = current.zoom < 9 ? 0.48 : 0.8;
    ctx.fill(path, 'evenodd'); ctx.stroke(path);
  } else {
    ctx.fillStyle = '#e0e8f0a8';
    ctx.strokeStyle = '#8098ac';
    ctx.lineWidth = current.zoom < 9 ? 0.4 : 0.7;
    if (current.zoom >= 9) ctx.setLineDash([2, 2]);
    ctx.fill(path, 'evenodd'); ctx.stroke(path);
    ctx.setLineDash([]);
  }
  featurePaths.push({ feature, path });
}
function updateScale() {
  const kmPerPixel = 40075 * Math.cos(camera.center[1] * Math.PI / 180) / factorAt(camera.zoom);
  const length = [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1].find(km => km / kmPerPixel <= 95) ?? 0.1;
  const pixels = Math.round(length / kmPerPixel);
  if (previousScale === length + ':' + pixels) return;
  previousScale = length + ':' + pixels;
  const ruler = $('scale');
  const line = document.createElement('span');
  line.style.width = pixels + 'px';
  ruler.replaceChildren(length < 1 ? format.format(length * 1000) + ' m' : length + ' km', line);
}

function redrawGeometry() {
  const started = performance.now();
  const size = [width, height, dpr];
  for (const [surface, ctx] of [[canvas, screen], [layers, base]]) {
    if (surface.width !== Math.round(width * dpr) || surface.height !== Math.round(height * dpr)) {
      surface.width = Math.round(width * dpr);
      surface.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const pose = { center: [...camera.center], zoom: camera.zoom };
  paintBase(base, pose);
  featurePaths.length = 0;
  for (const feature of viewData?.features || []) paintFeature(base, feature, pose);
  paintLabels(base, pose);
  for (const [x, y, kind] of viewData?.points || []) {
    const [sx, sy] = project([x, y], pose);
    if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
    base.beginPath();
    base.arc(sx, sy, kind ? 3.1 : 2.3, 0, Math.PI * 2);
    base.fillStyle = kind === 3 ? '#fbfdff' : colors.points[kind]; base.fill();
    base.lineWidth = kind === 3 ? 1.1 : 0.8;
    base.strokeStyle = kind === 3 ? colors.points[kind] : '#fbfdff'; base.stroke();
  }
  Object.assign(geometry, { camera: pose, size, result: viewData, startedAt: started });
  paintFrame();
  metrics.renderCount++;
  return performance.now() - started;
}
function paintFrame() {
  if (!geometry.camera) return;
  if (drag || geometry.camera.center[0] !== camera.center[0] || geometry.camera.center[1] !== camera.center[1] ||
      geometry.camera.zoom !== camera.zoom) {
    const previous = geometry.camera;
    const ratio = 2 ** (camera.zoom - previous.zoom);
    const [px,py] = project(previous.center);
    screen.fillStyle = colors.water;
    screen.fillRect(0, 0, width, height);
    screen.drawImage(layers, px - width * ratio / 2, py - height * ratio / 2, width * ratio, height * ratio);
  } else screen.drawImage(layers, 0, 0, width, height);
  if (selected && !drag) {
    const path = polygonPath(selected.rings, camera);
    screen.strokeStyle = '#152f52';
    screen.lineWidth = 2.2;
    screen.stroke(path);
  }
  updateScale();
}
function drawSoon() {
  if (canvasRaf) return;
  canvasRaf = requestAnimationFrame(() => { canvasRaf = 0; paintFrame(); });
}
function setNotice(text) {
  $('map-notice').textContent = text;
  $('map-notice').hidden = !text;
}
function updateCounts(summary) {
  for (const key of ['delivered', 'candidate', 'unknown']) {
    $('visible-' + key).textContent = summary ? format.format(summary[key]) : '—';
  }
}
async function requestLayer() {
  const requestId = ++revision;
  latestRequest?.abort();
  latestRequest = new AbortController();
  const start = performance.now();
  phase = 'loading';
  if (!viewData) setNotice('화면 범위의 자료를 불러오는 중입니다.');
  try {
    const bbox = bounds().map(n => n.toFixed(5));
    const query = new URLSearchParams({ bbox: bbox.join(','), z: camera.zoom.toFixed(3), w: width, h: height });
    const response = await fetch('/api/view?' + query, { signal: latestRequest.signal });
    if (!response.ok) throw Error('VIEW_FAILED');
    const beforeJSON = performance.now();
    const data = await response.json();
    if (revision !== requestId) return;
    const parseMs = performance.now() - beforeJSON;
    viewData = data;
    selected = null;
    $('inspection').hidden = true;
    const failed = unavailable(meta.diagnostics.state);
    $('resolution').textContent = failed ? '경계 미연결' : data.resolution;
    if (failed) setNotice(meta.diagnostics.message || '공식 국가기초구역 자료 연결 대기');
    else setNotice(data.features.length ? '' : '이 화면 범위의 관측 자료가 없습니다.');
    updateCounts(failed ? null : data.summary);
    const drawMs = redrawGeometry();
    phase = 'ready';
    const timing = { scope: view, zoom: camera.zoom, width, height, features: data.features.length, points: data.points.length,
      transferMs: +(beforeJSON - start).toFixed(2), parseMs: +parseMs.toFixed(2), drawMs: +drawMs.toFixed(2),
      firstLayoutMs: +(performance.now() - start).toFixed(2),
      serverBuildMs: Number(response.headers.get('server-timing')?.match(/dur=([0-9.]+)/)?.[1]) || 0,
      cacheHit: response.headers.get('x-view-cache') === 'hit', state: meta.diagnostics.state || 'CONNECTED' };
    metrics.cycles.push(timing);
    if (metrics.cycles.length > 90) metrics.cycles.shift();
    metrics.ready = true;
    if (currentInteraction !== null) {
      timing.updateAfterGestureMs = +(performance.now() - currentInteraction).toFixed(2);
      currentInteraction = null;
    }
    document.body.dataset.phase = 'ready';
  } catch (error) {
    if (revision !== requestId || error.name === 'AbortError') return;
    phase = 'error';
    document.body.dataset.phase = 'error';
    setNotice('자료를 불러오지 못했습니다. 같은 범위를 다시 선택해 주세요.');
  }
}
function scheduleFetch(delay = 110) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => void requestLayer(), delay);
}
function actualCursor(event) {
  const r = map.getBoundingClientRect();
  return [event.clientX - r.left, event.clientY - r.top];
}
function clipCenter([x,y]) {
  return [Math.max(124.15, Math.min(132.15, x)), Math.max(32.9, Math.min(39.4, y))];
}
function move(dx,dy, previous = camera) {
  camera = { zoom: previous.zoom, center: clipCenter(unproject(width / 2 - dx, height / 2 - dy, previous)) };
  drawSoon();
}
function zoomBy(step, point = [width / 2, height / 2]) {
  const zoom = Math.max(5.5, Math.min(16, camera.zoom + step));
  if (zoom === camera.zoom) return;
  const location = unproject(...point);
  camera = { zoom, center: clipCenter(unproject(width - point[0], height - point[1], { center: location, zoom })) };
  drawSoon();
  currentInteraction = performance.now();
  scheduleFetch();
}

function select(feature) {
  selected = feature;
  if (!feature) {
    $('inspection').hidden = true;
    drawSoon();
    return;
  }
  $('inspection').hidden = false;
  $('area-state').textContent = states[feature.tone];
  $('area-state').className = 'area-state ' + feature.tone;
  $('area-name').textContent = feature.label;
  const fmt = value => typeof value === 'number' ? format.format(value) : value || '미확인';
  const entries = [
    ['등록 매장', feature.stores], ['관측 배송', feature.visits > 0 ? feature.visits : '확인된 기록 없음'],
    ['최근 배송', feature.latest], ['배송 확인 오산신규', feature.newActive],
    ['오산신규 배송 미확인', feature.newUnknown], ['오산보류 이력', feature.held],
    ['관측 기간', meta.evidence.observedDays + '/' + meta.evidence.totalDays + '일'],
  ];
  if (feature.visits > 0 && feature.areaKm2 > 0) entries.splice(2, 0, ['관측 배송/km²', +(feature.visits / feature.areaKm2).toFixed(1)]);
  $('area-facts').replaceChildren(...entries.flatMap(([name, val]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = name; dd.textContent = fmt(val); return [dt,dd];
  }));
  drawSoon();
}

map.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  map.setPointerCapture(event.pointerId);
  drag = { initial: actualCursor(event), camera: {center: [...camera.center], zoom: camera.zoom} };
});
map.addEventListener('pointermove', event => {
  if (!drag) return;
  const [x,y] = actualCursor(event);
  const delta = [x - drag.initial[0], y - drag.initial[1]];
  if (Math.hypot(...delta) > 4 || map.classList.contains('dragging')) {
    map.classList.add('dragging'); move(...delta, drag.camera);
  }
});
function stopPointer(event) {
  if (!drag) return;
  if (map.classList.contains('dragging')) {
    map.classList.remove('dragging'); selected = null; $('inspection').hidden = true;
    currentInteraction = performance.now(); scheduleFetch(0);
  } else if (event.type === 'pointerup' && geometry.camera && phase === 'ready') {
    const [x,y] = actualCursor(event);
    screen.save(); screen.resetTransform();
    const hit = [...featurePaths].reverse().find(f => screen.isPointInPath(f.path, x, y, 'evenodd'));
    screen.restore();
    select(hit?.feature);
  }
  drag = null;
}
map.addEventListener('pointerup', stopPointer);
map.addEventListener('pointercancel', stopPointer);
map.addEventListener('wheel', event => {
  event.preventDefault(); zoomBy(event.deltaY < 0 ? 0.32 : -0.32, actualCursor(event));
}, { passive: false });
map.addEventListener('keydown', event => {
  const movement = { ArrowLeft:[60,0], ArrowRight:[-60,0], ArrowUp:[0,60], ArrowDown:[0,-60] };
  if (movement[event.key]) {
    event.preventDefault(); move(...movement[event.key]); currentInteraction = performance.now(); scheduleFetch();
  } else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(0.82); }
  else if (event.key === '-') { event.preventDefault(); zoomBy(-0.82); }
  else if (event.key === 'Escape') select(null);
});
$('zoom-in').addEventListener('click', () => zoomBy(0.82));
$('zoom-out').addEventListener('click', () => zoomBy(-0.82));
$('close-inspection').addEventListener('click', () => select(null));
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === button));
    fitCamera();
    select(null);
    drawSoon();
    scheduleFetch(0);
  });
}

if (new URLSearchParams(location.search).get('bench') === '1') {
  let frameRequest, previousFrame;
  const intervals = [];
  function collectFrame(now) {
    if (previousFrame !== undefined) intervals.push(now - previousFrame);
    previousFrame = now;
    frameRequest = requestAnimationFrame(collectFrame);
  }
  window.opsmapBench = {
    metrics,
    startFrames() {
      cancelAnimationFrame(frameRequest);
      previousFrame = undefined;
      intervals.length = 0;
      frameRequest = requestAnimationFrame(collectFrame);
    },
    stopFrames() {
      cancelAnimationFrame(frameRequest);
      const elapsed = intervals.reduce((duration, frame) => duration + frame, 0);
      return { fps: elapsed ? +(intervals.length * 1000 / elapsed).toFixed(2) : 0, intervals: [...intervals] };
    },
    regionTarget: () => {
      const sample = viewData?.features.filter(f => f.visits > 0)
        .map(f => ({ id: f.id, point: project(f.center) }))
        .filter(p => p.point[0] > 30 && p.point[0] < width - 30 && p.point[1] > 100 && p.point[1] < height - 70)
        .sort((a, b) => Math.hypot(a.point[0] - width / 2, a.point[1] - height / 2) -
          Math.hypot(b.point[0] - width / 2, b.point[1] - height / 2))[0];
      return sample || null;
    },
  };
}

function initializeText() {
  const evidence = meta.evidence;
  $('top-scope').textContent = '프레시온 · 90일 관측';
  $('layer-name').textContent = meta.label;
  $('analysis-title').textContent = meta.title;
  $('analysis-description').textContent = meta.description;
  document.title = meta.title + ' · 운영지도';
  $('period-dates').textContent = evidence.dateStart + ' ~ ' + evidence.dateEnd;
  $('date-progress').style.width = evidence.observedDays / evidence.totalDays * 100 + '%';
  $('availability-label').textContent = evidence.observedDays + '/90일 관측 · 미확인 ' + evidence.missingDates.length + '일';
  for (const [id, n] of [['stores',evidence.stores], ['visits',evidence.bound],
    ['new',evidence.newActive], ['unconfirmed',evidence.newUnknown], ['held',evidence.held]]) $('total-' + id).textContent = format.format(n);
  $('coverage-note').textContent = '관측 원천 오산 · 영남·호남 미확인. 위치 미연결 ' +
    format.format(evidence.unplaced) + '건. 색상은 지도 범위 기준이며 배송 가능 여부는 별도 확인합니다.';
  const a = document.createElement('a');
  a.href = meta.boundary.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = meta.boundary.label;
  $('source-note').replaceChildren(a, meta.boundary.vintage ? ' · ' + meta.boundary.vintage : '');
  const unknownVintage = meta.mode === 'postal' && meta.boundary.vintage?.startsWith('배포 기준일 미공개');
  $('map-source').textContent = 'Natural Earth · ' + (unknownVintage ? '우편번호 경계 기준일 미공개' : meta.label);
}

try {
  [meta, basemap] = await Promise.all(['/api/meta', '/basemap.json'].map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw Error('PROTOTYPE_START_FAILED');
    return response.json();
  }));
  initializeText();
  new ResizeObserver(() => {
    const box = map.getBoundingClientRect();
    if (Math.round(box.width) === width && Math.round(box.height) === height) return;
    width = Math.round(box.width); height = Math.round(box.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (width < 240 || height < 240) return;
    fitCamera();
    redrawGeometry();
    scheduleFetch(0);
  }).observe(map);
} catch {
  document.body.dataset.phase = 'error';
  setNotice('분석 자료에 연결할 수 없습니다.');
}
