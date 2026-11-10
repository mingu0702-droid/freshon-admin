// Isolated local production HTML/runtime; synthetic records, no SDK/source/pin APIs.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import XLSX from 'xlsx';

const base=path.resolve('public/opsmap'),app=express();
const html=fs.readFileSync(path.join(base,'map-phase2b-preview.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const row={customerCode:'S990001',customerName:'합성 배송처',address:'경기도 화성시 합성로 1',lat:37.2,lng:127,deliveryPattern:'월수금',lastDeliveryDate:'2026-11-02'};
const version='a'.repeat(64),checkedAt='2026-09-24T04:37:59.102Z',basis='FIXED_DISPATCH_PRIMARY';
const assignment={customerCode:row.customerCode,baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',
  weekdays:{Mon:'101',Wed:'122'},baseVehicleSource:basis,baseVehicleVersion:version,baseVehicleCheckedAt:checkedAt,baseVehicleStale:true};
app.get('/',(_q,r)=>r.send(html));
app.get('/api/map-phase2b/preview/snapshot',(_q,r)=>r.json({data:[row],meta:{complete:true,latestDate:'2026-11-02'}}));
app.post('/api/map-phase2b/preview/base-vehicles',(_q,r)=>r.json({ok:true,data:[assignment],meta:{basis,version,checkedAt,stale:true}}));
app.use('/opsmap',express.static(base));
app.use(express.static(base));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r9-new-area-'));
const browser=await chromium.launch({headless:true});
let page;
const errors=[],blocked=[],result={scope:'LOCAL_PRODUCTION_HTML_RUNTIME_SYNTHETIC_NO_KAKAO',checks:[]};
try{
  const context=await browser.newContext({acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});
  page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){blocked.push(u.hostname);return route.abort();}return route.continue();});
  await page.goto(origin);
  await page.evaluate(()=>{window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};window.VEHICLE_AREA_DATA={vehicles:[]};window.KakaoMapsAdapter={ready:()=>new Promise(()=>{})};window.kakaoGeocoder={addressSearch(){throw Error('EXTERNAL_GEOCODING_FORBIDDEN');}};});
  for(const name of ['phase2b-ui-helpers.js','map-period-ui.js','manual-waypoints.js','new-area-requests.js'])await page.addScriptTag({path:path.join(base,name)});
  await page.addScriptTag({path:path.resolve('node_modules/xlsx/dist/xlsx.full.min.js')});
  const runtime=fs.readFileSync(path.join(base,'map-phase2b-runtime.js'),'utf8');
  await page.addScriptTag({content:runtime.replace('\n  initVehicles();',`\n  window.newAreaBrowser={setup(){state.rangeStart='2026-09-01';state.rangeEnd='2026-11-02';},setJudge:fn=>judgeNewAreaRow=fn,realJudge:judgeNewAreaRow,enableMapClick(){state.map={};$('#map').onclick=()=>searchTemporaryClick?.({latLng:{getLat:()=>37.2,getLng:()=>127}});}};\n  initVehicles();`)});
  await page.waitForFunction(()=>window.MapUiLocalBridge?.stores().length===1&&!!window.MapUiLocalBridge.fixedTerritoryMasterState()?.version);
  await page.addScriptTag({path:path.join(base,'map-approved-shell-candidate.js')});
  await page.evaluate(()=>window.newAreaBrowser.setup());
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1100});
    await page.evaluate(()=>{if(!document.querySelector('#mapBatchDialog').open)document.querySelector('#sourceBatch').click();});
    await page.locator('#newAreaBatchInput').fill('S990001\t"합성 고객\n상세주소"\n대구광역시 동구 합성로 2\t합성 고객2\n입력\t오류\t추가열');
    await page.locator('#judgeNewAreaBatch').click();await page.waitForFunction(()=>MapUiLocalBridge.state.newAreaResults.length===3);
    const rows=await page.evaluate(()=>MapUiLocalBridge.state.newAreaResults);
    assert.equal(rows[0].decision,'O');assert.equal(rows[0].nearestDistanceMeters,0);assert.equal(rows[1].reason,'주소 확인 필요');assert.equal(rows[2].reason,'입력 열 확인 필요');
    assert.match(await page.locator('#newAreaBatchResults').innerText(),/배송 가능 \(O\)/);
    assert.match(await page.locator('#newAreaBatchResults').innerText(),/30km 내 참고 배차호차 · 2대 확인/);
    assert.match(await page.locator('#newAreaBatchResults [data-area-nearest-weekdays]').first().innerText(),/101호 월 · 122호 수/);
    await page.locator('#newAreaApplyDate').fill('2026-11-02');await page.locator('#copyAreaDecision').click();
    assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).split('\r\n').length,3);
    await page.locator('#copyAreaMatching').click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/합성 배송처/);
    const csvPending=page.waitForEvent('download');await page.locator('#exportNewAreaCsv').click();const csv=await csvPending;await csv.saveAs(path.join(artifacts,'result-'+width+'.csv'));
    const csvText=fs.readFileSync(path.join(artifacts,'result-'+width+'.csv'),'utf8');assert.match(csvText,/검토필요/);assert.match(csvText,/S990001/);assert.match(csvText,/합성 고객\n상세주소/);
    const excelPending=page.waitForEvent('download');await page.locator('#exportNewAreaExcel').click();const excel=await excelPending;await excel.saveAs(path.join(artifacts,'result-'+width+'.xlsx'));
    const book=XLSX.readFile(path.join(artifacts,'result-'+width+'.xlsx'));const cells=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1});assert.equal(cells.length,4);assert.equal(cells[1][0],'S990001');assert.equal(cells[1][2],'O');assert.match(cells[1].at(-1),/500m 이내/);
    await page.locator('[data-judged="1"]').click();assert.equal(await page.locator('#manualLabel').inputValue(),'대구광역시 동구 합성로 2');assert.equal(await page.locator('#manualLat').inputValue(),'');
    await page.locator('#manualLat').fill('35.9');await page.locator('#manualLng').fill('128.65');await page.locator('#manualAdd').click();
    await page.evaluate(()=>{if(!document.querySelector('#mapBatchDialog').open)document.querySelector('#sourceBatch').click();});
    await page.locator('#judgeNewAreaBatch').click();await page.waitForFunction(()=>MapUiLocalBridge.state.newAreaResults[1]?.coordinateSource==='MANUAL_WAYPOINT');
    result.checks.push({width,passed:true,rows:3,copy:true,csv:true,xlsx:true,manualCoordinates:true});
    await page.screenshot({path:path.join(artifacts,'ui-'+width+'.png'),fullPage:true});
    await page.evaluate(()=>{document.querySelector('#manualClear').click();});
  }
  await page.evaluate(()=>{window.newAreaBrowser.setJudge(row=>new Promise(resolve=>window.finishBatch=()=>resolve({...row,decision:'검토',nearby:[]})));document.querySelector('#judgeNewAreaBatch').click();});
  await page.locator('#cancelNewAreaBatch').click();await page.evaluate(()=>window.finishBatch());assert.equal(await page.locator('#newAreaBatchInput').inputValue(),'S990001\t"합성 고객\n상세주소"\n대구광역시 동구 합성로 2\t합성 고객2\n입력\t오류\t추가열');
  assert.equal(await page.evaluate(()=>MapUiLocalBridge.state.newAreaResults.length),0);
  await page.evaluate(()=>{window.newAreaBrowser.setJudge(window.newAreaBrowser.realJudge);document.querySelector('#judgeNewAreaBatch').click();});await page.waitForFunction(()=>MapUiLocalBridge.state.newAreaResults.length===3);
  await page.locator('#newAreaBatchInput').fill('성공행\n실패행\n미완료행');
  await page.evaluate(()=>{
    window.firstPass=[];
    newAreaBrowser.setJudge(row=>{
      firstPass.push(row.address);
      if(row.address==='미완료행')return new Promise(resolve=>window.finishOldBatch=resolve);
      if(row.address==='실패행')throw Error('SYNTHETIC_RETRY');
      return {...row,decision:'O',lookupStatus:'SUCCESS',lat:37.2,lng:127};
    });
    document.querySelector('#judgeNewAreaBatch').click();
  });
  await page.waitForFunction(()=>document.querySelectorAll('[data-judged]').length===2);
  await page.locator('#cancelNewAreaBatch').click();
  assert.equal(await page.evaluate(()=>MapUiLocalBridge.state.newAreaResults.length),2);
  assert.equal(await page.locator('#retryNewAreaBatch').isEnabled(),true);
  await page.evaluate(()=>{
    window.retryPass=[];
    newAreaBrowser.setJudge(row=>{
      retryPass.push(row.address);
      return {...row,decision:'O',lookupStatus:'SUCCESS',lat:37.2,lng:127};
    });
    finishOldBatch({address:'STALE_SYNTHETIC',decision:'검토'});
  });
  await page.locator('#retryNewAreaBatch').click();
  await page.waitForFunction(()=>MapUiLocalBridge.state.newAreaResults.length===3);
  assert.deepEqual(await page.evaluate(()=>retryPass.sort()),['미완료행','실패행']);
  assert.deepEqual(await page.evaluate(()=>MapUiLocalBridge.state.newAreaResults.map(row=>row.address)),['성공행','실패행','미완료행']);
  await page.evaluate(()=>{
    newAreaBrowser.enableMapClick();
    window.manualLookups=[];
    newAreaBrowser.setJudge(row=>{
      manualLookups.push(row.customer);
      const candidates=row.customer==='후보 확인'?[{address:'합성 후보 하나',lat:37.2,lng:127},{address:'합성 후보 둘',lat:37.3,lng:127.1}]:undefined;
      return {...row,decision:'검토',lookupStatus:'DEFERRED',candidates};
    });
  });
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    const input='경기도 화성시 합성로 2\t지도 선택\n경기도 화성시 합성로 2\t후보 확인';
    await page.locator('#newAreaBatchInput').fill(input);
    await page.locator('#judgeNewAreaBatch').click();
    const first=page.locator('[data-judged="0"]'),second=page.locator('[data-judged="1"]');
    const control=page.locator('.newAreaPositionControl');
    await first.click();
    assert.equal(await control.isVisible(),true);
    const bounds=await control.boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    await control.getByRole('button',{name:'취소하고 목록으로'}).click();
    assert.equal(await page.locator('#newAreaBatchInput').inputValue(),input);
    assert.equal(await first.count(),1);
    await first.click();
    await page.locator('#map').click({position:{x:135,y:230}});
    await page.waitForFunction(()=>MapUiLocalBridge.state.newAreaResults[0]?.coordinateSource==='MAP_CLICK_TEMPORARY');
    assert.match(await first.innerText(),/임시 위치 선택 · 배송판정 검토/);
    await second.click();
    await control.getByRole('button',{name:'합성 후보 둘'}).click();
    assert.equal(await page.evaluate(()=>MapUiLocalBridge.state.newAreaResults[1]?.resolvedAddress),'합성 후보 둘');
    await page.evaluate(()=>{manualLookups.length=0;});
    await page.locator('#judgeNewAreaBatch').click();
    await first.waitFor();
    assert.deepEqual(await page.evaluate(()=>manualLookups),[]);
    assert.deepEqual(await page.evaluate(()=>MapUiLocalBridge.state.newAreaResults.map(row=>row.customer)),['지도 선택','후보 확인']);
    result.checks.push({width,manualMapClick:true,manualCandidate:true,cancelPreservesRows:true,rerunPreservesChoices:true});
    await page.screenshot({path:path.join(artifacts,'manual-results-'+width+'.png'),fullPage:true});
    await page.locator('#clearNewAreaBatch').click();
  }
  result.cancelRerun=true;result.failedAndPendingOnly=true;assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);result.externalRequests=0;result.artifacts=artifacts;console.log(JSON.stringify(result));
}catch(error){await page?.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true});console.error(JSON.stringify({artifacts,errors}));throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
