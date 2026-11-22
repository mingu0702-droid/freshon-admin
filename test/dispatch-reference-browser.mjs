import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {dispatchPeriodDates,projectDispatchPeriodDay} from '../src/opsmapDispatchPeriod.js';
import {compareDispatchRoutes,createDispatchReference,discoverDispatchRoutes,simulateDispatchTransfer} from '../public/opsmap/dispatch-reference.mjs';

const assets=new URL('../public/opsmap/',import.meta.url);
const fixture=await fs.readFile(new URL('./fixtures/opsmap-dispatch-preview-map.js',import.meta.url),'utf8');
const day='2026-11-23';
const local=process.env.OPSMAP_DISPATCH_PREVIEW_ORIGIN;
if (local&&!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(local)) throw Error('OPSMAP_DISPATCH_LOOPBACK_REQUIRED');
const output=process.env.OPSMAP_DISPATCH_SCREENSHOTS;
const origin=local||'https://dispatch.test';
const browser=await chromium.launch({channel:'chrome',headless:true});
const firstPoint={lat:37.5001,lng:127.035,postalCode:'01234',coordinateVerified:true};
const secondPoint={lat:37.50113,lng:127.035,postalCode:'01234',coordinateVerified:true};
const row=(vehicle,customerCode,customerName,point)=>({vehicle,customerCode,customerName,...point});
const data={contract:'opsmap-dispatch-reference-v1',date:day,center:'osan',route:{state:'VERIFIED',rows:[
  row('101','S1','첫째 매장',firstPoint), row('101','S3','같은 건물 매장',firstPoint),
  row('208','S2','둘째 매장',secondPoint), row('208','S4','다른 지역 매장',{...secondPoint,lat:37.52,postalCode:'01235'}),
  row('303','S5','다른 호차 매장',{...firstPoint,lat:37.5005,lng:127.036}),
]},amounts:{date:day,state:'VERIFIED',vehicles:[
  {vehicle:'101',amount:400,detailState:'VERIFIED',detailRows:[{customerCode:'S1',amount:150},{customerCode:'S3',amount:250}]},
  {vehicle:'208',amount:200,detailState:'VERIFIED',detailRows:[{customerCode:'S2',amount:100},{customerCode:'S4',amount:100}]},
  {vehicle:'303',amount:75,detailState:'VERIFIED',detailRows:[{customerCode:'S5',amount:75}]},
]}};
const outline={id:'01234',box:[127.0347,37.4999,127.0353,37.5013],rings:[
  [[127.0347,37.4999],[127.0353,37.4999],[127.0353,37.5013],[127.0347,37.5013]],
]};

function fixtureHtml() {
  return '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<style>.workspace{height:calc(100vh - 95px)}#leftPanel{display:flex;flex-direction:column;}#map{position:relative;overflow:hidden;}'+
    '.pin{padding:4px;color:#fff;background:var(--pin)} label{display:block}</style><body class="dotRestored">'+
    '<header id="approvedSiteHeader"><nav><button id="modePeriod" aria-pressed="true">매장 지도</button>'+
    '<button id="modeDaily" aria-pressed="false">일자별 운행</button></nav></header><main class="workspace">'+
    '<aside id="leftPanel"><div class="scrollside"><section class="customerBlock"><input id="query"></section></div></aside>'+
    '<section class="maparea"><div id="map"></div></section></main><script src="/fixture.js"></script>'+
    '<script src="/map-view-policy.js"></script><script>'+
    'window.signedIn=false;window.MapStaffEntry={session:()=>signedIn,registerPurge:fn=>window.purge=fn};'+
    'const maps=kakao.maps;const map=new maps.Map(document.querySelector("#map"),{center:new maps.LatLng(37.50,127.035),level:4});'+
    'window.MapUiLocalBridge={state:{map},dispatchReferencePin:(row,{color,label,title,pick})=>{const button=document.createElement("button");'+
    'button.className="dispatch-map-pin";button.title=title;button.onclick=pick;const pin=document.createElement("span");pin.className="pin";'+
    'pin.style.setProperty("--pin",color);pin.textContent=label;button.append(pin);return button;},'+
    'dispatchReferenceFixedVehicle:()=>208,selectDispatchReferenceStore:code=>{window.picked=code;'+
    'dispatchEvent(new CustomEvent("map-store-selected",{detail:{customerCode:code}}));return true;}};'+
    'document.querySelector("#modeDaily").onclick=()=>{document.querySelector("#modePeriod").setAttribute("aria-pressed","false");'+
    'document.querySelector("#modeDaily").setAttribute("aria-pressed","true");};'+
    '</script><script type="module" src="/dispatch-reference-tab.mjs"></script></body></html>';
}

async function exercise() {
  const page=await browser.newPage({viewport:{width:1440,height:950}});
  page.setDefaultTimeout(12000);
  const errors=[], writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
    if(request.method()!=='GET'&&!new URL(request.url()).pathname.endsWith('/preview/base-vehicles')) writes.push(request.method());
  });
  await page.clock.setFixedTime(new Date('2026-11-23T01:00:00+09:00'));
  const currentDay=local ? await (await page.request.get(origin+'/api/map-phase2b/private/dispatch-reference-day?date='+day)).json() : data;
  const currentModel=createDispatchReference(currentDay,[],day);
  const pair=compareDispatchRoutes(currentModel,'101','208',.5);
  const customer=process.env.OPSMAP_DISPATCH_QA_CUSTOMER;
  const sample=pair.candidates.find(row=>row.postalOverlap&&row.amount>0&&(!customer||row.customerCode===customer));
  assert(sample);
  const projected=simulateDispatchTransfer(pair,sample.customerCode);
  assert(projected);
  const compareVehicle=discoverDispatchRoutes(currentModel,'101').find(item=>item.source.vehicle!=='208'&&item.minimumKm!==null&&item.minimumKm<=.5)?.source.vehicle;
  assert(compareVehicle);
  const number=value=>new Intl.NumberFormat('ko-KR').format(value);
  let reads=0;
  if (!local) await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    assert.equal(url.origin,origin);
    const filename=path.posix.basename(url.pathname);
    if (url.pathname==='/') return route.fulfill({contentType:'text/html',body:fixtureHtml()});
    if (filename==='fixture.js') return route.fulfill({contentType:'text/javascript',body:fixture});
    if (filename==='dispatch-reference-day') {
      reads++;
      const date=url.searchParams.get('date');
      const historical={...data,date,amounts:{date,state:'UNAVAILABLE',vehicles:[]}};
      if (date==='2026-11-21') return route.fulfill({json:historical});
      if (date===day) return route.fulfill({json:data});
      return route.fulfill({json:{...historical,route:{state:'UNAVAILABLE',rows:[]}}});
    }
    if (filename==='dispatch-reference-period') {
      const end=url.searchParams.get('end'), days=Number(url.searchParams.get('days'));
      const range=dispatchPeriodDates(end,days), projected=projectDispatchPeriodDay(data);
      return route.fulfill({json:{contract:'opsmap-dispatch-period-v1',center:'osan',end,days,start:range[0],
        dates:range.map(date=>[day,'2026-11-21'].includes(date)
          ? {...projected,date,wmsVerified:date===day,amounts:date===day?projected.amounts:[]} : {date,state:'UNAVAILABLE'})}});
    }
    if (filename==='outline') return route.fulfill({json:{ok:true,data:outline}});
    return route.fulfill({path:fileURLToPath(new URL(filename,assets))});
  });

  await page.goto(origin+(local?'/opsmap/':'/'));
  if (!local) {
    assert.equal(await page.locator('#modeDispatchReference').count(),0);
    assert.equal(reads,0);
    await page.evaluate(()=>{window.signedIn=true;dispatchEvent(new Event('map-staff-ready'));});
  }
  await page.waitForFunction(()=>window.MapUiLocalBridge?.state.map);
  await page.evaluate(()=>{window.originalDispatchMap=MapUiLocalBridge.state.map;});
  await page.locator('#modeDispatchReference').click();
  const primary=page.getByLabel('첫 번째 호차'),secondary=page.getByLabel('두 번째 호차');
  await primary.selectOption('101');
  await page.waitForFunction(()=>document.querySelector('[data-dispatch-role="primary"]'));
  await secondary.selectOption('208');
  await page.waitForFunction(count=>document.querySelector('.dispatch-coverage').textContent.includes('경계 '+count+'곳'),pair.sharedPostalCodes.length);
  const postcode=page.getByLabel('우편번호·중첩 지역');
  await postcode.selectOption(sample.postalCode);
  const code=sample.customerCode, pin=page.locator('[data-dispatch-customer="'+code+'"]');
  const details=page.locator('.dispatch-detail-body');
  await page.waitForFunction(customer=>document.querySelector('[data-dispatch-customer="'+customer+'"]'),code);
  assert(await pin.getAttribute('data-dispatch-candidate')!==null);
  await pin.click();
  assert.match(await details.innerText(),/208호 → 101호 가상 이관/);
  assert((await details.innerText()).includes(number(Math.round(sample.km*1000))+'m'));
  if (local) {
    assert((await details.innerText()).includes(number(sample.amount)+'원'));
    assert((await details.innerText()).includes(number(projected.sourceAmount)+'원'));
    assert((await details.innerText()).includes(number(projected.targetAmount)+'원'));
    assert.match(await details.innerText(),/차액 0원/);
    const fill=customerCode=>page.locator('[data-dispatch-customer="'+customerCode+'"] .pin')
      .evaluate(marker=>getComputedStyle(marker).backgroundColor);
    assert.equal(await fill(code),'rgb(220, 103, 20)');
    const somePrimary=await page.locator('[data-dispatch-role="primary"][data-dispatch-customer]').first().getAttribute('data-dispatch-customer');
    assert.equal(await fill(somePrimary),'rgb(23, 103, 212)');
  } else {
    assert.match(await details.innerText(),/400원 → 500원/);
    assert.equal(await page.evaluate(()=>window.picked),'S2');
  }
  assert.equal(await page.locator('main.workspace').isVisible(),true);
  assert(await page.locator('#query').isVisible());
  assert.equal(await page.evaluate(()=>MapUiLocalBridge.state.map===window.originalDispatchMap),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('#map').count(),1);

  assert.match(await details.innerText(),/격차 증가/);
  if (output) {
    await fs.mkdir(output,{recursive:true});
    await page.screenshot({path:path.join(output,'opsmap-dispatch-map-pc.png')});
  }
  const reverseCode=sample.nearest.customerCode;
  if (local) {
    await postcode.selectOption('');
    await page.locator('.dispatch-stores summary').click();
  } else {
    const group=page.locator('#map button.dispatch-map-pin[title="2개 배송 매장"]');
    await group.click();
    await page.getByText('같은 위치 · 2개 매장').waitFor();
  }
  if (local) {
    await page.locator('#query').fill(reverseCode);
    await page.locator('#searchBtn').click();
    await page.waitForFunction(customer=>MapUiLocalBridge.state.selected?.customerCode===customer,reverseCode);
  } else await page.locator('[data-dispatch-list-customer="'+reverseCode+'"]').click();
  assert.match(await details.innerText(),/101호 → 208호 가상 이관/);
  assert.match(await details.innerText(),new RegExp(reverseCode));
  assert.equal((await details.innerText()).includes(code+' · 208호'),false);
  await page.locator('.dispatch-fleet > summary').click();
  await page.getByLabel('오산 호차 검색').fill(compareVehicle+'호');
  const extra=page.getByRole('checkbox',{name:compareVehicle+'호 지도에 추가'});
  await extra.check();
  assert.equal(await secondary.inputValue(),'208');
  await page.getByRole('button',{name:compareVehicle+'호 비교 및 확대'}).click();
  assert.equal(await secondary.inputValue(),compareVehicle);
  assert.equal(await page.locator('#detailSection.open').count(),0);
  if (output) await page.screenshot({path:path.join(output,'opsmap-dispatch-fleet-pc.png')});
  await page.getByLabel('오산 호차 검색').fill('');
  await secondary.selectOption('208');

  const state=await page.locator('#map').boundingBox();
  assert(state.width>300&&state.height>300);
  const gesture=await page.evaluate(()=>{
    const surface=document.querySelector('[aria-label="Kakao SDK 테스트 지도"]');
    const box=surface.getBoundingClientRect();
    for (const y of [.15,.24,.30,.42]) for (const x of [.16,.38,.63,.74]) {
      const rx=box.left+x*box.width,ry=box.top+y*box.height;
      if (document.elementFromPoint(rx,ry)===surface) return {x:rx,y:ry};
    }
    return null;
  });
  assert(gesture);
  await page.mouse.move(gesture.x,gesture.y);
  const before=await page.evaluate(()=>MapUiLocalBridge.state.map.getLevel());
  await page.mouse.wheel(0,200);
  await page.waitForFunction(level=>MapUiLocalBridge.state.map.getLevel()>level,before);
  const lng=await page.evaluate(()=>MapUiLocalBridge.state.map.getCenter().getLng());
  await page.mouse.down();
  await page.mouse.move(gesture.x+20,gesture.y+18,{steps:3});
  await page.mouse.up();
  await page.waitForFunction(value=>MapUiLocalBridge.state.map.getCenter().getLng()!==value,lng);

  const date=page.locator('#dispatchReference [name="date"]');
  async function changeDay(value) {
    const response=page.waitForResponse(r=>r.url().includes('dispatch-reference-day?date='+value));
    await date.fill(value);
    return (await response).json();
  }
  const historic=await changeDay('2026-11-21');
  const archivedAmount=historic.amounts.vehicles.find(row=>row.vehicle==='101')?.amount;
  await page.waitForFunction(useReal=>document.querySelector('.dispatch-detail-body').textContent
    .includes(useReal),local?number(archivedAmount)+'원':'금액 미확인');
  assert.equal(await details.getByText('고객코드',{exact:true}).count(),0);
  assert.equal(await primary.inputValue(),'101');
  if (local) {
    const datedPin=page.locator('[data-dispatch-role="primary"][data-dispatch-customer]').first();
    const datedCode=await datedPin.getAttribute('data-dispatch-customer');
    await datedPin.click();
    const datedAmount=historic.amounts.vehicles.find(row=>row.vehicle==='101').detailRows.find(row=>row.customerCode===datedCode);
    await details.getByText('조회일 확정호차',{exact:true}).locator('..').getByText('101호',{exact:true}).waitFor();
    await details.getByText('WMS 매장 금액',{exact:true}).locator('..').getByText(
      new Intl.NumberFormat('ko-KR').format(datedAmount.amount)+'원',{exact:true}).waitFor();
    if (output) await page.screenshot({path:path.join(output,'opsmap-dispatch-history-1121-pc.png')});
  }

  await changeDay('2026-11-20');
  await page.getByText(/선택한 배송일의 확정 배차와 WMS 금액을 확인할 수 없습니다/).waitFor();
  assert.equal(await page.locator('#map .dispatch-map-pin').count(),0);
  assert(!((await details.innerText()).includes(number(sample.amount)+'원')));
  await changeDay(day);
  await page.getByLabel('조회 방식').selectOption('period');
  await details.getByText('확정 2일',{exact:true}).waitFor();
  assert.match(await details.innerText(),/미확인 5일/);
  assert.match(await details.innerText(),local?/WMS 금액 확인 2일/:/WMS 금액 확인 1일/);
  await page.getByLabel('지역 집계 기준').selectOption('completed');
  assert.match(await details.innerText(),/지도 집계 · 배송완료 확인/);
  assert.equal(await page.locator('[data-dispatch-area]').count(),0);
  await page.getByLabel('지역 집계 기준').selectOption('dispatch');
  const analysis=page.getByLabel('분석 호차');
  await analysis.selectOption(['101','208']);
  await postcode.selectOption(sample.postalCode);
  await details.getByText('우편번호 '+sample.postalCode,{exact:true}).waitFor();
  if (output) await page.screenshot({path:path.join(output,'opsmap-dispatch-period-7days-pc.png')});
  await page.getByLabel('분석기간').selectOption('90');
  await details.getByText('미확인 날짜 88일',{exact:true}).waitFor();

  await page.locator('#modeDaily').click();
  assert.equal(await page.locator('#dispatchReference').isHidden(),true);
  assert.equal(await page.locator('#map .dispatch-map-pin').count(),0);
  if (!local) {
    assert(reads>=4);
    await page.locator('#modeDispatchReference').click();
    await page.locator('#dispatchReference').waitFor();
    await page.evaluate(()=>{window.signedIn=false;window.purge();});
    assert.equal(await page.locator('#modeDispatchReference').count(),0);
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(writes,[]);
  await page.close();
}

try {
  await exercise();
  console.log('PASS PC Chrome: day changes, verified period, postcode, same map, WMS transfer, search, drag and zoom');
} finally {
  await browser.close();
}
