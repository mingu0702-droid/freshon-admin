(() => {
  const geometry = new Set();
  const instances = new WeakMap();
  let mapCount = 0;
  function emit(target, name, event) {
    for (const listener of target.listeners.get(name) || []) listener(event);
  }
  class LatLng {
    constructor(lat, lng) { this.lat = Number(lat); this.lng = Number(lng); }
    getLat() { return this.lat; }
    getLng() { return this.lng; }
  }
  class LatLngBounds {
    constructor(sw, ne) { this.sw = sw; this.ne = ne; }
    extend(p) {
      this.sw = new LatLng(Math.min(this.sw?.lat ?? p.lat, p.lat), Math.min(this.sw?.lng ?? p.lng, p.lng));
      this.ne = new LatLng(Math.max(this.ne?.lat ?? p.lat, p.lat), Math.max(this.ne?.lng ?? p.lng, p.lng));
    }
    getSouthWest() { return this.sw; }
    getNorthEast() { return this.ne; }
    isEmpty() { return !this.sw; }
  }
  class FixtureMap {
    listeners = new Map();
    entries = new Set();
    constructor(element, { center, level }) {
      mapCount++;
      this.element = element;
      instances.set(element, this);
      this.center = center;
      this.level = level;
      element.style.background = '#e7eef4';
      this.layer = document.createElement('div');
      this.layer.style.cssText = 'position:absolute;inset:0;isolation:isolate;pointer-events:none';
      element.append(this.layer);
      element.addEventListener('click', event => {
        const rect = element.getBoundingClientRect();
        emit(this, 'click', { latLng: this.unproject({ x: event.clientX - rect.x, y: event.clientY - rect.y }) });
      });
    }
    getCenter() { return this.center; }
    getLevel() { return this.level; }
    scale() { return 170000 / 2 ** this.level; }
    project(p) {
      return { x: this.element.clientWidth / 2 + (p.lng - this.center.lng) * this.scale(),
        y: this.element.clientHeight / 2 - (p.lat - this.center.lat) * this.scale() };
    }
    unproject(p) {
      return new LatLng(this.center.lat - (p.y - this.element.clientHeight / 2) / this.scale(),
        this.center.lng + (p.x - this.element.clientWidth / 2) / this.scale());
    }
    getProjection() {
      return { pointFromCoords: p => this.project(p), containerPointFromCoords: p => this.project(p),
        coordsFromContainerPoint: p => this.unproject(p) };
    }
    getBounds() {
      return new LatLngBounds(this.unproject({ x: 0, y: this.element.clientHeight }),
        this.unproject({ x: this.element.clientWidth, y: 0 }));
    }
    setCenter(p) { this.center = p; this.render('center_changed'); }
    panTo(p) { this.setCenter(p); }
    panBy(x, y) { this.setCenter(this.unproject({ x: this.element.clientWidth / 2 + x, y: this.element.clientHeight / 2 + y })); }
    setLevel(level) { this.level = level; this.render('zoom_changed'); }
    setBounds(bounds) {
      if (!bounds.sw || !bounds.ne) return;
      this.center = new LatLng((bounds.sw.lat + bounds.ne.lat) / 2, (bounds.sw.lng + bounds.ne.lng) / 2);
      const span = Math.max(bounds.ne.lat - bounds.sw.lat, bounds.ne.lng - bounds.sw.lng, 0.001);
      this.level = Math.min(13, Math.max(2, Math.ceil(Math.log2(span * 170000 / Math.max(120, this.element.clientHeight - 60)))));
      this.render('bounds_changed');
    }
    relayout() { this.render('bounds_changed'); }
    render(name) {
      for (const item of this.entries) item.draw?.();
      emit(this, name);
      cancelAnimationFrame(this.idleFrame);
      this.idleFrame = requestAnimationFrame(() => emit(this, 'idle'));
    }
  }
  class AbstractOverlay {
    getPanels() { return { overlayLayer: this.map.layer }; }
    getProjection() { return this.map.getProjection(); }
    setMap(map) {
      if (this.map) { this.map.entries.delete(this); this.onRemove(); }
      this.map = map;
      if (map) { map.entries.add(this); this.onAdd(); this.draw(); }
    }
  }
  class CustomOverlay {
    constructor(options) {
      this.options = options;
      this.position = options.position;
      this.node = document.createElement('div');
      this.node.style.cssText = 'position:absolute;pointer-events:auto;z-index:' + (options.zIndex || 0);
      this.setContent(options.content);
      if (options.clickable) this.node.addEventListener('click', event => event.stopPropagation());
    }
    setContent(content) {
      if (typeof content === 'string') this.node.innerHTML = content;
      else if (content) this.node.replaceChildren(content);
    }
    setPosition(position) { this.position = position; this.draw(); }
    getPosition() { return this.position; }
    setZIndex(value) { this.node.style.zIndex = value; }
    draw() {
      if (!this.map || !this.position) return;
      const point = this.map.project(this.position);
      this.node.style.left = point.x + 'px';
      this.node.style.top = point.y + 'px';
    }
    setMap(map) {
      this.map?.entries.delete(this);
      this.node.remove();
      this.map = map;
      if (map) { map.entries.add(this); map.layer.append(this.node); this.draw(); }
    }
  }
  class Shape {
    listeners = new Map();
    constructor(options) { this.options = options; }
    setMap(map) { if (map) geometry.add(this); else geometry.delete(this); }
    setOptions(options) { Object.assign(this.options, options); }
  }
  window.__coverageFixture = { shapes: () => [...geometry].map(shape => shape.options), maps: () => mapCount, mapFor: element => instances.get(element) };
  window.kakao = { maps: { Map: FixtureMap, LatLng, LatLngBounds, AbstractOverlay, CustomOverlay,
    Polyline: Shape, Polygon: Shape, Circle: Shape, Point: class { constructor(x, y) { this.x = x; this.y = y; } },
    load: fn => fn(), event: {
      addListener(target, name, listener) {
        target.listeners ??= new Map();
        if (!target.listeners.has(name)) target.listeners.set(name, new Set());
        target.listeners.get(name).add(listener);
      },
      removeListener(target, name, listener) { target.listeners.get(name)?.delete(listener); },
      trigger: emit, preventMap() {}
    }
  } };
})();
