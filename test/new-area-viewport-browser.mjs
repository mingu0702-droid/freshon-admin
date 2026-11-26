import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium} from 'playwright';

// Isolated functional fixture. The synthetic 16,253 coordinates represent
// the expected cardinality only. An employee map still needs SDK verification.
const base=path.resolve('public/opsmap');
const executablePath=process.env.OPSMAP_TEST_CHROMIUM;
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const result=[];
try {
  for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:800}});
    const errors=[],requests=[];
    await page.route('**/*', route=>{requests.push(route.request().url());return route.abort();});
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<main><div id="map" style="width:100%;height:600px"></div><section id="panel"></section></main>');
    for(const name of ['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','new-area-viewport.js','new-area-detail-panel.js'])
      await page.addScriptTag({path:path.join(base,name)});
    const evidence=await page.evaluate(()=>{
      const element=document.querySelector('#map'), bounds={south:33,north:39.5,west:124,east:132};
      class Point{constructor(lat,lng){this.lat=lat;this.lng=lng;}getLat(){return this.lat;}getLng(){return this.lng;}}
      const paints=[],overlays=[];
      window.kakao={maps:{CustomOverlay:class{constructor(options){this.options=options;overlays.push(this);}setPosition(p){this.options.position=p;}
        setMap(map){this.options.content.remove();if(map)element.append(this.options.content);}}}};
      const original=CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect=function(...args){paints.push(args);return original.apply(this,args);};
      const [minLat,maxLat,minLng,maxLng]=Object.values(bounds), mid=new Point(36.25,128);
      const map={getProjection:()=>({containerPointFromCoords:p=>({x:(p.lng-minLng)/(maxLng-minLng)*element.clientWidth,
        y:(maxLat-p.lat)/(maxLat-minLat)*element.clientHeight})}),getCenter:()=>mid};
      const rows=Array.from({length:16253},(_,i)=>({customerCode:'S'+(10000+i),lat:33.1+Math.floor(i/149)*.058,lng:124.1+(i%149)*.052,
        raw:{centerGroup:['osan','yeongnam','honam'][i%3]}}));
      rows[1]={...rows[1],lat:rows[0].lat,lng:rows[0].lng};
      const index=MapPeriodUi.spatialIndex(rows);
      const subsetBounds={south:35,north:38,west:126,east:128};
      const expected=rows.filter(row=>row.lat>=35&&row.lat<=38&&row.lng>=126&&row.lng<=128).length;
      const dots=MapNewAreaViewport.createDots(map,element);
      const full=dots.draw(index.query(bounds),row=>new Point(row.lat,row.lng));
      const painted=paints.length;
      const hit=dots.hit(new Point(rows[0].lat,rows[0].lng)).map(row=>row.customerCode);
      const subset=dots.draw(index.query(subsetBounds),row=>new Point(row.lat,row.lng));
      const exactBounds={south:rows[0].lat,north:rows[0].lat,west:rows[0].lng,east:rows[0].lng};
      const grouped=MapNewAreaViewport.visibleLocations(index,exactBounds,'BASE_60D');
      const sameCoordinate=grouped[0]?.clusterRows?.length || 1;
      const allGroups=MapPeriodUi.spatialIndex(MapViewPolicy.exactLocations(index.valid,'BASE_60D'));
      const visibleMatches=JSON.stringify(MapNewAreaViewport.visibleLocations(index,subsetBounds,'BASE_60D'))===JSON.stringify(allGroups.query(subsetBounds));
      dots.clear();
      const removed=element.querySelectorAll('canvas').length===0&&dots.hit(mid).length===0;
      const panel=document.querySelector('#panel');
      panel.innerHTML=MapNewAreaDetailPanel.shell({address:'<b>synthetic</b>',canRemove:true,allowBatch:true});
      const stores=rows.slice(0,126).map((r,i)=>({...r,customerName:'STORE-'+i,baseVehicle:'101'}));
      const rank=MapNewAreaDetailPanel.rankNearby({lat:33.1,lng:124.1},stores.slice().reverse(),Phase2bUi.distanceKm);
      panel.querySelector('#nearWrap').innerHTML=MapNewAreaDetailPanel.nearby(rank);
      MapNewAreaDetailPanel.bindMore(panel,rank.stores,rank);
      return {full,painted,hit:hit.slice(0,2),subset,expected,sameCoordinate,visibleMatches,removed,overlays:overlays.length};
    });
    assert.equal(evidence.full,16253);
    assert.equal(evidence.painted,16253);
    assert.deepEqual(evidence.hit,['S10000','S10001']);
    assert.equal(evidence.subset,evidence.expected);
    assert.equal(evidence.sameCoordinate,2);
    assert.equal(evidence.visibleMatches,true);
    assert.equal(evidence.removed,true);
    assert.equal(evidence.overlays,1);
    assert.equal(await page.locator('#panel [data-area-nearby-code]').count(),6);
    assert.equal(await page.locator('.areaPanelAddress b').count(),0);
    await page.locator('#panel summary').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('#panel [data-area-nearby-code]').length===86);
    await page.locator('[data-area-nearby-more]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#panel [data-area-nearby-code]').count(),126);
    await page.locator('#panel [data-area-nearby-code]').last().focus();
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.areaNearbyCode),'S10125');
    assert.deepEqual(errors,[]);
    assert.deepEqual(requests,[]);
    result.push({width,...evidence,keyboard:true});
    await page.close();
  }
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
