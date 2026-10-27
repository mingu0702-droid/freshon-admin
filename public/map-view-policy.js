/* Deterministic geographic grouping and camera ownership. No source/network IO. */
(function (root) {
  'use strict';
  const EARTH = 6378137;
  const groupingCache=new WeakMap();
  const finitePoint = row => Number.isFinite(row?.lat) && Number.isFinite(row?.lng);
  const regionColors = Object.freeze({ '수도권':'#2563eb', '강원권':'#0f766e', '충청권':'#b45309', '호남권':'#7c3aed', '영남권':'#047857', '제주권':'#0369a1' });
  function world(row) {
    const phi = Math.max(-85, Math.min(85, row.lat)) * Math.PI / 180;
    return {x: EARTH * row.lng * Math.PI / 180, y: EARTH * Math.log(Math.tan(Math.PI / 4 + phi / 2))};
  }
  function zoomBand(level) {
    return level >= 12 ? 4 : level >= 9 ? 3 : level >= 7 ? 2 : level >= 5 ? 1 : 0;
  }
  function region(row) {
    return regionColors[row.addressRegion] ? row.addressRegion : '';
  }
  function vehicle(row, mode) {
    return String(mode === 'DATE_ROUTE' ? row.vehicle || row.actualVehicle || '' : row.baseVehicle || row.vehicle || '').replace(/호(?:차)?$/, '');
  }
  function stableClusters(rows, project, level, selectedCode = '', viewport = null, options = {}) {
    const mode = options.mode || 'BASE_60D';
    const band = zoomBand(Number(level));
    const limit = Math.max(40, Math.min(300, Number(options.maxMarkers) || 180));
    const protectedCodes = new Set([selectedCode, ...(options.protectedCodes || [])].filter(Boolean));
    const pinned = [], ordinary = [];
    for (const row of rows || []) {
      if (!finitePoint(row)) continue;
      (protectedCodes.has(row.customerCode) ? pinned : ordinary).push(row);
    }
    const visible = row => {
      if (!viewport || protectedCodes.has(row.customerCode)) return true;
      const p = project(row);
      return Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= -80 && p.y >= -80 && p.x <= viewport.width + 80 && p.y <= viewport.height + 80;
    };
    const cacheKey=viewport||options.sourceVersion===undefined?null:JSON.stringify([options.sourceVersion,mode,band,limit,[...protectedCodes].sort()]);
    const saved=cacheKey&&groupingCache.get(rows)?.get(cacheKey);
    if(saved)return saved.filter(visible);
    const remember=result=>{if(cacheKey){let entries=groupingCache.get(rows);if(!entries){entries=new Map();groupingCache.set(rows,entries);}while(entries.size>=12)entries.delete(entries.keys().next().value);entries.set(cacheKey,result);}return result.filter(visible);};
    if (band === 0 && ordinary.length + pinned.length <= limit) return remember([...pinned, ...ordinary]);
    const baseCell = [80, 700, 3500, 18000, 120000][band];
    let grouped;
    // Bucket in world metres, not screen pixels: pan and small zoom changes do
    // not assign a customer to a different group. Never silently drop stores.
    for (let pass = 0; pass < 14; pass++) {
      grouped = new Map();
      const cell = baseCell * (2 ** pass);
      for (const row of ordinary) {
        const r = region(row), v = vehicle(row, mode), point = world(row);
        const semantic = pass >= 5 ? 'mixed' : mode === 'BASE_60D' && band === 4 ? (r || '지역') : `${row.baseVehicleGroup || row.vehicleGroup || ''}:${v || '미지정'}`;
        const key = `${mode}:${band}:${pass}:${semantic}:${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`;
        let group = grouped.get(key);
        if (!group) { group = {key, rows:[], lat:0, lng:0, south:Infinity,north:-Infinity,west:Infinity,east:-Infinity}; grouped.set(key, group); }
        group.rows.push(row); group.lat += row.lat; group.lng += row.lng;
        group.south=Math.min(group.south,row.lat); group.north=Math.max(group.north,row.lat);
        group.west=Math.min(group.west,row.lng); group.east=Math.max(group.east,row.lng);
      }
      // The marker limit applies to the current viewport. Counting nationwide
      // groups here makes close zooms merge distant stores into huge clusters.
      const visibleGroups = viewport ? [...grouped.values()].filter(g => visible({lat:g.lat/g.rows.length,lng:g.lng/g.rows.length})).length : grouped.size;
      if (visibleGroups + pinned.filter(visible).length <= limit) break;
    }
    const result = [...pinned];
    for (const group of grouped.values()) {
      if (group.rows.length === 1) { result.push(group.rows[0]); continue; }
      const vehicles = new Set(group.rows.map(row=>vehicle(row,mode)));
      const regions = new Set(group.rows.map(region));
      const v=vehicles.size===1?[...vehicles][0]:'', r=regions.size===1?[...regions][0]:'';
      const regional=mode==='BASE_60D'&&band===4&&Boolean(r);
      const label=regional?r:v?`${v}호`:r||'여러 호차';
      result.push({
        // Do not borrow a customer identity from the first member of a cluster.
        customerCode:'', customerName:label, vehicle:regional?'':v,
        lat:group.lat/group.rows.length,lng:group.lng/group.rows.length,
        clusterKey:group.key, clusterCount:group.rows.length, clusterLabel:label,
        clusterKind:regional?'region':v?'vehicle':'mixed', clusterColorKey:regional?r:v||r,
        addressRegion:r, clusterBounds:{south:group.south,north:group.north,west:group.west,east:group.east}
      });
    }
    return remember(result);
  }
  function createCamera({map, element, clock=Date.now, raf=fn=>requestAnimationFrame(fn), cancelRaf=id=>cancelAnimationFrame(id)}={}) {
    let width=-1,height=-1, frame=null, disposed=false, interaction=0, movingUntil=0;
    const measure=()=>({w:Math.round(element?.clientWidth||0),h:Math.round(element?.clientHeight||0)});
    function userGesture(){interaction++;movingUntil=clock()+300;}
    function relayout(){
      if(disposed)return;
      const {w,h}=measure(); if(w<1||h<1||w===width&&h===height)return;
      if(clock()<movingUntil){if(frame===null)frame=raf(()=>{frame=null;relayout();});return;}
      width=w;height=h;
      const center=map.getCenter?.();
      map.relayout?.();
      if(center)map.setCenter?.(center);
    }
    function scheduleRelayout(){if(frame===null&&!disposed)frame=raf(()=>{frame=null;relayout();});}
    return { userGesture, interaction:()=>interaction, scheduleRelayout, relayout,
      dispose(){disposed=true;if(frame!==null)cancelRaf(frame);frame=null;},
      dimensions:()=>({width,height}) };
  }
  root.MapViewPolicy=Object.freeze({stableClusters,zoomBand,createCamera,regionColors});
})(typeof window==='object'?window:globalThis);
