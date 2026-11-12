import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {datedCompletionEvent} from '../src/opsmapDailyServer.js';
const first='2026-11-09',second='2026-11-10',slow='2026-11-08';
const mapStub=`
(() => {
 const data={lines:[],overlays:[]}; window.fixtureMap=data;
 class LatLng {constructor(lat,lng){this.lat=lat;this.lng=lng;}getLat(){return this.lat;}getLng(){return this.lng;}}
 class LatLngBounds {extend(){} getSouthWest(){return new LatLng(33,124);}getNorthEast(){return new LatLng(39,132);}}
 class Map {constructor(){this.level=7;this.center=new LatLng(37,127);}getLevel(){return this.level;}setLevel(v){this.level=v;}getCenter(){return this.center;}setCenter(v){this.center=v;}panTo(v){this.center=v;}getBounds(){return new LatLngBounds();}setBounds(){}relayout(){}getProjection(){return {containerPointFromCoords:p=>({x:80+(p.lng-127)*1000,y:100+(p.lat-37)*1000}),coordsFromContainerPoint:p=>new LatLng(37+(p.y-100)/1000,127+(p.x-80)/1000)};}}
 class CustomOverlay {constructor(o){this.o=o;data.overlays.push(this);this.setMap(o.map);}setMap(map){this.map=map;if(this.o.content instanceof Node){if(map)document.querySelector('#map').append(this.o.content);else this.o.content.remove();}}}
 class Polyline {constructor(o){this.o=o;data.lines.push(this);this.setMap(o.map);}setMap(map){this.map=map;}}
 class InfoWindow {setContent(html){data.info=html;}setPosition(){}open(){}close(){}}
 window.kakao={maps:{Map,LatLng,LatLngBounds,CustomOverlay,Polyline,InfoWindow,event:{addListener:(o,k,f)=>{o[k]=f;},removeListener(){}}}};
 window.KakaoMapsAdapter={ready:()=>Promise.resolve(),geocoder:()=>null};
 window.VEHICLE_AREA_DATA={vehicles:['101','105','122','202','999'].map(vehicle=>({vehicle,group:'osan',customers:[]}))};
})();
`;
const rows=(date,v,count)=>Array.from({length:count},(_,i)=>{
  const type=i===1?'DIRECT_HANDOFF':'DELIVERY_COMPLETED',hour=i===1?'08':i===0?'17':'09';
  const status=i<(v==='105'?4:3)?'COMPLETED':'PENDING';
  const proof=status==='COMPLETED'&&datedCompletionEvent({id:v+i,status,completionEvent:{type,source:i===2?'SYSTEM':'DRIVER_APP',at:date+'T'+hour+':00:00+09:00'}});
  return {customerCode:'S'+v+String(i).padStart(3,'0'),customerName:'Fixture '+v+' / '+i,vehicle:v,confirmedVehicle:v,
    deliveryDate:date,address:'Fixture address',lat:37+i/400,lng:127+(Number(v)%5)/1000,
    sequence:i+1,status,actualDeliveryEvent:v==='105'?null:proof||null};
});
const payload=date=>{
  const data=[...rows(date,'101',22),...rows(date,'105',date===second?6:5),...rows(date,'122',17),...rows(date,'202',22)];
  return {ok:true,data,meta:{date,complete:true,rowCount:data.length,source:'synthetic',completionEvidence:'DELIVERY_STATUS_RECORD_V1',generatedAt:date+'T12:00:00Z'}};
};
test('Chromium desktop and mobile: one assignment result for the list, pins, filters and actual route', {timeout:45000}, async t=>{
  const html=(await readFile(new URL('../public/opsmap/map-phase2b-preview.html',import.meta.url),'utf8'))
    .replace(/<script[^>]+src="(?:https:\/\/cdn[^"]+|map-staff-entry\.js[^"]+)"[^>]*><\/script>/g,'')
    .replace(/<script type="application\/x-map-staff" data-src="([^"]+)"[^>]*><\/script>/g,'<script src="$1"></script>')
    .replace(/<script[^>]*type="module"[^>]*>[\s\S]*?<\/script>/g,'');
  const host=express(),app=express.Router();host.use("/opsmap",app);let outage=0,requests=[],opsCalls=0,latestError=false;
  app.get('/',(_q,r)=>r.type('html').send(html));
  app.get('/kakao-maps-adapter.js',(_q,r)=>r.type('js').send(mapStub));
  const snapshotRequests=[];
  app.get('/api/map-phase2b/preview/snapshot',(_q,r)=>{
    snapshotRequests.push(Date.now());
    if(snapshotRequests.length===1)return r.set('Retry-After','1').status(503).json({error:'PHASE2B_SNAPSHOT_RESTORING'});
    const data=rows(first,'101',5).map(row=>({...row,dispatchCenterCode:'011'}));
    return r.json({ok:true,data,meta:{latestDate:first,startDate:first,sourceGeneration:'a'.repeat(64)}});
  });
  app.get('/api/map-phase2b/preview/assignments',async(q,r)=>{
    const date=q.query.date;requests.push(date);
    if(date===slow)await new Promise(resolve=>setTimeout(resolve,400));
    if(date==='latest'&&latestError)return r.status(503).json({error:'DATED_SOURCE_HTTP_503'});
    if(date===first&&outage===409)return r.json({...payload(date),meta:{...payload(date).meta,hasMore:true}});
    if(date===first&&outage)return r.status(outage).json({error:'DATED_SOURCE_HTTP_'+outage});
    return r.json(payload(date==='latest'?first:date));
  });
  app.get(['/api/map-phase2b/preview/today-status','/api/map-phase2b/preview/route-plan'],(_q,r)=>{opsCalls++;r.json({ok:true,data:{stops:[]}});});
  app.get('/api/map-phase2b/preview/daily-completions',async(q,r)=>{
    const {date,vehicle,observedAt}=q.query;
    if(vehicle!=='105')return r.json({ok:true,data:{date,vehicle,observedAt,complete:true,events:[]}});
    await new Promise(resolve=>setTimeout(resolve,25));
    const events=[[0,'17'],[1,'08'],[3,'09']].map(([i,h])=>({customerCode:'S10500'+i,event:datedCompletionEvent({id:'105'+i,status:'COMPLETED',
      completionEvent:{source:'DRIVER_APP',type:i?'DIRECT_HANDOFF':'DELIVERY_COMPLETED',at:date+'T'+h+':00:00+09:00'}})}));
    return r.json({ok:true,data:{date,vehicle,observedAt,complete:true,events}});
  });
  app.get('/api/*',(_q,r)=>r.status(404).json({error:'FIXTURE_NOT_CONFIGURED'}));
  app.use(express.static(new URL('../public/opsmap/',import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/i,'')));
  const server=host.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  let browser;
  const base='http://127.0.0.1:'+server.address().port+'/opsmap/';
  try {
    browser=await chromium.launch({channel:'chrome',headless:true});
    for(const width of [1440,390])await t.test(width+'px',async()=>{
      outage=0;requests=[];latestError=false;
      const page=await browser.newPage({viewport:{width,height:width===390?844:900}});
      snapshotRequests.length=0;
      await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{document.body.dataset.mapStaffState='authenticated';}));
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(base);
      await page.waitForFunction(()=>window.MapUiLocalBridge?.state.map,{},{timeout:4500}).catch(e=>{throw Error(e.message+' errors='+JSON.stringify(errors));});
      await page.waitForFunction(()=>JSON.parse(document.querySelector('#map').dataset.bootMetrics||'{}').active>0,{},{timeout:6000});
      assert.equal(snapshotRequests.length,2);
      assert.ok(snapshotRequests[1]-snapshotRequests[0]>=950);
      await page.evaluate(()=>document.querySelector('#modeDaily').click());
      await page.waitForFunction(()=>MapUiLocalBridge.state.selectedDate==='2026-11-09'&&MapUiLocalBridge.isDataReady());
      const vehicle=async v=>page.evaluate(v=>{const n=document.querySelector('#operationVehicle');n.value=v;n.dispatchEvent(new Event('change'));},v);
      const selectedDate=date=>page.evaluate(date=>{const n=document.querySelector('#date');n.value=date;n.dispatchEvent(new Event('change'));},date);
      const summary=()=>page.evaluate(()=>({
        list:[...document.querySelectorAll('[data-run-code]')].map(n=>n.dataset.runCode),
        pin:[...document.querySelectorAll('#map .marker')].map(n=>n.dataset.customerCode).filter(Boolean),
        located:Number(document.querySelector('#map').dataset.dailyLocated),
        lines:fixtureMap.lines.filter(line=>line.map).map(line=>line.o.path.map(p=>p.lat)),
        count:document.querySelector('#runListCount').textContent,
        status:document.querySelector('#freshnessState').textContent
      }));
      await vehicle('101');assert.equal((await summary()).list.length,22);
      await vehicle('105');let view=await summary();
      assert.deepEqual([view.list.length,view.located,view.count],[5,5,'5/5착']);
      assert.deepEqual(view.pin.sort(),view.list.sort());
      await page.waitForFunction(()=>fixtureMap.lines.some(line=>line.map));
      assert.deepEqual((await summary()).lines,[[37+1/400,37+3/400],[37+3/400,37]]);
      await page.evaluate(()=>fixtureMap.lines.find(x=>x.map).click());
      assert.match(await page.evaluate(()=>fixtureMap.info),/S105001.*08:00:00.*S105003.*09:00:00/);
      if(width===390){
        await page.locator('#chooseRoutes').click();
        await page.locator('#routeDialog[open]').waitFor();
      }
      for(const [filter,n] of [['COMPLETED',4],['PENDING',1],['ALL',5]]){
        const host=width===390?'#routeDialog':'#runListPanel';
        await page.locator(`${host} [data-run-filter="${filter}"]`).click();
        view=await summary();assert.equal(view.list.length,n);assert.equal(view.located,n);
        assert.deepEqual(view.pin.sort(),view.list.sort());
        assert.deepEqual(await page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles),['105']);
      }
      if(width===390){
        await page.keyboard.press('Escape');
        await page.locator('#routeDialog').waitFor({state:'hidden'});
        await page.locator('#runListPanel [data-run-filter="ALL"]').waitFor();
        assert.equal(await page.locator('[data-run-filter="ALL"]').count(),1);
        assert.equal(await page.locator('#runListPanel [data-run-filter="ALL"]').getAttribute('aria-pressed'),'true');
      }
      await vehicle('999');assert.equal((await summary()).count,'0착');
      await vehicle('105');
      const calls=requests.length;
      const switching=[];
      for(let i=0;i<12;i++){
        const [v,n]=[['122',17],['202',22],['105',5]][i%3];
        const start=performance.now();await vehicle(v);assert.equal((await summary()).list.length,n);switching.push(performance.now()-start);
      }
      assert.equal(requests.length,calls);
      await page.evaluate(()=>document.querySelector('[data-run-code]').click());
      const retained=await page.evaluate(()=>MapUiLocalBridge.state.selected?.customerCode);
      for(const status of [403,503,409]){
        outage=status;await page.evaluate(()=>document.querySelector('#syncOperation').click());
        await page.waitForFunction(()=>!document.querySelector('#syncOperation').disabled);
        view=await summary();
        assert.equal(view.list.length,5);assert.match(view.status,status===409?/부분 페이지/:new RegExp(String(status)));
        assert.equal(await page.evaluate(()=>MapUiLocalBridge.state.selected?.customerCode),retained);
      }
      outage=0;
      await selectedDate(slow);await page.waitForRequest(r=>r.url().endsWith('date='+slow),{timeout:1000}).catch(()=>{});await selectedDate(second);
      await page.waitForFunction(()=>MapUiLocalBridge.state.selectedDate==='2026-11-10'&&MapUiLocalBridge.isDataReady());
      assert.equal((await summary()).list.length,6);
      await page.waitForResponse(r=>r.url().endsWith('date='+slow),{timeout:600}).catch(()=>{});
      assert.equal((await summary()).list.length,6);
      const restores=[];
      for(let i=0;i<12;i++){
        const start=performance.now();await selectedDate(i%2?second:first);
        assert.equal((await summary()).list.length,i%2?6:5);restores.push(performance.now()-start);
      }
      const p95=values=>Math.round(values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]*10)/10;
      t.diagnostic(JSON.stringify({width,vehicleP95:p95(switching),restoreP95:p95(restores)}));
      assert.ok(p95(switching)<1000&&p95(restores)<1000);
      assert.equal(opsCalls,0);assert.deepEqual(errors,[]);
      await page.close();
    });
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

test('Stage B contract keeps every visit while vehicle evidence loads or fails', {timeout:45000}, async t=>{
  const {createHash}=await import('node:crypto');
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const date='2026-11-11', older='2026-11-10', delayed='2026-11-08';
  const stage='https://freshon-admin-stage-preview-template.onrender.com';
  const lengths={'101':22,'105':18,'122':17,'202':22};
  const makeRows=day=>Object.entries(lengths).flatMap(([vehicle,size])=>
    Array.from({length:day===older&&vehicle==='105'?6:size},(_,i)=>({
      deliveryId:digest([day,vehicle,i]),deliveryDate:day,customerCode:'S'+vehicle+(vehicle==='105'&&i===17?0:i),
      vehicle,state:vehicle==='105'&&i<8?'COMPLETED':'OPEN',sourceStatus:'OPEN',
      completionType:'NO_INDIVIDUAL_RECORD',individualCompletedAt:null,bulkProcessed:null,
      verification:'NO_INDIVIDUAL_RECORD',eventSource:'DELIVERY_TASK_LIST'
    })));
  const coordinates=makeRows(date).map((row,i)=>({customerCode:row.customerCode,customerName:'매장 '+i,
    address:'Fixture address',lat:37+i/1000,lng:127}));
  let mode='fail',revision=0,authLoss=false,published=false,rosterFailure=false,reads=0,chronologyReads=0,legacyReads=0;
  const html=(await readFile(new URL('../public/opsmap/map-phase2b-preview.html',import.meta.url),'utf8'))
    .replace(/<script[^>]+src="(?:https:\/\/cdn[^"]+|map-staff-entry\.js[^"]+)"[^>]*><\/script>/g,'')
    .replace(/<script type="application\/x-map-staff" data-src="([^"]+)"[^>]*><\/script>/g,'<script src="$1"></script>')
    .replace(/<script[^>]*type="module"[^>]*>[\s\S]*?<\/script>/g,'');
  const host=express(),app=express.Router();host.use('/opsmap',app);
  app.get('/',(_q,r)=>r.type('html').send(html));
  app.get('/kakao-maps-adapter.js',(_q,r)=>r.type('js').send(mapStub));
  app.get('/api/map-phase2b/preview/snapshot',(_q,r)=>r.json({data:coordinates,meta:{complete:true}}));
  app.get('/api/map-phase2b/private/dated-delivery',async(q,r)=>{
    const {date:day,center,vehicle=null}=q.query;
    if(authLoss)return r.status(403).json({error:'STAFF_ACCESS_LOST'});
    if(center!=='osan'||rosterFailure&&!vehicle)return r.status(503).json({rows:null,error:'DELIVERY_SOURCE_READ_UNAVAILABLE'});
    const stamp=day+'T00:00:'+String(revision).padStart(2,'0')+'.000Z';
    const roster=makeRows(day), data=vehicle?roster.filter(row=>row.vehicle===vehicle):roster;
    const selected=roster.filter(row=>row.vehicle==='105');
    const state=published?'PUBLISHED_VERIFIED':'LIVE_VERIFIED';
    let ordered=[],ties=[];
    if(vehicle){
      chronologyReads++;
      if(mode==='fail') {
        await new Promise(resolve=>setTimeout(resolve,180));
        return r.status(503).json({rows:null,error:'DELIVERY_SOURCE_READ_UNAVAILABLE'});
      }
      if(mode==='ok'&&vehicle==='105'&&selected.length>=8){
        const ids=[1,5,7].map(i=>selected[i].deliveryId);
        const tied=[2,3].map(i=>selected[i].deliveryId);
        const times=new Map([[ids[0],day+'T01:00:00.000Z'],[ids[1],day+'T02:00:00.000Z'],[ids[2],day+'T03:00:00.000Z'],
          [tied[0],day+'T01:30:00.000Z'],[tied[1],day+'T01:30:00.000Z']]);
        ordered=ids;
        ties=[{at:day+'T01:30:00.000Z',deliveryIds:tied}];
        for(const row of data)if(times.has(row.deliveryId))Object.assign(row,{
          verification:'VERIFIED_INDIVIDUAL',bulkProcessed:false,completionType:'DIRECT_HANDOFF',
          individualCompletedAt:times.get(row.deliveryId),eventSource:'TASK_STATUS_RECORD'
        });
      }
    }else{
      reads++;
      if(day===delayed)await new Promise(resolve=>setTimeout(resolve,330));
    }
    return r.json({contract:'opsmap-dated-delivery-v1',date:day,center,sourceId:'1',vehicle,
      generation:null,state,error:published?'DELIVERY_SOURCE_READ_UNAVAILABLE':null,sourceComplete:true,
      currentReadComplete:!published,scopeComplete:true,confirmedEmpty:false,lastSuccessAt:stamp,
      source:{sha256:digest(makeRows(day)),uniqueDeliveries:roster.length,unassigned:0},sha256:digest(data),
      count:data.length,activeCount:data.length,rows:data,chronology:ordered,chronologyTies:ties});
  });
  app.get(['/api/map-phase2b/preview/assignments','/api/map-phase2b/preview/daily-completions'],(_q,r)=>{legacyReads++;r.status(500).end();});
  app.get('/api/*',(_q,r)=>r.status(404).json({error:'FIXTURE_NOT_CONFIGURED'}));
  app.use(express.static(new URL('../public/opsmap/',import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/i,'')));
  const server=host.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const local='http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser=await chromium.launch({channel:'chrome',headless:true});
    for(const width of [1440,390])await t.test(width+'px',async()=>{
      mode='fail';revision=0;authLoss=false;published=false;rosterFailure=false;
      const page=await browser.newPage({viewport:{width,height:900}});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.clock.install({time:new Date('2026-11-11T03:00:00Z')});
      await page.route(stage+'/**',async route=>{
        const url=new URL(route.request().url());
        try{await route.fulfill({response:await route.fetch({url:local+url.pathname+url.search})});}catch{await route.abort().catch(()=>{});}
      });
      const dateTo=day=>page.evaluate(value=>{const n=document.querySelector('#date');n.value=value;n.dispatchEvent(new Event('change'));},day);
      const vehicleTo=(...vehicles)=>page.evaluate(values=>{
        for(const input of document.querySelectorAll('#vehicleList input[type=checkbox]'))input.checked=values.includes(input.value);
        document.querySelector('#vehicleList input[type=checkbox]').dispatchEvent(new Event('change'));
      },vehicles);
      const sync=()=>page.evaluate(()=>document.querySelector('#syncOperation').click());
      const ready=()=>page.waitForFunction(()=>MapUiLocalBridge.isDataReady()&&!document.querySelector('#syncOperation').disabled);
      const summary=()=>page.evaluate(()=>({
        visits:[...document.querySelectorAll('[data-run-visit]')].map(node=>node.dataset.runVisit),
        located:Number(document.querySelector('#map').dataset.dailyLocated||0),
        total:document.querySelector('#opTotal').textContent,
        lines:fixtureMap.lines.filter(line=>line.map).map(line=>line.o.path.map(point=>point.lat)),
        count:document.querySelector('#runListCount').textContent,
        status:document.querySelector('#freshnessState').textContent
      }));
      await page.goto(stage+'/opsmap/');
      await page.waitForFunction(()=>window.MapUiLocalBridge?.state.map);
      await page.evaluate(()=>document.querySelector('#modeDaily').click());
      await ready();
      const startedChronology=chronologyReads;
      const requested=reads,switchTimes=[];
      for(let i=0;i<12;i++){
        const [vehicle,expected]=Object.entries(lengths)[i%4],start=performance.now();
        await vehicleTo(vehicle);
        const view=await summary();
        assert.deepEqual([view.visits.length,view.located,view.total],[expected,expected,String(expected)]);
        switchTimes.push(performance.now()-start);
      }
      assert.equal(reads,requested);
      assert.ok(chronologyReads>startedChronology);
      await vehicleTo('101','105');
      assert.deepEqual((await summary()).visits.length,40);
      await vehicleTo('105');
      assert.equal(new Set((await summary()).visits).size,18);
      assert.equal((await summary()).lines.length,0);
      revision++;mode='empty';await sync();await ready();
      assert.deepEqual([(await summary()).visits.length,(await summary()).lines.length],[18,0]);
      revision++;mode='ok';await sync();await ready();
      await page.waitForFunction(()=>fixtureMap.lines.filter(line=>line.map).length===2);
      assert.match((await summary()).count,/동일 시각 2착 순서 미확정/);
      assert.equal((await summary()).visits.length,18);
      for(const [filter,n] of [['COMPLETED',8],['PENDING',10],['ALL',18]]){
        await page.evaluate(value=>document.querySelector('[data-run-filter="'+value+'"]').click(),filter);
        const view=await summary();
        assert.deepEqual([view.visits.length,view.located,view.total],[n,n,'18']);
      }
      const before=await summary();
      rosterFailure=true;await sync();await ready();
      const retained=await summary();
      assert.deepEqual(retained.visits,before.visits);
      assert.equal(retained.status.replace('마지막 확인 배차 유지','배차 확인'),before.status);
      rosterFailure=false;
      await dateTo(delayed);await dateTo(older);await ready();
      assert.equal((await summary()).visits.length,6);
      await dateTo(date);await ready();
      assert.equal((await summary()).visits.length,18);
      const restores=[];
      for(let i=0;i<12;i++){
        const start=performance.now();await dateTo(i%2?date:older);
        assert.equal((await summary()).visits.length,i%2?18:6);
        restores.push(performance.now()-start);
      }
      published=true;
      await page.reload();
      await page.waitForFunction(()=>window.MapUiLocalBridge?.state.map);
      await page.evaluate(()=>document.querySelector('#modeDaily').click());
      await ready();
      await vehicleTo('105');
      assert.equal((await summary()).visits.length,18);
      assert.match((await summary()).status,/마지막 확인 배차 유지/);
      authLoss=true;await sync();
      await page.waitForFunction(()=>document.querySelector('#freshnessState').textContent==='직원 로그인 필요');
      assert.deepEqual([(await summary()).visits.length,(await summary()).located,(await summary()).total],[0,0,'-']);
      assert.deepEqual(errors,[]);
      assert.equal(legacyReads,0);
      const p95=values=>Math.round(values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]*10)/10;
      t.diagnostic(JSON.stringify({width,vehicleP95:p95(switchTimes),dateRestoreP95:p95(restores)}));
      assert.ok(p95(switchTimes)<1000&&p95(restores)<1000);
      await page.close();
    });
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
