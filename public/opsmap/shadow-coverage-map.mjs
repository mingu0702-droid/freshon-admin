const SVG = 'http://www.w3.org/2000/svg';
const EMPTY = [];

function contains(boundary, lat, lng) {
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const [aLat, aLng] = boundary[i], [bLat, bLng] = boundary[j];
    if ((aLat > lat) !== (bLat > lat) && lng < (bLng - aLng) * (lat - aLat) / (bLat - aLat) + aLng) inside = !inside;
  }
  return inside;
}

function appearance(cell) {
  if (cell.status === 'UNKNOWN') return 'unknown';
  if (cell.status === 'CANDIDATE') return 'candidate';
  if (cell.status === 'EMPTY') return 'empty';
  if (cell.visits >= 50) return 'dense';
  if (cell.visits >= 10) return 'medium';
  return cell.visits || cell.observedStores ? 'light' : 'none';
}

export function mergeCoverageBadges(points) {
  const badges = [];
  for (const point of points) {
    // Even the three-digit badge fits in 32 CSS pixels including its outline.
    const overlap = badges.find(badge => (point.x - badge.x) ** 2 + (point.y - badge.y) ** 2 < 32 ** 2);
    if (overlap) overlap.cells += point.cells;
    else badges.push({ ...point });
  }
  return badges;
}

export function createCoverageMap(map, maps, { idle, select, enabled }) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.classList.add('coverage-overlay');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '1');
  svg.setAttribute('height', '1');
  const overlay = new maps.AbstractOverlay();
  let cells = EMPTY, selected = null, radiusCircle = null, searchMarker = null, anchor = null;
  let markers = EMPTY, hits = EMPTY, providerPaths = EMPTY, statusPins = EMPTY, statusHits = EMPTY;
  let renderedCells, renderedMarkers, renderedSelection, renderedLevel, renderedProviders, renderedPins, frame;

  function draw() {
    frame = undefined;
    if (!anchor || !enabled()) return;
    const projection = overlay.getProjection();
    const origin = projection.pointFromCoords(anchor);
    svg.style.left = origin.x + 'px';
    svg.style.top = origin.y + 'px';

    const level = map.getLevel();
    if (cells === renderedCells && markers === renderedMarkers && selected === renderedSelection &&
        level === renderedLevel && providerPaths === renderedProviders && statusPins === renderedPins) return;
    renderedCells = cells;
    renderedMarkers = markers;
    renderedSelection = selected;
    renderedLevel = level;
    renderedProviders = providerPaths;
    renderedPins = statusPins;
    const fragment = document.createDocumentFragment();
    const visible = selected?.boundary && !cells.some(cell => cell.id === selected.id) ? [...cells, selected] : cells;
    for (const cell of [...visible,...providerPaths]) {
      const path = document.createElementNS(SVG, 'path');
      const vertices = cell.boundary.map(([lat, lng]) => {
        const point = projection.pointFromCoords(new maps.LatLng(lat, lng));
        return (point.x - origin.x) + ' ' + (point.y - origin.y);
      });
      path.setAttribute('d', 'M' + vertices.join('L') + 'Z');
      if(cell.provider){path.dataset.provider=cell.provider;path.dataset.providerStatus=cell.status;}
      else {path.dataset.tone = appearance(cell);if (cell.id === selected?.id) path.classList.add('coverage-selected');}
      fragment.append(path);
    }
    hits = mergeCoverageBadges(markers.map(marker => {
      const point = projection.pointFromCoords(new maps.LatLng(...marker.location));
      return { ...marker, x: point.x - origin.x, y: point.y - origin.y };
    }));
    for (const { x, y, cells: countCells } of hits) {
      const badge = document.createElementNS(SVG, 'g');
      badge.classList.add('coverage-candidate-count');
      badge.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
      const circle = document.createElementNS(SVG, 'circle');
      circle.setAttribute('r', countCells >= 100 ? '15' : '12');
      const count = document.createElementNS(SVG, 'text');
      count.setAttribute('dy', '.35em');
      count.textContent = String(countCells);
      badge.append(circle, count);
      fragment.append(badge);
    }
    function badgeAt(point, state, count, offset = 0, historic = false) {
      const badge = document.createElementNS(SVG, 'g');
      badge.dataset.storeStatus = state;
      if (historic) badge.dataset.historic = '1';
      badge.setAttribute('transform', 'translate(' + (point.x - origin.x + offset) + ' ' + (point.y - origin.y) + ')');
      const circle = document.createElementNS(SVG, 'circle');
      circle.setAttribute('r', count ? '10' : '5');
      badge.append(circle);
      if (count) {
        const text = document.createElementNS(SVG, 'text');
        text.setAttribute('dy', '.35em');
        text.textContent = String(count);
        badge.append(text);
      }
      fragment.append(badge);
    }
    for (const cell of cells) {
      const summary = cell.storeStatus;
      if (!summary?.NEW && !summary?.HELD && !summary?.pastNew && !summary?.pastHeld && !summary?.heldOrderConflict) continue;
      const point = projection.pointFromCoords(new maps.LatLng(...cell.location));
      const counts = [['NEW', summary.NEW, false], ['HELD', summary.HELD, false],
        ['NEW_HISTORY', summary.pastNew, true], ['HELD', summary.pastHeld, true],
        ['HELD_CONFLICT', summary.heldOrderConflict, false]].filter(([,count])=>count);
      counts.forEach(([state,count,historic],i)=>badgeAt(point,state,count,(i-(counts.length-1)/2)*20,historic));
    }
    statusHits = statusPins.map(pin => {
      const point = projection.pointFromCoords(new maps.LatLng(...pin.location));
      const states = [[pin.state==='HELD' ? 'HELD' : null,false], [pin.newActive===true ? 'NEW' : null,false],
        [pin.pastNew && !pin.newActive ? 'NEW_HISTORY' : null,true], [pin.pastHeld && pin.state!=='HELD' ? 'HELD' : null,true],
        [pin.heldOrderConflict===true ? 'HELD_CONFLICT' : null,false]].filter(([state])=>state);
      states.forEach(([state,historic],i)=>badgeAt(point,state,null,(i-(states.length-1)/2)*10,historic));
      return { ...pin, x:point.x-origin.x, y:point.y-origin.y };
    });
    svg.replaceChildren(fragment);
  }

  // The SDK moves its overlay pane with the map. Same-scale pan only moves
  // the anchor; projecting all visible vertices is reserved for data/zoom.
  function schedule() {
    if (enabled() && frame === undefined) frame = requestAnimationFrame(draw);
  }
  overlay.onAdd = function () { this.getPanels().overlayLayer.prepend(svg); };
  overlay.onRemove = () => svg.remove();
  overlay.draw = schedule;
  overlay.setMap(map);

  function onMapClick(event) {
    if (!enabled() || !event?.latLng) return;
    if (anchor && (hits.length || statusHits.length)) {
      const projection = overlay.getProjection();
      const origin = projection.pointFromCoords(anchor), point = projection.pointFromCoords(event.latLng);
      const x = point.x - origin.x, y = point.y - origin.y;
      let nearest, distance = 16 ** 2;
      for (const hit of [...hits, ...statusHits]) {
        const squared = (x - hit.x) ** 2 + (y - hit.y) ** 2;
        if (squared <= distance) { nearest = hit; distance = squared; }
      }
      if (nearest) { select(nearest.id, nearest.location); return; }
    }
    const lat = event.latLng.getLat(), lng = event.latLng.getLng();
    const cell = cells.find(item => contains(item.boundary, lat, lng));
    if (cell) select(cell.id);
  }
  maps.event.addListener(map, 'click', onMapClick);
  maps.event.addListener(map, 'idle', idle);

  return {
    viewport() {
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
      return { box: [sw.getLng(), sw.getLat(), ne.getLng(), ne.getLat()],
        level: Math.max(1, Math.min(14, Math.round(map.getLevel()))) };
    },
    focus(location, bounds, meters = 0) {
      radiusCircle?.setMap(null);
      radiusCircle = null;
      if (location && (meters || !bounds)) {
        const [lat, lng] = location;
        const dLat = (meters || 550) * 1.2 / 111320, dLng = dLat / Math.cos(lat * Math.PI / 180);
        bounds = [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
      }
      if (bounds) {
        map.setBounds(new maps.LatLngBounds(new maps.LatLng(bounds[1], bounds[0]),
          new maps.LatLng(bounds[3], bounds[2])), 28);
        idle();
      }
      if (location && meters && maps.Circle) {
        radiusCircle = new maps.Circle({ center: new maps.LatLng(...location), radius: meters,
          strokeWeight: 2, strokeColor: '#284f8b', strokeStyle: 'shortdash', strokeOpacity: 0.8, fillOpacity: 0 });
        radiusCircle.setMap(map);
      }
    },
    searchPoint(location) {
      searchMarker?.setMap(null);
      searchMarker = null;
      if (!location || !maps.CustomOverlay) return;
      const pin = document.createElement('span');
      pin.className = 'coverage-search-pin';
      pin.setAttribute('role', 'img');
      pin.setAttribute('aria-label', '조회 위치');
      searchMarker = new maps.CustomOverlay({ position:new maps.LatLng(...location), content:pin, zIndex:30 });
      searchMarker.setMap(map);
    },
    render(value, highlight, candidateMarkers = EMPTY, layers = EMPTY, pins = EMPTY) {
      if (!value.length && !highlight && !candidateMarkers.length && !layers.length && !pins.length) {
        svg.replaceChildren();
        cells = renderedCells = markers = renderedMarkers = hits = providerPaths = renderedProviders = statusPins = renderedPins = statusHits = EMPTY;
        selected = renderedSelection = anchor = null;
        return;
      }
      if (value !== cells || candidateMarkers !== markers || layers!==providerPaths) {
        cells = value;
        anchor = map.getCenter();
      }
      markers = candidateMarkers;
      providerPaths = layers;
      statusPins = pins;
      selected = highlight;
      schedule();
    },
    suspend() {
      cancelAnimationFrame(frame);
      frame = undefined;
      radiusCircle?.setMap(null);
      radiusCircle = null;
      searchMarker?.setMap(null);
      searchMarker = null;
    },
    destroy() {
      maps.event.removeListener(map, 'click', onMapClick);
      maps.event.removeListener(map, 'idle', idle);
      radiusCircle?.setMap(null);
      searchMarker?.setMap(null);
      overlay.setMap(null);
      cancelAnimationFrame(frame);
      cells = markers = hits = statusPins = statusHits = EMPTY;
      selected = null;
    }
  };
}
