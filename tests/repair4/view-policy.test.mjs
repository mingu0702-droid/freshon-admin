import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/map-view-policy.js';

const {stableClusters}=globalThis.MapViewPolicy;
const point=(customerCode,lat=37.5,lng=127,vehicle='101')=>({customerCode,lat,lng,vehicle,baseVehicle:vehicle,addressRegion:'수도권'});
const project=row=>({x:(row.lng-126.5)*1000,y:(38-row.lat)*1000});
const members=output=>output.flatMap(row=>row.clusterRows||[row]);
const codes=rows=>rows.map(row=>row.customerCode).sort();

test('two stores in one building remain individually discoverable at close zoom',()=>{
  const a=point('S1'),b=point('S2');
  for(const level of [1,3,4,7,10,13]){
    const output=stableClusters([a,b],project,level);
    assert.equal(output.length,1);
    assert.equal(output[0].clusterKind,'location');
    assert.equal(output[0].clusterCount,2);
    assert.deepEqual(output[0].memberCodes,['S1','S2']);
    assert.equal(output[0].clusterRows[0],a);
    assert.equal(output[0].clusterRows[1],b);
    assert.equal(output[0].customerCode,'');
  }
});

test('close-up grouping does not merge two distinct neighbouring addresses unnecessarily',()=>{
  const a=point('S1'),b=point('S2',37.5002,127.0002);
  assert.deepEqual(stableClusters([a,b],project,2),[a,b]);
});

test('a dense group of different vehicles uses geographic clusters instead of overlapping vehicle badges',()=>{
  const rows=Array.from({length:120},(_,i)=>point('S'+i,37.52+(i%10)*.0002,127.03+Math.floor(i/10)*.0002,String(100+i)));
  const output=stableClusters(rows,project,10,'',null,{mode:'BASE_60D',maxMarkers:180});
  assert(output.length<=4,`dense output has ${output.length} markers`);
  assert.deepEqual(codes(members(output)),codes(rows));
  assert.equal(new Set(output.flatMap(row=>row.clusterVehicles||[row.vehicle])).size,120);
  for(const group of output.filter(row=>row.clusterCount))assert(!group.vehicle,'mixed-vehicle groups must not claim one vehicle');
});

test('dense groups on a geographic cell boundary are coalesced',()=>{
  const earth=6378137,cell=18000,edge=Math.floor(earth*127*Math.PI/180/cell)*cell;
  const lng=edge/earth*180/Math.PI;
  const rows=[point('S1',37.5,lng-.000001),point('S2',37.5,lng+.000001)];
  const output=stableClusters(rows,project,9);
  assert.equal(output.length,1);
  assert.deepEqual(codes(members(output)),['S1','S2']);
});

test('selection and navigation points remain individual while every other row is retained exactly once',()=>{
  const rows=Array.from({length:1000},(_,i)=>point('S'+i,37.5+(i%20)*.002,127+Math.floor(i/20)*.002,String(100+i%100)));
  const protectedCodes=['S2','S9','S77'];
  const output=stableClusters(rows,project,10,'S0',null,{protectedCodes,maxMarkers:120});
  assert(output.length<=120);
  for(const code of ['S0',...protectedCodes])assert(output.some(row=>row.customerCode===code&&!row.clusterCount));
  const restored=members(output);
  assert.equal(restored.length,rows.length);
  assert.deepEqual(codes(restored),codes(rows));
  for(const row of restored)assert(rows.includes(row),'member rows must be the original objects');
});

test('protected points may exceed the visual budget without being dropped',()=>{
  const rows=Array.from({length:65},(_,i)=>point('S'+i,37.5+i*.01,127));
  const protectedCodes=rows.slice(0,60).map(row=>row.customerCode);
  const output=stableClusters(rows,project,12,'',null,{maxMarkers:40,protectedCodes});
  assert.equal(output.filter(row=>row.customerCode).length,60);
  assert.equal(output.length,61);
  assert.deepEqual(codes(members(output)),codes(rows));
});

test('ordinary marker budget also holds for globally dispersed valid coordinates',()=>{
  const rows=Array.from({length:1000},(_,i)=>point('S'+i,-80+(i%25)*6.4,-175+Math.floor(i/25)*8.8));
  for(const level of [1,5,9,13]){
    const output=stableClusters(rows,project,level,'',null,{maxMarkers:40});
    assert(output.length<=40);
    assert.deepEqual(codes(members(output)),codes(rows));
  }
});

test('geographic membership and member fingerprint survive pan and input ordering changes',()=>{
  const rows=Array.from({length:80},(_,i)=>point('S'+i,37.5+(i%10)*.02,127+Math.floor(i/10)*.02));
  const a=stableClusters(rows,project,9),b=stableClusters([...rows].reverse(),r=>({x:project(r).x+600,y:project(r).y-200}),10);
  const identity=output=>output.map(row=>[row.clusterKey,row.clusterMemberKey]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(identity(a),identity(b));
});

test('member fingerprint changes when same-size clusters receive different stores or coordinates',()=>{
  const rows=[point('S1'),point('S2')];
  const a=stableClusters(rows,project,10)[0];
  const b=stableClusters([rows[0],point('S3')],project,10)[0];
  const c=stableClusters([rows[0],point('S2',37.5001,127)],project,10)[0];
  assert.equal(a.clusterCount,b.clusterCount);
  assert.notEqual(a.clusterMemberKey,b.clusterMemberKey);
  assert.notEqual(a.clusterMemberKey,c.clusterMemberKey);
  assert.notEqual(a.lat,c.lat);
});

test('duplicate customer rows are preserved as source rows and remain represented in counts',()=>{
  const a=point('S1'),b={...a,vehicle:'102',baseVehicle:'102',visitId:'second'};
  const output=stableClusters([a,b],project,12);
  assert.equal(output[0].clusterCount,2);
  assert.deepEqual(output[0].memberCodes,['S1','S1']);
  assert.deepEqual(output[0].clusterVehicles,['101','102']);
  assert.deepEqual(members(output),[a,b]);
});

test('invalid, absent and numeric-string coordinates never generate map points',()=>{
  const valid=point('S1');
  const rows=[valid,point('S2',null,127),point('S3','37.5',127),point('S4',91,127),point('S5',37.5,181),point('S6',NaN,127),point('S7',Infinity,127)];
  assert.deepEqual(stableClusters(rows,project,10),[valid]);
});

test('explicit source revision refreshes cached group data and viewport never relocates group anchors',()=>{
  const rows=[point('S1'),point('S2')];
  const a=stableClusters(rows,project,9,'',null,{sourceVersion:1});
  const cached=stableClusters(rows,project,9,'',{width:2000,height:2000},{sourceVersion:1});
  assert.equal(cached[0],a[0]);
  rows[1]={...rows[1],lat:37.501};
  const b=stableClusters(rows,project,9,'',null,{sourceVersion:2});
  assert.notEqual(b[0].clusterMemberKey,a[0].clusterMemberKey);
  assert.notEqual(b[0].lat,a[0].lat);
});

test('close zoom uses the viewport budget instead of cached nationwide density',()=>{
  const a=point('LOCAL1'),b=point('LOCAL2',37.5002,127.0002);
  const distant=Array.from({length:900},(_,i)=>point('FAR'+i,33+(i%30)*.09,125+Math.floor(i/30)*.18));
  const rows=[a,b,...distant],options={mode:'BASE_60D',maxMarkers:40,sourceVersion:'national-v1'};
  const closeProject=row=>({x:100+(row.lng-127)*100000,y:100+(37.5-row.lat)*100000});
  const nationwide=stableClusters(rows,closeProject,2,'',null,options);
  assert(nationwide.length<=40);
  assert.deepEqual(codes(members(nationwide)),codes(rows));
  const local=stableClusters(rows,closeProject,2,'',{width:240,height:200},options);
  assert.deepEqual(local,[a,b],'offscreen stores must not merge the two visible addresses');
  const wholeAgain=stableClusters(rows,closeProject,2,'',null,options);
  assert(wholeAgain.length<=40);
  assert.deepEqual(codes(members(wholeAgain)),codes(rows),'viewport queries must not replace the full-data cache');
});

test('panning from a dense viewport to a sparse one reuses geometry without retaining the dense grouping level',()=>{
  const dense=Array.from({length:81},(_,i)=>point('DENSE'+i,37.5+Math.floor(i/9)*.001,127+(i%9)*.001));
  const sparse=[point('SPARSE1',37.5,127.4),point('SPARSE2',37.5,127.4),point('SPARSE3',37.5002,127.4002)];
  const rows=[...dense,...sparse],options={mode:'DATE_ROUTE',maxMarkers:40,sourceVersion:'pan-v1'},viewport={width:460,height:460};
  const denseProject=row=>({x:(row.lng-127)*50000,y:(row.lat-37.5)*50000});
  const first=stableClusters(rows,denseProject,2,'',viewport,options);
  assert(first.length<=40);
  assert.deepEqual(codes(members(first)),codes(dense));
  const second=stableClusters(rows,row=>({x:denseProject(row).x-20000,y:denseProject(row).y}),2,'',viewport,options);
  assert.equal(second.length,2);
  assert.deepEqual(codes(members(second)),codes(sparse));
  const sameBuilding=second.find(row=>row.clusterCount);
  assert.deepEqual(sameBuilding.memberCodes,['SPARSE1','SPARSE2']);
  const smallPan=stableClusters(rows,row=>({x:denseProject(row).x+5,y:denseProject(row).y+3}),3,'',viewport,options);
  assert.equal(smallPan.length,first.length);
  for(let i=0;i<first.length;i++)assert.equal(smallPan[i],first[i],'small pans reuse the same geographic anchor and membership objects');
});

test('viewport resizing rechecks the bound while selection and route pins remain visible outside it',()=>{
  const ordinary=Array.from({length:160},(_,i)=>point('GRID'+i,37.5+Math.floor(i/16)*.002,127+(i%16)*.002));
  const selected=point('SELECTED',36,128),route=point('ROUTE',35,129);
  const rows=[...ordinary,selected,route],options={mode:'DATE_ROUTE',maxMarkers:40,protectedCodes:['ROUTE'],sourceVersion:'resize-v1'};
  const gridProject=row=>({x:(row.lng-127)*25000,y:(row.lat-37.5)*25000});
  for(const width of [140,1000,140]){
    const output=stableClusters(rows,gridProject,3,'SELECTED',{width,height:540},options);
    assert(output.length<=40,`viewport ${width}px returned ${output.length} markers`);
    assert(output.includes(selected));assert(output.includes(route));
    assert.equal(members(output).filter(row=>row===selected).length,1);
    assert.equal(members(output).filter(row=>row===route).length,1);
    if(width===1000)assert.deepEqual(codes(members(output)),codes(rows));
  }
});
