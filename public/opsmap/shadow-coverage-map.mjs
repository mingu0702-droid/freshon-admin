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
  return cell.visits ? 'light' : 'none';
}

export function createCoverageMap(map, maps, { idle, select, enabled }) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.classList.add('coverage-overlay');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '1');
  svg.setAttribute('height', '1');
  const overlay = new maps.AbstractOverlay();
  let cells = EMPTY, selected = null, radiusCircle = null, anchor = null;
  let renderedCells, renderedSelection, renderedLevel, frame;

  function draw() {
    frame = undefined;
    if (!anchor || !enabled()) return;
    const projection = overlay.getProjection();
    const origin = projection.pointFromCoords(anchor);
    svg.style.left = origin.x + 'px';
    svg.style.top = origin.y + 'px';

    const level = map.getLevel();
    if (cells === renderedCells && selected === renderedSelection && level === renderedLevel) return;
    renderedCells = cells;
    renderedSelection = selected;
    renderedLevel = level;
    const fragment = document.createDocumentFragment();
    const visible = selected?.boundary && !cells.some(cell => cell.id === selected.id) ? [...cells, selected] : cells;
    for (const cell of visible) {
      const path = document.createElementNS(SVG, 'path');
      const vertices = cell.boundary.map(([lat, lng]) => {
        const point = projection.pointFromCoords(new maps.LatLng(lat, lng));
        return (point.x - origin.x) + ' ' + (point.y - origin.y);
      });
      path.setAttribute('d', 'M' + vertices.join('L') + 'Z');
      path.dataset.tone = appearance(cell);
      if (cell.id === selected?.id) path.classList.add('coverage-selected');
      fragment.append(path);
    }
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
    render(value, highlight) {
      if (!value.length && !highlight) {
        svg.replaceChildren();
        cells = renderedCells = EMPTY;
        selected = renderedSelection = anchor = null;
        return;
      }
      if (value !== cells) {
        cells = value;
        anchor = map.getCenter();
      }
      selected = highlight;
      schedule();
    },
    suspend() {
      cancelAnimationFrame(frame);
      frame = undefined;
      radiusCircle?.setMap(null);
      radiusCircle = null;
    },
    destroy() {
      maps.event.removeListener(map, 'click', onMapClick);
      maps.event.removeListener(map, 'idle', idle);
      radiusCircle?.setMap(null);
      overlay.setMap(null);
      cancelAnimationFrame(frame);
      cells = EMPTY;
      selected = null;
    }
  };
}
