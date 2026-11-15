import { decodePostalTile, intersects, postalTilesLevel } from './postal-geometry.mjs';

const viewportCacheLimit = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const styles = {
  UNKNOWN: ['rgba(202,213,224,.24)', 'rgba(87,111,134,.45)'],
  CANDIDATE: ['rgba(239,163,67,.68)', '#b87730'],
  LOW: ['rgba(120,179,227,.63)', '#4780b5'],
  HIGH: ['rgba(41,96,172,.73)', '#205295'],
};
const svgNS = 'http://www.w3.org/2000/svg';

function rasterOutline(ctx, width, height) {
  const pixels = ctx.createImageData(width, height);
  const rgba = new Uint32Array(pixels.data.buffer);
  return {
    line(fromX, fromY, toX, toY) {
      const deltaX = toX - fromX, deltaY = toY - fromY;
      const steps = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      if (Math.max(fromX, toX) < 0 || Math.min(fromX, toX) >= width ||
          Math.max(fromY, toY) < 0 || Math.min(fromY, toY) >= height) return;
      const limit = Math.min(steps, 4 * (width + height));
      for (let i = 0; i <= limit; i++) {
        const fraction = limit ? i / limit : 0;
        const x = Math.round(fromX + fraction * deltaX), y = Math.round(fromY + fraction * deltaY);
        if (x >= 0 && y >= 0 && x < width && y < height) rgba[y * width + x] = 0x638a7966;
      }
    },
    show() { ctx.putImageData(pixels, 0, 0); },
  };
}

export function createPostalGeometryReader(api) {
  const cache = new Map();
  let bytes = 0;
  function retain(key, payload) {
    while (cache.size && bytes + payload.bytes > viewportCacheLimit) {
      const oldest = cache.keys().next().value;
      bytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    cache.set(key, payload);
    bytes += payload.bytes;
  }
  return {
    async read(view, signal) {
      const found = new Map();
      const missing = [];
      for (const tile of view.tiles) {
        const key = view.boundary + ':' + tile[0];
        const saved = cache.get(key);
        if (saved) {
          cache.delete(key);
          cache.set(key, saved);
          found.set(tile[0], saved);
        } else missing.push(tile);
      }
      while (missing.length) {
        let length = 0;
        const list = [];
        while (missing.length && list.length < 24 && length + missing[0][1] <= MAX_REQUEST_BYTES) {
          const tile = missing.shift();
          list.push(tile);
          length += tile[1];
        }
        if (!list.length) throw Error('POSTAL_GEOMETRY_BUDGET');
        const query = new URLSearchParams({ v: view.boundary, ids: list.map(tile => tile[0]).join(',') });
        const response = await fetch(api + '/geometry?' + query, { signal, cache: 'no-store' });
        if (!response.ok) throw Object.assign(Error('POSTAL_GEOMETRY_UNAVAILABLE'), { status: response.status });
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength !== length || signal.aborted) throw Error('POSTAL_GEOMETRY_SIZE');
        let offset = 0;
        for (const [id, size] of list) {
          const part = buffer.slice(offset, offset + size);
          const zones = decodePostalTile(part);
          const occupied = size + zones.length * 176 + zones.reduce((count, zone) => count + zone.rings.length * 72, 0);
          const item = { zones, bytes: occupied };
          found.set(id, item);
          retain(view.boundary + ':' + id, item);
          offset += size;
        }
      }
      return view.tiles.map(([id]) => found.get(id).zones);
    },
    clear() { cache.clear(); bytes = 0; },
    metrics: () => ({ bytes, tiles: cache.size, limit: viewportCacheLimit }),
  };
}

export function createPostalMap(host, maps, { idle, select }) {
  const base = new maps.Map(host, { center: new maps.LatLng(36.12, 127.92), level: 13 });
  const surface = document.createElement('canvas');
  surface.className = 'postal-map-overlay';
  surface.setAttribute('aria-hidden', 'true');
  const selection = document.createElementNS(svgNS, 'svg');
  selection.classList.add('postal-map-selection');
  selection.setAttribute('width','1');
  selection.setAttribute('height','1');
  selection.setAttribute('aria-hidden','true');
  const selectionPath = document.createElementNS(svgNS,'path');
  selection.append(selectionPath);
  const overlay = new maps.AbstractOverlay();
  const ctx = surface.getContext('2d');
  let scene, marker, circle, selected, rendered, selectedGeometry, selectedLevel;
  let frame, active = true;
  let totalDraws = 0;
  const projected = new Map();

  function clearProjected() {
    for (const { image } of projected.values()) image.width = image.height = 1;
    projected.clear();
  }

  function viewport() {
    const bounds = base.getBounds();
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const box = [sw.getLng(), sw.getLat(), ne.getLng(), ne.getLat()];
    return { box, level: Math.max(1, Math.min(14, Math.round(base.getLevel()))) };
  }

  function translate() {
    if (!rendered) return;
    const projection = overlay.getProjection();
    const origin = projection.pointFromCoords(rendered.anchor);
    surface.style.left = origin.x - rendered.width / 2 + 'px';
    surface.style.top = origin.y - rendered.height / 2 + 'px';
    const ratio = 2 ** (rendered.level - base.getLevel());
    surface.style.transform = ratio === 1 ? '' : 'scale(' + ratio + ')';
    if (selectedGeometry) {
      selection.style.left = origin.x + 'px';
      selection.style.top = origin.y + 'px';
      if (selectedLevel !== base.getLevel()) {
        selectedLevel = base.getLevel();
        const commands = [];
        for (const ring of selectedGeometry.rings) {
          for (let i = 0; i < ring.length; i += 2) {
            const point = projection.pointFromCoords(new maps.LatLng(ring[i + 1] / 1e6, ring[i] / 1e6));
            commands.push((i ? 'L' : 'M') + (point.x - origin.x).toFixed(2) + ' ' + (point.y - origin.y).toFixed(2));
          }
          commands.push('Z');
        }
        selectionPath.setAttribute('d', commands.join(''));
      }
    }
  }

  function updateSelection() {
    selectedGeometry = null;
    selectedLevel = undefined;
    if (selected && scene) {
      for (const tile of scene.geometry) {
        selectedGeometry = tile.find(zone => zone.id === Number(selected.id));
        if (selectedGeometry) break;
      }
    }
    if (!selectedGeometry) selectionPath.removeAttribute('d');
    translate();
  }

  function render() {
    frame = undefined;
    if (!scene || !active) return;
    const started = performance.now();
    const current = viewport(), { level } = current;
    if (scene.tier !== postalTilesLevel(current.box.map(value => Number(value.toFixed(5))))) { translate(); return; }
    const width = Math.ceil(host.clientWidth), height = Math.ceil(host.clientHeight);
    if (!width || !height) return;
    const anchor = base.getCenter();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
    const key = [scene.version,level,anchor.getLat().toFixed(7),anchor.getLng().toFixed(7),pixelWidth,pixelHeight].join(':');
    if (surface.width !== pixelWidth || surface.height !== pixelHeight) {
      surface.width = pixelWidth;
      surface.height = pixelHeight;
      surface.style.width = width + 'px';
      surface.style.height = height + 'px';
    }
    function finish(shown, vertices, cached) {
      rendered = { anchor, width, height, level, shown, vertices, key };
      updateSelection();
      host.dataset.postalDraw = JSON.stringify({ count: ++totalDraws, shown, vertices, level, cached,
        tier: scene.tier, drawMs: +(performance.now() - started).toFixed(2) });
    }
    if (rendered?.key === key) { finish(rendered.shown, rendered.vertices, true); return; }
    if (projected.has(key)) {
      const saved = projected.get(key);
      projected.delete(key);
      projected.set(key, saved);
      ctx.resetTransform();
      ctx.clearRect(0, 0, pixelWidth, pixelHeight);
      ctx.drawImage(saved.image, 0, 0);
      finish(saved.shown, saved.vertices, true);
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const projection = overlay.getProjection();
    const origin = projection.pointFromCoords(anchor);
    const xOffset = width / 2 - origin.x, yOffset = height / 2 - origin.y;
    const viewportBox = current.box.map(v => Math.round(v * 1e6));
    const tones = Object.fromEntries(Object.keys(styles).map(k => [k, new Path2D()]));
    const outline = scene.tier === 'detail' ? null : rasterOutline(ctx, surface.width, surface.height);
    let shown = 0, vertices = 0;
    function vertex(lng, lat) {
      const point = projection.pointFromCoords(new maps.LatLng(lat / 1e6, lng / 1e6));
      return [Math.round((point.x + xOffset) * dpr) / dpr, Math.round((point.y + yOffset) * dpr) / dpr];
    }
    function append(path, ring) {
      let oldX, oldY;
      for (let i = 0; i < ring.length; i += 2) {
        const [x, y] = vertex(ring[i], ring[i + 1]);
        if (!i) path.moveTo(x, y);
        else if (x !== oldX || y !== oldY) path.lineTo(x, y);
        oldX = x;
        oldY = y;
      }
      path.closePath();
    }
    for (const tile of scene.geometry) for (const zone of tile) {
      if (!intersects(zone.box, viewportBox)) continue;
      const tone = scene.tones.get(zone.id) || 'UNKNOWN';
      for (const ring of zone.rings) {
        if (outline && tone === 'UNKNOWN') {
          let [x, y] = vertex(ring.at(-2), ring.at(-1));
          for (let i = 0; i < ring.length; i += 2) {
            const [bx, by] = vertex(ring[i], ring[i + 1]);
            if (x !== bx || y !== by) outline.line(Math.round(x*dpr), Math.round(y*dpr), Math.round(bx*dpr), Math.round(by*dpr));
            x = bx;
            y = by;
          }
        } else append(tones[tone], ring);
        vertices += ring.length / 2;
      }
      shown++;
    }
    outline?.show();
    ctx.lineJoin = 'round';
    for (const [tone, [fill, stroke]] of Object.entries(styles)) {
      if (outline && tone === 'UNKNOWN') continue;
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = tone === 'UNKNOWN' ? .55 : .8;
      ctx.fill(tones[tone], 'evenodd');
      ctx.stroke(tones[tone]);
    }
    if (scene.tier !== 'national') {
      for (const [, [lat, lng], valid, missing, held] of scene.badges) {
        const [x, y] = vertex(lng * 1e6, lat * 1e6);
        const badges = [[valid, '#088478'], [missing, '#fff'], [held, '#8544a3']].filter(([value]) => value);
        badges.forEach(([, color], i) => {
          ctx.beginPath();
          ctx.arc(x + (i - (badges.length - 1) / 2) * 9, y, 3.4, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.strokeStyle = color === '#fff' ? '#087c71' : '#fff';
          ctx.lineWidth = 1.1;
          ctx.fill(); ctx.stroke();
        });
      }
    }
    if (pixelWidth * pixelHeight <= 2_500_000) {
      if (projected.size === 2) {
        const oldest = projected.keys().next().value, image = projected.get(oldest).image;
        image.width = image.height = 1;
        projected.delete(oldest);
      }
      const image = document.createElement('canvas');
      image.width = pixelWidth;
      image.height = pixelHeight;
      image.getContext('2d').drawImage(surface, 0, 0);
      projected.set(key, { image, shown, vertices });
    }
    finish(shown, vertices, false);
  }

  function schedule() {
    if (active && frame === undefined) frame = requestAnimationFrame(render);
  }
  overlay.onAdd = function () { this.getPanels().overlayLayer.prepend(surface,selection); };
  overlay.onRemove = () => { surface.remove(); selection.remove(); };
  overlay.draw = translate;
  overlay.setMap(base);

  const click = event => {
    if (active && event?.latLng) select([event.latLng.getLat(), event.latLng.getLng()]);
  };
  maps.event.addListener(base, 'click', click);
  maps.event.addListener(base, 'idle', idle);

  return {
    viewport,
    relayout() { base.relayout(); schedule(); },
    focus(location, bounds, radius = 0) {
      if (!bounds && location && radius) {
        const dy = radius * 1.2 / 111320, dx = dy / Math.cos(location[0] * Math.PI / 180);
        bounds = [location[1] - dx, location[0] - dy, location[1] + dx, location[0] + dy];
      }
      if (bounds?.length === 4) {
        base.setBounds(new maps.LatLngBounds(new maps.LatLng(bounds[1], bounds[0]), new maps.LatLng(bounds[3], bounds[2])), 28);
      } else if (location) {
        base.setCenter(new maps.LatLng(...location));
        base.setLevel(3);
      }
      idle();
    },
    zoom(delta) { base.setLevel(Math.max(1, Math.min(14, base.getLevel() + delta))); idle(); },
    point(location, radius = 0) {
      marker?.setMap(null);
      circle?.setMap(null);
      marker = null;
      circle = null;
      if (!location || !maps.CustomOverlay) return;
      const pin = document.createElement('span');
      pin.className = 'coverage-search-pin';
      pin.setAttribute('aria-label', '조회 위치');
      marker = new maps.CustomOverlay({ position: new maps.LatLng(...location), content: pin, zIndex: 30 });
      marker.setMap(base);
      if (radius && maps.Circle) {
        circle = new maps.Circle({ center:new maps.LatLng(...location), radius, strokeColor:'#294d7b',
          strokeWeight:2, strokeStyle:'shortdash', strokeOpacity:.85, fillOpacity:0 });
        circle.setMap(base);
      }
    },
    show(view, geometry) {
      const version = [view.generation, view.boundary, view.period.days, view.center].join(':');
      if (scene?.version !== version) clearProjected();
      scene = { version, tier: view.tier, tones: new Map(view.tones), badges: view.badges, geometry };
      schedule();
    },
    select(area) { selected = area; updateSelection(); },
    clear() {
      cancelAnimationFrame(frame);
      frame = undefined;
      ctx.clearRect(0, 0, surface.width, surface.height);
      surface.width = surface.height = 1;
      clearProjected();
      selected = scene = rendered = null;
      updateSelection();
      marker?.setMap(null);
      circle?.setMap(null);
      marker = null;
      circle = null;
      delete host.dataset.postalDraw;
    },
    destroy() {
      active = false;
      this.clear();
      maps.event.removeListener(base, 'click', click);
      maps.event.removeListener(base, 'idle', idle);
      overlay.setMap(null);
    },
  };
}
