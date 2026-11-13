/* Deterministic geographic grouping and camera ownership. No source/network IO. */
(function (root) {
  'use strict';
  const EARTH = 6378137;
  const storePinLevel = 5;
  const vehicleOverlapPixels = 40;
  const vehicleOverlapKm = 0.5;
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
  const unverified = Object.freeze({code:'',label:'•',kind:'unverified'});
  const pending = Object.freeze({code:'',label:'',kind:'unverified',loading:true});
  const unknown = Object.freeze({code:'',label:'?',kind:'unknown'});
  const datedUnknown = Object.freeze({code:'',label:'•',kind:'unverified'});
  const absence = /^(?:|[-?]|미확인|호차미확인|미지정|없음)$/;
  function pinAssignment(row, mode='BASE_60D') {
    if (row.clusterAssignment) return row.clusterAssignment;
    const dated=mode==='DATE_ROUTE';
    if(!dated&&row.baseVehicleState==='CONFLICT')return unverified;
    const raw=dated?row.vehicle||row.actualVehicle:row.baseVehicle??(row.baseVehicleState?'':row.vehicle);
    const value=String(raw??'').normalize('NFKC').trim(), compact=value.replace(/\s+/g,'');
    if(/^(?:오산|영남|호남|이천)신규$/.test(compact))return {code:compact,label:compact,kind:'new'};
    if(compact==='보류'||compact==='오산보류')return {code:'오산보류',label:'오산보류',kind:'held'};
    const number=compact.match(/^(\d+)(?:호(?:차)?)?$/)?.[1];
    if(number)return {code:number,label:number,kind:'vehicle'};
    if(!absence.test(compact)&&/^[\p{L}\p{N}_-]{1,64}$/u.test(compact))return {code:value,label:value,kind:'other'};
    if(dated)return datedUnknown;
    if(row.baseVehicleState==='UNASSIGNED'&&row.baseVehicleEmptyVerified===true&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY')return unknown;
    return (!row.baseVehicleState||row.baseVehicleState==='UNKNOWN')&&!row.baseVehicleVersion?pending:unverified;
  }
  function makeGroup(key, route = '') {
    return {key, route, rows:[], lat:0, lng:0, x:0, y:0, south:Infinity, north:-Infinity, west:Infinity, east:-Infinity};
  }
  function addRow(group, row, point) {
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
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const j of bins.get(`${g.route}:${bx+dx}:${by+dy}`)||[]){
        const other=list[j],ox=other.x/other.rows.length,oy=other.y/other.rows.length;
        if((x-ox)**2+(y-oy)**2<(cell*.65)**2){const a=find(i),b=find(j);parents[Math.max(a,b)]=Math.min(a,b);}
      }
      const key=`${g.route}:${bx}:${by}`;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(i);
    }
    const merged=new Map();
    for(let i=0;i<list.length;i++){
      const root=find(i),g=list[i];let target=merged.get(root);
      if(!target){target=makeGroup(list[root].key,g.route);merged.set(root,target);}
      target.rows.push(...g.rows);target.lat+=g.lat;target.lng+=g.lng;target.x+=g.x;target.y+=g.y;
      target.south=Math.min(target.south,g.south);target.north=Math.max(target.north,g.north);
      target.west=Math.min(target.west,g.west);target.east=Math.max(target.east,g.east);
    }
    return [...merged.values()];
  }
  function clusterRow(group, mode, band) {
    if(group.rows.length===1)return group.rows[0];
    const members=group.rows.map(row=>pinAssignment(row,mode));
    const vehicles=[...new Set(members.map(assignment=>assignment.code).filter(Boolean))].sort();
    const unassigned=members.some(assignment=>assignment.kind==='unknown');
    const unmatched=members.some(assignment=>assignment.kind==='unverified');
    const first=members[0];
    const assignment=members.every(item=>item.code===first.code&&item.label===first.label)?first:
      vehicles.length?{code:'',label:vehicles.join('·'),kind:'mixed'}:unverified;
    const regions=[...new Set(group.rows.map(region))].sort();
    const v=assignment.code,r=regions.length===1?regions[0]:'';
    const sameLocation=group.south===group.north&&group.west===group.east;
    const regional=Boolean(r)&&(band===4||!v);
    const label=sameLocation?'같은 위치':assignment.kind==='vehicle'?`${v}호`:
      v?assignment.label:r||'권역';
    const memberCodes=group.rows.map(row=>String(row.customerCode||''));
    return {
      // A group has no customer identity. Keep original members for the
      // drill-down list, including different stores in the very same building.
      customerCode:'',customerName:label,vehicle:regional?'':v,
      lat:sameLocation?group.south:group.lat/group.rows.length,lng:sameLocation?group.west:group.lng/group.rows.length,
      clusterKey:group.key,clusterCount:group.rows.length,clusterLabel:label,
      clusterKind:sameLocation?'location':v?'vehicle':vehicles.length?'mixed':'unassigned',
      clusterColorKey:regional?r:v||r,addressRegion:r,
      clusterRows:group.rows,memberCodes,clusterVehicles:vehicles,vehicles,clusterUnassigned:unassigned,clusterUnverified:unmatched,clusterAssignment:assignment,
      clusterRegions:regions.filter(Boolean),regions:regions.filter(Boolean),
      clusterMemberKey:group.rows.map((row,i)=>JSON.stringify([row.customerCode,row.lat,row.lng,members[i].code,members[i].kind,region(row)])).sort().join('\n'),
      clusterBounds:{south:group.south,north:group.north,west:group.west,east:group.east}
    };
  }
  function exactLocations(rows,mode='BASE_60D') {
    const places=new Map();
    for(const row of rows){
      if(!finitePoint(row))continue;
      const key=`${mode}:same-location:${row.lat}:${row.lng}`, old=places.get(key);
      if(!old)places.set(key,row);
      else if(Array.isArray(old))old.push(row);
      else places.set(key,[old,row]);
    }
    return [...places].map(([key,rows])=>{
      if(!Array.isArray(rows))return rows;
      const [{lat,lng}]=rows;
      return clusterRow({key,rows,south:lat,north:lat,west:lng,east:lng},mode,0);
    });
  }
  function overlappingVehicleLocations(locations, project, mode='BASE_60D', protectedCodes=[]) {
    const distanceKm=root.Phase2bUi?.distanceKm;
    if(typeof distanceKm!=='function')return locations;
    const protectedSet=new Set(protectedCodes.filter(Boolean));
    const actualRoute=code=>/^(?:(?:용|척|척척)?\d+)$/.test(code);
    const limitSquared=vehicleOverlapPixels**2;
    const buckets=new Map(), groups=[], unchanged=[];
    const ordered=[...locations].sort((a,b)=>a.lat-b.lat||a.lng-b.lng);
    for(const row of ordered){
      const vehicles=row.clusterVehicles||[pinAssignment(row,mode).code];
      const areaGroup=row.clusterCount&&row.clusterKind!=='location';
      const protectedLocation=protectedSet.has(row.customerCode)||row.memberCodes?.some(code=>protectedSet.has(code));
      if(areaGroup||protectedLocation||!vehicles.length||!vehicles.every(actualRoute)){
        unchanged.push(row);continue;
      }
      const {x,y}=project(row)||{};
      if(!Number.isFinite(x)||!Number.isFinite(y)){unchanged.push(row);continue;}
      const bx=Math.floor(x/vehicleOverlapPixels),by=Math.floor(y/vehicleOverlapPixels);
      const screenDistance=point=>(point.x-x)**2+(point.y-y)**2;
      let match=null, nearest=Infinity;
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
        for(const group of buckets.get(`${bx+dx}:${by+dy}`)||[]){
          if(group.vehicles.size===1&&vehicles.every(code=>group.vehicles.has(code)))continue;
          const distance=screenDistance(group.points[0]);
          if(distance>limitSquared||distance>nearest||(distance===nearest&&group.index>match.index))continue;
          // Every pair must fit. A third pin cannot chain two distant locations together.
          if(!group.points.every(point=>screenDistance(point)<=limitSquared&&distanceKm(point.row,row)<=vehicleOverlapKm+1e-9))continue;
          match=group;nearest=distance;
        }
      }
      const point={row,x,y};
      if(match){
        match.points.push(point);
        vehicles.forEach(code=>match.vehicles.add(code));
      }else{
        const group={points:[point],vehicles:new Set(vehicles),index:groups.length}, key=`${bx}:${by}`;
        groups.push(group);
        if(!buckets.has(key))buckets.set(key,[]);
        buckets.get(key).push(group);
      }
    }
    return [...unchanged,...groups.map(({points})=>{
      const first=points[0].row;
      if(points.length===1)return first;
      const group=makeGroup(`${mode}:nearby:${first.lat}:${first.lng}`);
      for(const {row} of points)for(const member of row.clusterRows||[row])addRow(group,member,{x:0,y:0});
      return clusterRow(group,mode,0);
    })];
  }
  function visibleVehicleRepresentatives(rows, project, viewport, visibleStores) {
    if(!viewport)return rows;
    const {width,height}=viewport, inside=({x,y},margin)=>
      x>=-margin&&x<=width+margin&&y>=-margin&&y<=height+margin;
    return rows.flatMap(row=>{
      const center=project(row);
      if(inside(center,0))return [row];
      let anchor=null, nearest=Infinity;
      for(const store of visibleStores?.get(row.vehicle)||[]){
        const point=project(store);
        if(!inside(point,0))continue;
        const distance=(point.x-width/2)**2+(point.y-height/2)**2;
        if(distance<nearest){anchor=store;nearest=distance;}
      }
      if(!anchor)return inside(center,36)?[row]:[];
      return [{...row,lat:anchor.lat,lng:anchor.lng}];
    });
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
    const margin=options.margin??80;
    const visible = row => {
      if (!viewport || protectedCodes.has(row.customerCode) || row.memberCodes?.some(code=>protectedCodes.has(code))) return true;
      const p = project(row);
      return Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= -margin && p.y >= -margin && p.x <= viewport.width + margin && p.y <= viewport.height + margin;
    };
    const nearbyOnly=options.nearbyVehicleOnly===true;
    const cachePrefix=options.sourceVersion===undefined?null:JSON.stringify([options.sourceVersion,mode,band,nearbyOnly,[...protectedCodes].sort()]);
    // Cache geographic levels, never the viewport's chosen level. Reusing a
    // nationwide result at close zoom would keep distant stores over-grouped.
    const atLevel=(key,build)=>{
      const cacheKey=cachePrefix&&cachePrefix+':'+key;
      const saved=cacheKey&&groupingCache.get(rows)?.get(cacheKey);if(saved)return saved;
      const result=build();
      if(cacheKey){let entries=groupingCache.get(rows);if(!entries){entries=new Map();groupingCache.set(rows,entries);}while(entries.size>=12)entries.delete(entries.keys().next().value);entries.set(cacheKey,result);}
      return result;
    };
    // A focused vehicle/dated-driver view is a stop map, not a territory
    // overview. Preserve every distinct positioned stop, irrespective of the
    // generic overview marker cap. Only truly co-located stores share a
    // selectable same-location card so none becomes inaccessible.
    if(options.grouping==='locations')return atLevel('exact',()=>exactLocations(rows,mode)).filter(visible);
    if(options.grouping==='individual')return atLevel('individual',()=>[...pinned,...exactLocations(ordinary,mode)]).filter(visible);
    const mergeDisplayed=displayed=>nearbyOnly&&viewport&&level<=7
      ?overlappingVehicleLocations(displayed,project,mode,[...protectedCodes]):displayed;
    const available=Math.max(1,limit-pinned.length);
    // Close-up maps still need a selectable group for colocated stores. Two
    // independent markers at identical coordinates would hide one another;
    // distant stores must not force distinct visible addresses to merge.
    if (band === 0) {
      const close=atLevel('location',()=>[...pinned,...exactLocations(ordinary,mode)]).filter(visible);
      if(close.length-pinned.length<=available)return mergeDisplayed(close);
    }
    const {territory, routes}=atLevel('territory',()=>{
      const territory=ordinary.map(row=>({row,point:world(row),route:nearbyOnly?pinAssignment(row,mode).code:''}));
      return {territory,routes:new Set(territory.map(item=>item.route)).size};
    });
    const baseCell = [80, 700, 3500, 18000, 120000][band];
    let visibleRows=[];
    // Bucket in world metres, not screen pixels: pan and small zoom changes do
    // not move a group's anchor or alter membership at the same level.
    // The marker limit belongs to the viewport, not all nationwide stores.
    for (let pass = 0; pass < 26; pass++) {
      const grouped=atLevel(pass,()=>{
        const buckets = new Map(),cell = baseCell * (2 ** pass);
        for (const {row,point,route} of territory) {
          const key=`${mode}:${band}:${pass}:${route}:${Math.floor(point.x/cell)}:${Math.floor(point.y/cell)}`;
          let group=buckets.get(key);if(!group){group=makeGroup(key,route);buckets.set(key,group);}addRow(group,row,point);
        }
        return mergeNearby(buckets,cell).map(group=>clusterRow(group,mode,band));
      });
      visibleRows=[...pinned,...grouped].filter(visible);
      if(visibleRows.length-pinned.length<=available||nearbyOnly&&grouped.length===routes)break;
    }
    return mergeDisplayed(visibleRows);
  }
  const cameraRect = rect => {
    const left=Number(rect?.left),top=Number(rect?.top),right=Number(rect?.right??left+Number(rect?.width)),bottom=Number(rect?.bottom??top+Number(rect?.height));
    return [left,top,right,bottom].every(Number.isFinite)&&right>left&&bottom>top?{left,top,right,bottom,width:right-left,height:bottom-top}:null;
  };
  function cameraFocusViewport({mapRect,viewportRect,headerRect,occluders=[],mobile=false,anchorHeight=0,anchorWidth=0}={}) {
    const map=cameraRect(mapRect),viewport=cameraRect(viewportRect);if(!map||!viewport)return null;
    const header=cameraRect(headerRect),top=Math.max(map.top,viewport.top,header&&header.width>=viewport.width/2?header.bottom:viewport.top);
    let visible=cameraRect({left:Math.max(map.left,viewport.left),right:Math.min(map.right,viewport.right),top,bottom:Math.min(map.bottom,viewport.bottom)});if(!visible)return null;
    let blocks=occluders.map(cameraRect).filter(Boolean);
    if(mobile){
      const half=Math.min(visible.width/3,Math.max(0,Number(anchorWidth)||0)/2),height=Math.min(visible.height/2,Math.max(0,Number(anchorHeight)||0));
      visible=cameraRect({left:visible.left+half,right:visible.right-half,top:visible.top+height,bottom:visible.bottom});if(!visible)return null;
      blocks=blocks.map(r=>({...r,left:r.left-half,right:r.right+half,bottom:r.bottom+height}));
    }
    // The map's own centre can sit behind a floating detail card. Use the
    // largest genuinely visible rectangle, including full-height space beside
    // a card rather than the narrower strips produced by successive cuts.
    blocks=blocks.map(block=>cameraRect({left:Math.max(visible.left,block.left),right:Math.min(visible.right,block.right),top:Math.max(visible.top,block.top),bottom:Math.min(visible.bottom,block.bottom)})).filter(Boolean);
    const xs=[...new Set([visible.left,visible.right,...blocks.flatMap(block=>[block.left,block.right])])].sort((a,b)=>a-b);
    const ys=[...new Set([visible.top,visible.bottom,...blocks.flatMap(block=>[block.top,block.bottom])])].sort((a,b)=>a-b);
    let area=null;
    for(let l=0;l<xs.length-1;l++)for(let r=l+1;r<xs.length;r++)for(let t=0;t<ys.length-1;t++)for(let b=t+1;b<ys.length;b++){
      const candidate=cameraRect({left:xs[l],right:xs[r],top:ys[t],bottom:ys[b]});
      if(blocks.some(block=>candidate.left<block.right&&candidate.right>block.left&&candidate.top<block.bottom&&candidate.bottom>block.top))continue;
      const size=candidate.width*candidate.height,best=area?area.width*area.height:-1;
      if(size>best||size===best&&(candidate.top<area.top||candidate.top===area.top&&candidate.left<area.left))area=candidate;
    }
    return area?{...area,x:(area.left+area.right)/2,y:(area.top+area.bottom)/2,basis:'UNOBSCURED_MAP'}:null;
  }
  function cameraDomLayout(element,measurePin=true) {
    const doc=element?.ownerDocument,win=doc?.defaultView||root,visual=win.visualViewport;
    const viewportRect={left:visual?.offsetLeft||0,top:visual?.offsetTop||0,width:visual?.width||win.innerWidth,height:visual?.height||win.innerHeight};
    const rect=node=>node?.getClientRects?.().length&&!node.hidden&&win.getComputedStyle?.(node).visibility!=='hidden'?node.getBoundingClientRect():null;
    const pin=measurePin&&(rect(doc?.querySelector('#map .marker.selected'))||rect(doc?.querySelector('#map .marker')));
    return {mapRect:element?.getBoundingClientRect?.(),viewportRect,headerRect:rect(doc?.querySelector('#approvedSiteHeader')),
      occluders:[...(doc?.querySelectorAll('#leftPanel,#detailSection.open,#mapClusterPanel:not(.mapClusterPopup),#mobileWorkspace:not(.collapsed),#manualPinEditor:not([hidden]),#mapReset,.mobileMapControls')||[])].map(rect).filter(Boolean),
      anchorHeight:pin?.height||0,
      anchorWidth:pin?.width||0,
      mobile:win.matchMedia?.('(max-width: 760px)')?.matches??Number(viewportRect.width)<=760};
  }
  function lineLabelPoint(start,end,box) {
    let low=0,high=1;
    for(const [axis,min,max] of [['x',box.left,box.right],['y',box.top,box.bottom]]){
      const from=start[axis],delta=end[axis]-from;
      if(!delta){if(from<min||from>max)return null;continue;}
      const a=(min-from)/delta,b=(max-from)/delta;
      low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));
    }
    if(low>high)return null;
    const fraction=(low+high)/2;
    return {x:start.x+(end.x-start.x)*fraction,y:start.y+(end.y-start.y)*fraction};
  }
  function visibleLineLabelPoint(element,start,end) {
    const layout=cameraDomLayout(element,false), map=layout.mapRect;
    const area=cameraFocusViewport({...layout,mobile:false});
    if(!area)return null;
    const xInset=Math.min(42,area.width/4), yInset=Math.min(26,area.height/4);
    const sx=element.clientWidth/map.width,sy=element.clientHeight/map.height;
    return lineLabelPoint(start,end,{left:(area.left+xInset-map.left)*sx,right:(area.right-xInset-map.left)*sx,
      top:(area.top+yInset-map.top)*sy,bottom:(area.bottom-yInset-map.top)*sy});
  }
  function createCamera({map, element, clock=Date.now, raf=fn=>requestAnimationFrame(fn), cancelRaf=id=>cancelAnimationFrame(id),layout=measurePin=>cameraDomLayout(element,measurePin),pixel=(x,y)=>root.kakao?.maps?.Point?new root.kakao.maps.Point(x,y):{x,y}}={}) {
    let width=-1,height=-1, frame=null, focusFrame=null, disposed=false, interaction=0, movingUntil=0,active=null,sequence=0,lastFocus=null;
    const measure=()=>({w:Math.round(element?.clientWidth||0),h:Math.round(element?.clientHeight||0)});
    const validPoint=point=>Number.isFinite(point?.getLat?.()??point?.lat)&&Number.isFinite(point?.getLng?.()??point?.lng);
    let centerSize=measure(),lastKnownCenter=map.getCenter?.(),layingOut=false;
    const cameraEvents=root.kakao?.maps?.event;
    function rememberCenter(){
      const size=measure();if(disposed||layingOut||size.w<1||size.h<1||size.w!==centerSize.w||size.h!==centerSize.h)return;
      const center=map.getCenter?.();if(validPoint(center))lastKnownCenter=center;
    }
    if(typeof cameraEvents?.addListener==='function')cameraEvents.addListener(map,'center_changed',rememberCenter);
    function resizeMap(w,h){
      // After DOM resize, getCenter may already include the SDK's old pixel offset.
      const center=lastKnownCenter;layingOut=true;
      try{width=w;height=h;map.relayout?.();if(validPoint(center))map.setCenter?.(center);centerSize={w,h};}
      finally{layingOut=false;}
      rememberCenter();
    }
    function releaseFocus(){active=null;sequence++;if(focusFrame!==null)cancelRaf(focusFrame);focusFrame=null;}
    function userGesture(){interaction++;movingUntil=clock()+300;releaseFocus();}
    function report(value){lastFocus=value;if(element?.dataset){for(const [key,v]of Object.entries({focusState:value.state,focusExpectedX:value.expectedX,focusExpectedY:value.expectedY,focusActualX:value.actualX,focusActualY:value.actualY,focusErrorPx:value.errorPx,focusBasis:value.basis}))if(v!==undefined)element.dataset[key]=String(v);}}
    function capturePinOffset(point,body){
      const mapRect=cameraRect(element?.getBoundingClientRect?.()),pinRect=cameraRect(body?.getBoundingClientRect?.());
      const {w,h}=measure(),position=map.getProjection?.()?.containerPointFromCoords?.(point);
      if(!mapRect||!pinRect||w<1||h<1||!Number.isFinite(position?.x)||!Number.isFinite(position?.y))return {x:0,y:0};
      return {x:(pinRect.left+pinRect.width/2-mapRect.left)*w/mapRect.width-position.x,
        y:(pinRect.top+pinRect.height/2-mapRect.top)*h/mapRect.height-position.y};
    }
    function geometry(){
      const centerPin=Boolean(active?.pinOffset),raw=layout(!centerPin);
      const target=cameraFocusViewport(centerPin?{...raw,mobile:false}:raw);
      return target?{raw,target,key:JSON.stringify([raw.mapRect?.left,raw.mapRect?.top,raw.mapRect?.width,raw.mapRect?.height,target.x,target.y,target.basis])}:null;
    }
    function scheduleFocus(force=false){
      if(disposed||!active||active.interaction!==interaction||focusFrame!==null)return;
      const g=geometry();if(!g||!force&&g.key===active.geometry)return;
      const owner=active.id;focusFrame=raf(()=>{focusFrame=null;alignFocus(owner);});
    }
    function alignFocus(owner){
      if(disposed||!active||active.id!==owner||active.interaction!==interaction)return;
      const g=geometry(),size=measure(),projection=map.getProjection?.();if(!g||size.w<1||size.h<1||!projection)return;
      if(width!==size.w||height!==size.h)resizeMap(size.w,size.h);
      if(active.geometry!==g.key)active.corrections=0;active.geometry=g.key;
      const rect=cameraRect(g.raw.mapRect),sx=rect.width/size.w,sy=rect.height/size.h;
      const position=projection.containerPointFromCoords(active.point);if(!Number.isFinite(position?.x)||!Number.isFinite(position?.y))return;
      const offset=active.pinOffset||{x:0,y:0};
      const actual={x:position.x+offset.x,y:position.y+offset.y};
      const wanted={x:(g.target.x-rect.left)/sx,y:(g.target.y-rect.top)/sy};
      const error=Math.hypot((actual.x-wanted.x)*sx,(actual.y-wanted.y)*sy);
      if(error>.5&&active.corrections<3){
        const next=projection.coordsFromContainerPoint(pixel(size.w/2+actual.x-wanted.x,size.h/2+actual.y-wanted.y));
        active.corrections++;map.setCenter(next);rememberCenter();
        report({state:'adjusting',expectedX:g.target.x,expectedY:g.target.y,actualX:rect.left+actual.x*sx,actualY:rect.top+actual.y*sy,errorPx:error,basis:g.target.basis});
        scheduleFocus(true);return;
      }
      report({state:error<=(active.pinOffset?1.5:30)?'centered':'deviation',expectedX:g.target.x,expectedY:g.target.y,actualX:rect.left+actual.x*sx,actualY:rect.top+actual.y*sy,errorPx:Math.round(error*100)/100,basis:g.target.basis});
    }
    function focus(point,{key='',reason='selection',pinOffset}={}){
      if(disposed||!validPoint(point))return false;
      releaseFocus();active={point,key,reason,pinOffset,id:++sequence,interaction,geometry:null,corrections:0};report({state:'pending'});scheduleFocus(true);return true;
    }
    function relayout(){
      if(disposed)return;
      const {w,h}=measure(); if(w<1||h<1)return;
      if(w===width&&h===height){rememberCenter();scheduleFocus();return;}
      if(clock()<movingUntil){if(frame===null)frame=raf(()=>{frame=null;relayout();});return;}
      resizeMap(w,h);
      if(active){active.corrections=0;scheduleFocus(true);}
    }
    function scheduleRelayout(){if(frame===null&&!disposed)frame=raf(()=>{frame=null;relayout();});}
    return { userGesture, interaction:()=>interaction, scheduleRelayout, relayout,focus,scheduleFocus,releaseFocus,capturePinOffset,
      focusState:()=>lastFocus,
      dispose(){disposed=true;releaseFocus();if(frame!==null)cancelRaf(frame);frame=null;cameraEvents?.removeListener?.(map,'center_changed',rememberCenter);},
      dimensions:()=>({width,height}) };
  }
  root.MapViewPolicy=Object.freeze({stableClusters,exactLocations,overlappingVehicleLocations,visibleVehicleRepresentatives,pinAssignment,storePinLevel,zoomBand,createCamera,regionColors,cameraFocusViewport,visibleLineLabelPoint,lineLabelPoint});
})(typeof window==='object'?window:globalThis);
