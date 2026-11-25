import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {dispatchDailyRoster,dispatchOverlapDetail,dispatchOverlapOverview,dispatchOverlapVehicles} from '../public/opsmap/dispatch-reference-v4.mjs';
import {createDispatchReference} from '../public/opsmap/dispatch-reference.mjs';

const origin='https://dispatch-v4.test', day='2026-11-28', previous='2026-11-27';
const assets=new URL('../public/opsmap/',import.meta.url);
const fixture=await fs.readFile(new URL('./fixtures/opsmap-dispatch-preview-map.js',import.meta.url),'utf8');
const meta={contract:'opsmap-dispatch-overlaps-v1',state:'VERIFIED',center:'osan',version:'a'.repeat(64),
  fixedVersion:'b'.repeat(64),registryVersion:'c'.repeat(64)};
const point=(index,located=true)=>({lat:located?37.48+index*.0002:null,lng:located?127.05+index*.00004:null,coordinateVerified:located});
const member=(vehicle,customerCode,index,located)=>({vehicle,customerCode,customerName:'검증용 매장 '+index,...point(index,located)});
const longArea='충청남도 검증시 배송지역명이 길어도 화면에서 읽을 수 있는 우편행정구역';
const zone={postalCode:'01234',routeCount:3,storeCount:4,routes:[
  {vehicle:'201',storeCount:2},{vehicle:'228',storeCount:1},{vehicle:'315',storeCount:1}],
  stores:[member('201','S1000',0),member('201','S9000',1,false),member('228','S1027',27),member('315','S9010',5)]};
const other={postalCode:'01235',routeCount:2,storeCount:2,routes:[{vehicle:'211',storeCount:1},{vehicle:'229',storeCount:1}],
  stores:[member('211','S1010',10),member('229','S1028',28)]};
const extraZones=Array.from({length:80},(_,index)=>({postalCode:String(20000+index),routeCount:2,storeCount:2,
  routes:[{vehicle:'211',storeCount:1},{vehicle:'229',storeCount:1}],
  stores:[member('211','S'+(2000+index*2),index),member('229','S'+(2001+index*2),index+1)]}));
const zones=new Map([other,zone,...extraZones].map(candidate=>[candidate.postalCode,candidate]));
const candidates=[...zones.values()].map(({stores,...summary})=>summary);
const overview=dispatchOverlapOverview({...meta,candidates});
assert.equal(overview.candidates[0].postalCode,'01234');
assert.equal(dispatchOverlapDetail({...meta,candidate:zone},overview,overview.candidates[0]).stores.filter(row=>row.point).length,3);
assert.throws(()=>dispatchOverlapDetail({...meta,version:'e'.repeat(64),candidate:zone},overview,overview.candidates[0]));
assert.throws(()=>dispatchOverlapDetail({...meta,candidate:{...zone,stores:[...zone.stores.slice(0,3),zone.stores[1]]}},
  overview,overview.candidates[0]));

function daily(date) {
  const source='WMS_CONFIRMED_DISPATCH_EXPORT',rows=[],vehicles=[];
  for(let i=0;i<110;i++){
    const vehicle=String(201+i),customerCode='S'+(1000+i),amount=(date===day?10_000:20_000)+i;
    rows.push({...member(vehicle,customerCode,i),postalCode:i===0||i===27?'01234':'01235',
      deliveryArea:i===109?longArea:i%2?'충남 검증시':'경기 가상시'});
    vehicles.push({vehicle,amount,deliveryCount:3,waypointCount:i===0?2:null,uniqueCustomerCount:1,
      detailState:'VERIFIED',detailRows:[{customerCode,amount}]});
  }
  rows.push({...member('201','S9500',29),postalCode:'01235'});
  vehicles[0].detailRows[0].amount-=10;
  vehicles[0].detailRows.push({customerCode:'S9500',amount:10});
  vehicles[0].uniqueCustomerCount=2;
  vehicles.push({vehicle:'미배정',amount:205,deliveryCount:2,uniqueCustomerCount:2,waypointCount:null});
  return {contract:'opsmap-dispatch-reference-v1',center:'osan',date,route:{source,state:'VERIFIED',rows,unassigned:2,
    sourceComplete:date===day,observedAt:date+'T10:12:00Z'},
    amounts:{source,date,observedAt:date+'T10:12:00Z',state:'VERIFIED',vehicles,sourceTotals:{
      amount:vehicles.reduce((sum,r)=>sum+r.amount,0),deliveryCount:vehicles.reduce((sum,r)=>sum+r.deliveryCount,0)}}};
}
const model=createDispatchReference(daily(day),[],day);
assert.equal(dispatchDailyRoster(model).length,110);
assert.deepEqual(['waypointCount','deliveryCount','uniqueCustomerCount'].map(key=>model.vehicles.get('201')[key]),[2,3,2]);
assert.equal(model.vehicles.get('228').waypointCount,null);
assert.equal(model.wmsScopeComplete,true);
assert.equal(createDispatchReference(daily(previous),[],previous).wmsScopeComplete,false);
const differentObservation=daily(day);
differentObservation.route.observedAt=day+'T10:13:00Z';
assert.equal(createDispatchReference(differentObservation,[],day).wmsScopeComplete,false);
const routesWithSpacing={vehicles:new Map(['용 01','용1','척 02','척02','101','0101']
  .map(vehicle=>[vehicle,{vehicle,wmsConfirmed:true}]))};
const overlapRoutes=dispatchOverlapVehicles(routesWithSpacing);
assert.equal(overlapRoutes.get('용01').vehicle,'용 01');
assert.equal(overlapRoutes.get('용1').vehicle,'용1');
assert.equal(overlapRoutes.get('척02'),null);
assert.equal(overlapRoutes.get('0101').vehicle,'0101');

const html=[
  '<!doctype html><html lang="ko"><meta charset="utf-8"><body class="dotRestored">',
  '<style>.workspace{height:calc(100vh - 75px)}#leftPanel{display:flex;flex-direction:column}#map{position:relative;overflow:hidden}.pin{color:#fff;background:var(--pin);padding:5px}label{display:block}</style>',
  '<header id="approvedSiteHeader"><nav><button id="modePeriod" aria-pressed="true">매장 지도</button></nav></header>',
  '<main class="workspace"><aside id="leftPanel"><div class="scrollside"><section class="customerBlock"></section></div></aside>',
  '<section class="maparea"><div id="map"></div><button id="mapReset" type="button">전체보기</button></section></main>',
  '<script src="/fixture.js"></script><script src="/map-view-policy.js"></script><script src="/phase2b-ui-helpers.js"></script><script>',
  'window.MapStaffEntry={session:()=>true,registerPurge:fn=>window.purge=fn};',
  'const {Map:KakaoMap,LatLng}=kakao.maps;const map=new KakaoMap(document.querySelector("#map"),{center:new LatLng(37.48,127.05),level:4});',
  'window.originalMap=map;window.MapUiLocalBridge={state:{map},isStagePreview:()=>true,dispatchReferencePin:(row,{color,label,title,pick})=>{',
  'const button=document.createElement("button"),glyph=document.createElement("span");button.className="dispatch-map-pin";button.title=title;button.onclick=pick;',
  'glyph.className="pin";glyph.style.setProperty("--pin",color);glyph.textContent=label;button.append(glyph);return button;},',
  'dispatchReferenceFixedVehicle:()=>null,selectDispatchReferenceStore:()=>false,searchSnapshotGeneration:()=>null};',
  '</script><script type="module" src="/dispatch-reference-tab.mjs"></script></body></html>'
].join('');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  page.setDefaultTimeout(10000);
  const errors=[],requests=[];
  let overlapState='VERIFIED',refuseDetail=false,dayGate;
  page.on('pageerror',error=>errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-11-28T08:00:00+09:00'));
  await page.route('**/*',async interceptor=>{
    const url=new URL(interceptor.request().url());
    assert.equal(url.origin,origin);
    if(url.pathname==='/')return interceptor.fulfill({contentType:'text/html',body:html});
    if(url.pathname==='/fixture.js')return interceptor.fulfill({contentType:'application/javascript',body:fixture});
    if(url.pathname.startsWith('/api/')){
      requests.push([url.pathname,url.search,interceptor.request().method()]);
      if(url.pathname.endsWith('dispatch-reference-day')){
        if(dayGate)await dayGate;
        return interceptor.fulfill({json:daily(url.searchParams.get('date'))});
      }
      if(url.pathname.endsWith('dispatch-reference-overlaps')){
        if(overlapState==='UNAVAILABLE')return interceptor.fulfill({status:503,json:{state:'UNAVAILABLE'}});
        const zip=url.searchParams.get('postalCode');
        if(zip){
          assert.equal(url.searchParams.get('version'),meta.version);
          if(refuseDetail)return interceptor.fulfill({status:409,json:{state:'UNAVAILABLE'}});
          return interceptor.fulfill({json:{...meta,candidate:zones.get(zip)}});
        }
        return interceptor.fulfill({json:{...meta,candidates:overlapState==='EMPTY'?[]:candidates}});
      }
      return interceptor.fulfill({json:{data:null}});
    }
    const asset=await fs.readFile(new URL(url.pathname.slice(1),assets));
    return interceptor.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',body:asset});
  });
  await page.goto(origin);
  assert.equal(requests.length,0);
  const tab=page.getByRole('button',{name:'배차 참고',exact:true}),roster=page.locator('.dispatch-v4-table');
  const overlap=page.locator('.dispatch-v4-overlaps');
  const row=vehicle=>roster.locator('[data-dispatch-v4-route="'+vehicle+'"]');
  const postal=code=>overlap.locator('[data-dispatch-v4-postal="'+code+'"]');
  await tab.click();
  await row('310').waitFor();
  await postal('01234').waitFor();
  const candidateList=overlap.getByRole('region',{name:'우편번호 후보'});
  const selection=overlap.getByRole('region',{name:'선택 우편번호'});
  assert.equal(await candidateList.locator('[data-dispatch-v4-postal]').count(),82);
  const viewport=await candidateList.evaluate(node=>({height:node.clientHeight,content:node.scrollHeight}));
  assert(viewport.content>2_500&&viewport.height<=256);
  await postal('20079').click();
  await selection.getByText('등록 1곳',{exact:true}).first().waitFor();
  assert(await candidateList.evaluate(node=>node.scrollTop>2_000));
  assert.equal(await page.locator('.dispatch-details').evaluate(node=>node.scrollTop),0);
  await postal('20079').click();
  assert.equal(await roster.getByRole('button').count(),110);
  assert.match(await row('201').innerText(),/2착\s+10,000원\s+경기 가상시/);
  assert.match(await row('228').innerText(),/착수 미확인\s+10,027원/);
  assert.equal(await row('310').locator('.dispatch-v4-area').textContent(),longArea);
  const layout=async width=>{
    await page.setViewportSize({width,height:width===1920?1080:768});
    return page.evaluate(()=>{
      const measure=node=>({width:node.clientWidth,content:node.scrollWidth});
      const area=document.querySelector('[data-dispatch-v4-route="310"] .dispatch-v4-area');
      return {viewport:innerWidth,map:measure(document.querySelector('#map')),work:measure(document.querySelector('.workspace')),
        right:measure(document.querySelector('.dispatch-details')),area:measure(area),
        areaFont:parseFloat(getComputedStyle(area).fontSize),areaOverflow:getComputedStyle(area).textOverflow};
    });
  };
  for(const width of [1366,1920]){
    const sizes=await layout(width);
    assert(sizes.map.width>=width*(width===1920?.68:.58));
    assert(sizes.work.width>=sizes.work.content&&sizes.right.width>=sizes.right.content&&sizes.area.width>=sizes.area.content);
    assert(sizes.areaFont>=13&&sizes.areaOverflow!=='ellipsis');
  }
  await layout(1366);
  assert.match(await page.locator('.dispatch-v4-unassigned').innerText(),/미배정 · 배송 2건 · 205원/);
  assert.equal(await overlap.locator('[data-dispatch-v4-postal]').first().getAttribute('data-dispatch-v4-postal'),'01234');
  assert.equal(await page.evaluate(()=>MapUiLocalBridge.state.map===window.originalMap),true);
  await postal('01234').click();
  await overlap.getByText('당일 배차 없음',{exact:true}).waitFor();
  assert.deepEqual(await selection.locator('.dispatch-v4-vehicle').allTextContents(),['201호','228호','315호']);
  assert.equal(await roster.getByRole('button').count(),110);
  assert.deepEqual(await roster.locator('[aria-pressed=true]').evaluateAll(rows=>rows.map(row=>row.dataset.dispatchV4Route)),['201','228']);
  assert.match(await overlap.locator('li').filter({hasText:'315호'}).innerText(),/등록 1곳\s+당일 배차 없음/);
  assert.match(await overlap.locator('li').filter({hasText:'201호'}).innerText(),/등록 2곳\s+2착/);
  await page.locator('[data-dispatch-customer="S9010"]').waitFor();
  assert.equal(await page.locator('[data-dispatch-customer="S9000"]').count(),0);
  assert.equal(await page.locator('[data-dispatch-customer="S1000"]').getAttribute('data-dispatch-overlap'),'inside');
  assert.equal(await page.locator('[data-dispatch-customer="S9500"]').getAttribute('data-dispatch-overlap'),'outside');
  await page.getByRole('complementary',{name:'배차 지도 범례'}).getByText('해당 우편번호 배송').waitFor();
  const candidateColor=await page.locator('[data-dispatch-customer="S1000"] .pin').evaluate(node=>node.style.getPropertyValue('--pin'));
  const captureDirectory=process.env.OPSMAP_DISPATCH_FIXTURE_CAPTURE_DIR;
  if(captureDirectory){
    await fs.mkdir(captureDirectory,{recursive:true});
    for(const width of [1366,1920]){
      await layout(width);
      await page.screenshot({path:path.join(captureDirectory,'dispatch-v4-fixture-'+width+'.png')});
    }
    await layout(1366);
  }
  await page.locator('[data-dispatch-customer="S9010"]').click();
  assert.match(await page.locator('.dispatch-detail-body').innerText(),/현재 기준호차 315호/);
  await postal('01235').click();
  await overlap.getByText(/등록 1곳/).first().waitFor();
  assert.equal(await roster.getByRole('button').count(),110);
  await page.waitForFunction(()=>!document.querySelector('[data-dispatch-customer="S9010"]'));
  await selection.getByRole('button',{name:'선택 해제'}).click();
  assert.equal(await roster.locator('[aria-pressed=true]').count(),0);
  await page.getByRole('searchbox',{name:'호차 검색'}).fill('228');
  assert.equal(await roster.getByRole('button').count(),1);
  await page.getByRole('searchbox',{name:'호차 검색'}).fill('');
  await page.getByRole('button',{name:'매출',exact:true}).click();
  assert.equal(await roster.getByRole('button').first().getAttribute('data-dispatch-v4-route'),'310');
  await row('201').click();
  const focusedPin=page.locator('[data-dispatch-customer="S1000"] .pin');
  await focusedPin.waitFor();
  assert.equal(await focusedPin.evaluate(node=>node.style.getPropertyValue('--pin')),candidateColor);
  const compare=page.getByLabel('가상 이관 상대 호차');
  const compareBounds=await compare.boundingBox(),rightBounds=await page.locator('.dispatch-details').boundingBox();
  assert(compareBounds.y>=rightBounds.y&&compareBounds.y+compareBounds.height<=rightBounds.y+rightBounds.height,
    'comparison selector stays in view below the scrollable candidate list');
  await compare.selectOption('228');
  await page.getByRole('heading',{name:'호차 비교 및 가상 이관'}).waitFor();
  await page.locator('[data-dispatch-customer="S1027"]').click();
  await page.getByRole('button',{name:'이관 목록에 담기',exact:true}).click();
  await page.getByRole('heading',{name:'가상 이관 1곳',exact:true}).waitFor();
  assert.match(await page.locator('.dispatch-v4-simulation-values').innerText(),/201호 착수\s+전 2착\s+후 미확인/);
  await page.getByLabel('배송일').fill(previous);
  await row('201').getByText('20,000원',{exact:true}).waitFor();
  assert.equal(await roster.getByText('10,000원',{exact:true}).count(),0);
  assert.match(await page.locator('.dispatch-v4-source').innerText(),/2026-11-27 배송/);
  await postal('01234').click();
  await overlap.getByText(/20,000원/).waitFor();
  await selection.getByText('WMS 확인 필요',{exact:true}).waitFor();
  assert(!requests.some(([, ,method])=>method!=='GET'));
  await page.reload();
  await tab.click();
  await row('310').waitFor();
  assert.equal(await roster.getByRole('button').count(),110);
  await postal('01234').waitFor();
  refuseDetail=true;
  await postal('01234').click();
  await overlap.getByText('권역 상세 미확인',{exact:true}).waitFor();
  assert.equal(await roster.locator('[aria-pressed=true]').count(),0);
  assert.equal(await page.locator('[data-dispatch-customer="S9010"]').count(),0);
  await page.getByRole('button',{name:'매장 지도'}).click();
  overlapState='EMPTY';
  await tab.click();
  await overlap.getByText('확인된 우편번호 겹침이 없습니다.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'매장 지도'}).click();
  overlapState='UNAVAILABLE';
  await tab.click();
  await overlap.getByText('등록 권역 자료 미확인',{exact:true}).waitFor();
  await page.getByRole('button',{name:'매장 지도'}).click();
  overlapState='VERIFIED';refuseDetail=false;
  let releaseDay;
  dayGate=new Promise(resolve=>{releaseDay=resolve;});
  await tab.click();
  await postal('01234').click();
  await page.locator('[data-dispatch-customer="S9010"]').waitFor();
  await overlap.getByText('WMS 확인 필요',{exact:true}).first().waitFor();
  releaseDay();
  await overlap.getByText('당일 배차 없음',{exact:true}).waitFor();
  assert.equal(await postal('01234').getAttribute('aria-expanded'),'true');
  assert.equal(await roster.getByRole('button').count(),110);
  await page.setViewportSize({width:390,height:844});
  await tab.waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'매장 지도'}).isVisible(),true);
  assert.equal(await overlap.isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: two dates, 110 routes, overlap with three routes, no dispatch, exact coordinates, preserved transfer, verified empty, unavailable and stale data');
}finally{await browser.close();}
