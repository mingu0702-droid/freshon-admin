/* Deterministic geographic grouping and camera ownership. No source/network IO. */
(function (root) {
  'use strict';
  const EARTH = 6378137;
  const groupingCache=new WeakMap();
  const finitePoint = row => Number.isFinite(row?.lat) && Number.isFinite(row?.lng) && Math.abs(row.lat)<=90 && Math.abs(row.lng)<=180;
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
  function makeGroup(key) {
    return {key, rows:[], lat:0, lng:0, x:0, y:0, south:Infinity, north:-Infinity, west:Infinity, east:-Infinity};
  }
  function addRow(group, row) {
    const point=world(row);
    group.rows.push(row);group.lat+=row.lat;group.lng+=row.lng;group.x+=point.x;group.y+=point.y;
    group.south=Math.min(group.south,row.lat);group.north=Math.max(group.north,row.lat);
    group.west=Math.min(group.west,row.lng);group.east=Math.max(group.east,row.lng);
  }
  function mergeNearby(groups, cell) {
    // Adjacent cells can both place a marker on their shared edge. Merge those
    // geographic neighbours too; the projection/viewport never owns membership.
    const list=[...groups.values()].sort((a,b)=>a.key.localeCompare(b.key));
    const parents=list.map((_,i)=>i), bins=new Map();
    const find=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
    for(let i=0;i<list.length;i++){
      const g=list[i],x=g.x/g.rows.length,y=g.y/g.rows.length,bx=Math.floor(x/cell),by=Math.floor(y/cell);
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const j of bins.get((bx+dx)+':'+(by+dy))||[]){
        const other=list[j],ox=other.x/other.rows.length,oy=other.y/other.rows.length;
        if((x-ox)**2+(y-oy)**2<(cell*.65)**2){const a=find(i),b=find(j);parents[Math.max(a,b)]=Math.min(a,b);}
      }
      const key=bx+':'+by;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(i);
    }
    const merged=new Map();
    for(let i=0;i<list.length;i++){
      const root=find(i),g=list[i];let target=merged.get(root);
      if(!target){target=makeGroup(list[root].key);merged.set(root,target);}
      target.rows.push(...g.rows);target.lat+=g.lat;target.lng+=g.lng;target.x+=g.x;target.y+=g.y;
      target.south=Math.min(target.south,g.south);target.north=Math.max(target.north,g.north);
      target.west=Math.min(target.west,g.west);target.east=Math.max(target.east,g.east);
    }
    return [...merged.values()];
  }
  function clusterRow(group, mode, band) {
    if(group.rows.length===1)return group.rows[0];
    const vehicles=[...new Set(group.rows.map(row=>vehicle(row,mode)))].sort();
    const regions=[...new Set(group.rows.map(region))].sort();
    const v=vehicles.length===1?vehicles[0]:'',r=regions.length===1?regions[0]:'';
    const sameLocation=group.south===group.north&&group.west===group.east;
    const regional=Boolean(r)&&(band===4||!v);
    const label=sameLocation?'같은 위치':regional?r:v?`${v}호`:'여러 호차';
    const memberCodes=group.rows.map(row=>String(row.customerCode||''));
    return {
      // A group has no customer identity. Keep original members for the
      // drill-down list, including different stores in the very same building.
      customerCode:'',customerName:label,vehicle:regional?'':v,
      lat:group.lat/group.rows.length,lng:group.lng/group.rows.length,
      clusterKey:group.key,clusterCount:group.rows.length,clusterLabel:label,
      clusterKind:sameLocation?'location':regional?'region':v?'vehicle':'mixed',
      clusterColorKey:regional?r:v||r,addressRegion:r,
      clusterRows:group.rows,memberCodes,clusterVehicles:vehicles.filter(Boolean),vehicles:vehicles.filter(Boolean),
      clusterRegions:regions.filter(Boolean),regions:regions.filter(Boolean),
      clusterMemberKey:JSON.stringify(group.rows.map(row=>[String(row.customerCode||''),row.lat,row.lng,vehicle(row,mode),region(row)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))),
      clusterBounds:{south:group.south,north:group.north,west:group.west,east:group.east}
    };
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
    const cachePrefix=options.sourceVersion===undefined?null:JSON.stringify([options.sourceVersion,mode,band,[...protectedCodes].sort()]);
    // Cache geographic levels, never the viewport's chosen level. Reusing a
    // nationwide result at close zoom would keep distant stores over-grouped.
    const atLevel=(key,build)=>{
      const cacheKey=cachePrefix&&cachePrefix+':'+key;
      const saved=cacheKey&&groupingCache.get(rows)?.get(cacheKey);if(saved)return saved;
      const result=build();
      if(cacheKey){let entries=groupingCache.get(rows);if(!entries){entries=new Map();groupingCache.set(rows,entries);}while(entries.size>=12)entries.delete(entries.keys().next().value);entries.set(cacheKey,result);}
      return result;
    };
    const available=Math.max(1,limit-pinned.length);
    const ordinaryCount=result=>result.reduce((count,row)=>count+(!protectedCodes.has(row.customerCode)&&visible(row)?1:0),0);
    // Close-up maps still need a selectable group for colocated stores. Two
    // independent markers at identical coordinates would hide one another;
    // distant stores must not force distinct visible addresses to merge.
    if (band === 0) {
      const close=atLevel('location',()=>{
        const places=new Map();
        for(const row of ordinary){const key=`${mode}:location:${row.lat}:${row.lng}`;let group=places.get(key);if(!group){group=makeGroup(key);places.set(key,group);}addRow(group,row);}
        return [...pinned,...[...places.values()].map(group=>clusterRow(group,mode,band))];
      });
      if(ordinaryCount(close)<=available)return close.filter(visible);
    }
    const baseCell = [80, 700, 3500, 18000, 120000][band];
    let result=[];
    // Bucket in world metres, not screen pixels: pan and small zoom changes do
    // not move a group's anchor or alter membership at the same level.
    // The marker limit belongs to the viewport, not all nationwide stores.
    for (let pass = 0; pass < 26; pass++) {
      result=atLevel(pass,()=>{
        const buckets = new Map(),cell = baseCell * (2 ** pass);
        for (const row of ordinary) {
          const point=world(row);
          // Geography owns the group. Splitting each cell by vehicle produced
          // dozens of overlapping coloured badges in dense metropolitan areas.
          const key=`${mode}:${band}:${pass}:${Math.floor(point.x/cell)}:${Math.floor(point.y/cell)}`;
          let group=buckets.get(key);if(!group){group=makeGroup(key);buckets.set(key,group);}addRow(group,row);
        }
        return [...pinned,...mergeNearby(buckets,cell).map(group=>clusterRow(group,mode,band))];
      });
      if (ordinaryCount(result) <= available) break;
    }
    return result.filter(visible);
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
