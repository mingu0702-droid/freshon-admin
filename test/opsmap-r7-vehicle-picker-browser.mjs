// Local Chromium component test. Synthetic dispatch evidence is not a real Kakao/Production PASS.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true});const page=await browser.newPage();page.on('pageerror',error=>console.error('FIXTURE_PAGE_ERROR',error.message));
const root=new URL('../public/',import.meta.url);let assertions=0;const check=(condition,message)=>{assert.ok(condition,message);assertions++;};
try{
  await page.setContent('<body class="approvedShellCandidate layout-B dotRestored"><div id="r7PickerHost" style="width:267px;max-width:100%"><details id="baseVehiclePicker" open><summary>호차 선택</summary><div id="legacyVehicleState">선택 없음기간별 매장</div></details></div><input id="vehicleQuery"><button id="selectAllVehicles">전체</button><button id="clearVehicles">해제</button><div id="vehicleList" class="routechecks"></div></body>');
  const shell=await fs.readFile(new URL('map-approved-shell-candidate.js',root),'utf8');
  const retainedStyles=JSON.parse(shell.match(/const retainedStyles=(\[[^;]+\]);/)[1].replaceAll("'",'"'));
  const html=await fs.readFile(new URL('map-phase2b-preview.html',root),'utf8');
  const stylesheetOrder=[...html.matchAll(/<link\b[^>]*href="([^"?]+)[^"]*"/g)].map(match=>match[1]).filter(name=>retainedStyles.includes(name));
  check(new Set(stylesheetOrder).size===retainedStyles.length,'all retained real-page stylesheets included');
  // Preserve the actual HTML cascade order instead of testing the final CSS alone.
  for(const name of stylesheetOrder)await page.addStyleTag({content:await fs.readFile(new URL(name,root),'utf8')});
  await page.addScriptTag({content:await fs.readFile(new URL('phase2b-ui-helpers.js',root),'utf8')});
  await page.evaluate(()=>{
    const catalog=[['용34',''],['202-2','yeongnam'],['101','osan'],['202','yeongnam'],['202-1','yeongnam'],['122','honam'],['용01','osan']].map(([vehicle,center])=>({vehicle,center,region:'',stale:true,checkedAt:'2026-09-24',verified:!!center}));
    let scope='all';const state={mode:'BASE_60D',centerFilter:'',selectedVehicles:[]};
    const inputs=()=>[...document.querySelectorAll('#vehicleList input')];
    function sync(){state.selectedVehicles=scope==='all'?[]:inputs().filter(x=>x.checked).map(x=>x.value);window.dispatchEvent(new Event('map-vehicle-selection'));}
    for(const item of catalog){const label=document.createElement('label');label.className='vehicleItem';label.innerHTML='<input type="checkbox"><span class="vehicleNo"></span><span class="vehicleArea">기준일 편성</span>';label.querySelector('input').value=item.vehicle;label.querySelector('.vehicleNo').textContent=item.vehicle+'호차';label.querySelector('input').onchange=()=>{scope='selected';sync();};document.querySelector('#vehicleList').append(label);}
    window.MapUiLocalBridge={state,vehicleCatalog:()=>catalog.slice().sort((a,b)=>Phase2bUi.compareVehicles(a.vehicle,b.vehicle)),vehicleSelectionScope:()=>scope,selectVehicleGroup(values,checked){const selected=new Set(scope==='all'&&!checked?inputs().map(x=>x.value):state.selectedVehicles);for(const value of values){if(checked)selected.add(value);else selected.delete(value);}scope='selected';for(const input of inputs())input.checked=selected.has(input.value);sync();}};
    document.querySelector('#selectAllVehicles').onclick=()=>{scope='all';sync();};document.querySelector('#clearVehicles').onclick=()=>{scope='selected';for(const input of inputs())input.checked=false;sync();};
  });
  await page.addScriptTag({content:await fs.readFile(new URL('vehicle-picker.js',root),'utf8')});
  const panel=await page.locator('#baseVehiclePicker').evaluate(e=>{const c=e.querySelector('.vehiclePickerControls'),s=getComputedStyle(c);return{width:e.clientWidth,scrollWidth:e.scrollWidth,marginLeft:s.marginLeft,marginRight:s.marginRight};});
  check(panel.width===267&&panel.scrollWidth<=panel.width,'267px actual-styles picker has no horizontal clipping: '+JSON.stringify(panel));
  check(panel.marginLeft==='0px'&&panel.marginRight==='0px','picker section does not inherit global horizontal section margins');
  check(!(await page.locator('#legacyVehicleState').isVisible()),'legacy state controller retained in DOM without duplicate visible summary');
  const unclipped=await page.locator('#baseVehiclePicker').evaluate(e=>{const box=e.getBoundingClientRect();return[...e.querySelectorAll('#vehicleQuery,.vehicleSearchLine button,#vehicleList,#selectAllVehicles,#clearVehicles')].every(n=>{const r=n.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1;});});
  check(unclipped,'search/reset/list/actions remain inside the 267px picker');
  check(await page.getByRole('searchbox',{name:'호차번호 검색',exact:true}).isVisible(),'search is visible above actual checkbox list');
  check((await page.locator('.vehicleCenterGroup>summary').allTextContents()).map(x=>x.replace(/\d+대$/,'')).join('|')==='오산센터|영남센터|호남센터|센터 미확인','verified center groups ordered');
  check((await page.locator('.vehicleCenterGroup[data-vehicle-group="center:yeongnam"] input').evaluateAll(inputs=>inputs.map(x=>x.value))).join(',')==='202,202-1,202-2','sub-vehicles numeric ordered');
  check((await page.locator('#vehiclePickerSelectedCount').textContent()).includes('전체 7 / 7'),'all-view has checked boxes and count');
  await page.locator('#clearVehicles').click();await page.locator('#vehicleQuery').fill('202');
  check(await page.locator('.vehicleItem:not([hidden])').count()===3,'partial numeric filter');
  await page.locator('.vehicleCenterGroup[data-vehicle-group="center:yeongnam"]>.vehicleGroupActions button').first().click();
  check(await page.locator('#vehicleList input:checked').count()===3,'group selection');
  await page.locator('#vehicleQuery').fill('용');check(await page.locator('.vehicleItem:not([hidden])').count()===2,'rental filter preserves letters');
  check(await page.locator('#vehicleList input:checked').count()===3,'filter retains previous selection');
  await page.getByRole('button',{name:'호차 검색 초기화'}).click();check(await page.locator('.vehicleItem:not([hidden])').count()===7,'reset restores all options');
  await page.locator('.vehicleCenterGroup[data-vehicle-group="center:yeongnam"]>summary').click();check(!(await page.locator('.vehicleCenterGroup[data-vehicle-group="center:yeongnam"] input').first().isVisible()),'group collapse');
  await page.locator('.vehicleCenterGroup[data-vehicle-group="center:yeongnam"]>summary').click();
  await page.evaluate(()=>{MapUiLocalBridge.state.centerFilter='honam';window.dispatchEvent(new Event('map-vehicle-selection'));});
  check(await page.locator('.vehicleItem:not([hidden])').count()===1,'center selection and search intersect');
  await page.evaluate(()=>{MapUiLocalBridge.state.centerFilter='';window.dispatchEvent(new Event('map-vehicle-selection'));});
  for(const width of [1920,1366,1024,760,390]){await page.setViewportSize({width,height:844});check(await page.locator('#vehicleQuery').isVisible(),'search visible '+width);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow '+width);}
  const runtime=await fs.readFile(new URL('map-phase2b-runtime.js',root),'utf8');
  const dynamicFunctions=runtime.slice(runtime.indexOf('  function ensureDateVehicles()'),runtime.indexOf('  function normalizeStore('));
  await page.addScriptTag({content:`(() => {
    const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],state=MapUiLocalBridge.state;
    const initial=MapUiLocalBridge.vehicleCatalog();
    let allStores=[],baseVehicles=new Map(initial.map((x,i)=>[String(i),{baseVehicle:x.vehicle,baseVehicleGroup:x.center,baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleStale:true,baseVehicleCheckedAt:'2026-09-24T00:00:00Z'}]));
    const vehicleChecks=()=>$$('#vehicleList input[type=checkbox]'),vehicleLabel=Phase2bUi.normalizeVehicleLabel,isDailyDataReady=()=>false;
    const esc=x=>String(x).replace(/[&<>"']/g,'');const refreshVehicleUi=()=>{};let periodVehicleScope='selected';
    ${dynamicFunctions}
    for(const id of ['vehicle','mobileVehicle','operationVehicle','mobileBaseVehicle']){const select=document.createElement('select');select.id=id;select.append(new Option('전체',''));document.body.append(select);}
    MapUiLocalBridge.vehicleCatalog=vehicleCatalog;
    window.r7AppendVehicles=rows=>{allStores=rows;ensureDateVehicles();};
  })();`});
  await page.evaluate(()=>r7AppendVehicles([{baseVehicle:'202-10',vehicle:'용02',history:[{vehicle:'202-3'}]}]));
  check(await page.locator('#vehicleList input').count()===10,'dated additions use the same catalog without loss');
  const added=await page.locator('.vehicleItem').evaluateAll(items=>items.map(item=>item.querySelector('input').value));
  check(added.filter(x=>x.startsWith('202')).join(',')==='202,202-1,202-2,202-3,202-10','dated additions re-sort existing labels');
  await page.evaluate(()=>r7AppendVehicles([{baseVehicle:'202-10',vehicle:'용02',history:[{vehicle:'202-3'}]}]));
  check(await page.locator('#vehicleList input').count()===10,'repeated dated refresh creates no duplicate checkbox');
  await page.evaluate(()=>{MapUiLocalBridge.state.mode='DATE_ROUTE';window.dispatchEvent(new Event('map-vehicle-selection'));});
  check(await page.locator('.vehicleCenterGroup').count()===1&&(await page.locator('.vehicleCenterGroup>summary').innerText()).startsWith('센터 미확인'),'unready dated assignments do not inherit historical fixed-center groups');
  check((await page.locator('#vehicleEvidenceNote').textContent()).includes('선택한 배송일'),'mode change updates evidence without waiting for a successful dated fetch');
  await page.evaluate(()=>{MapUiLocalBridge.state.mode='BASE_60D';window.dispatchEvent(new Event('map-vehicle-selection'));});
  check(!(await page.locator('#vehicleList').innerText()).includes('기준일 편성'),'per-row repeated source text removed');
  check((await page.locator('#vehicleEvidenceNote').textContent()).includes('이전 확인값'),'stale evidence is not current master');
  console.log(JSON.stringify({scope:'LOCAL_CHROMIUM_SYNTHETIC_COMPONENT_ONLY',pass:assertions,fail:0,realKakao:'NOT_TESTED',Production:'NOT_CHANGED'}));
}finally{await browser.close();}
