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
      const page=await browser.newPage({viewport:{width,height:900}});
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
      for(const [filter,n] of [['COMPLETED',4],['PENDING',1],['ALL',5]]){
        await page.evaluate(f=>document.querySelector('[data-run-filter="'+f+'"]').click(),filter);
        view=await summary();assert.equal(view.list.length,n);assert.equal(view.located,n);
        assert.deepEqual(view.pin.sort(),view.list.sort());
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
