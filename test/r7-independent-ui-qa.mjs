import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import express from 'express';
import {mountProductionOpsmapCandidate} from '../src/productionOpsmapCandidate.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
const boundaryOnly=process.argv.includes('--waiting-only');
const root=path.resolve('public/opsmap'),out=path.resolve('reports/r7-independent-qa');await fs.mkdir(out,{recursive:true});
const result={testedCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'INDEPENDENT_LOCAL_CHROMIUM_COMPONENT_WITH_SYNTHETIC_DISPATCH_NOT_REAL_MAP_OR_SOURCE',checks:[],errors:[],requests:[],widths:boundaryOnly?[]:[1920,1366,1024,760,390],realKakao:'NOT_TESTED',realHub:'NOT_TESTED',externalCalls:0};
const check=(name,pass,details={})=>result.checks.push({name,pass,...details});
const browser=await chromium.launch({headless:true});
try{
 for(const width of result.widths){
  const page=await browser.newPage({viewport:{width,height:844}});page.on('pageerror',e=>result.errors.push(e.message.slice(0,160)));await page.route('**/*',route=>{result.requests.push(new URL(route.request().url()).hostname);return route.abort();});
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><body class="approvedShellCandidate"><main style="width:min(360px,100%);box-sizing:border-box"><h1 style="font-size:16px">격리 QA · 합성 배차자료</h1><p>실제 지도·원천 검증이 아닙니다.</p><details id="baseVehiclePicker" open><summary>호차 선택</summary></details><input id="vehicleQuery"><button id="selectAllVehicles">전체</button><button id="clearVehicles">해제</button><div id="vehicleList" class="routechecks"></div></main></body>');
  await page.addStyleTag({content:await fs.readFile(path.join(root,'map-performance.css'),'utf8')});await page.addScriptTag({content:await fs.readFile(path.join(root,'phase2b-ui-helpers.js'),'utf8')});
  await page.evaluate(()=>{
   const codes=[['용34','',false],['122','osan',true],['202-10','yeongnam',true],['202-2','yeongnam',true],['101','osan',true],['202','yeongnam',true],['202-1','yeongnam',true],['용02','honam',true],['용01','honam',true]];
   const catalog=codes.map(([vehicle,center,verified])=>({vehicle,center,verified,region:center==='osan'?'중부':'',stale:true,checkedAt:'2026-09-24'}));
   let scope='all';const state={mode:'BASE_60D',centerFilter:'',selectedVehicles:[]};const inputs=()=>[...document.querySelectorAll('#vehicleList input')];
   const sync=()=>{state.selectedVehicles=scope==='all'?[]:inputs().filter(x=>x.checked).map(x=>x.value);window.dispatchEvent(new Event('map-vehicle-selection'));};
   for(const v of catalog){const label=document.createElement('label');label.className='vehicleItem';const input=document.createElement('input');input.type='checkbox';input.value=v.vehicle;const title=document.createElement('span');title.className='vehicleNo';title.textContent=v.vehicle+'호차';label.append(input,title);input.onchange=()=>{scope='selected';sync();};document.querySelector('#vehicleList').append(label);}
   window.MapUiLocalBridge={state,vehicleCatalog:()=>catalog,vehicleSelectionScope:()=>scope,selectVehicleGroup(values,checked){const selected=new Set(scope==='all'?inputs().map(x=>x.value):state.selectedVehicles);for(const value of values){checked?selected.add(value):selected.delete(value);}scope='selected';for(const x of inputs())x.checked=selected.has(x.value);sync();}};
   document.querySelector('#selectAllVehicles').onclick=()=>{scope='all';sync();};document.querySelector('#clearVehicles').onclick=()=>{scope='selected';for(const x of inputs())x.checked=false;sync();};
  });
  await page.addScriptTag({content:await fs.readFile(path.join(root,'vehicle-picker.js'),'utf8')});
  const tag=String(width);check(tag+' visible search above actual checkbox list',await page.locator('#vehicleQuery').isVisible()&&await page.locator('#vehicleList').isVisible());
  const order=await page.locator('[data-vehicle-group="center:yeongnam"] .vehicleItem input').evaluateAll(xs=>xs.map(x=>x.value));check(tag+' lower vehicle natural order',order.join('|')==='202|202-1|202-2|202-10',{actual:order});
  const names=await page.locator('.vehicleCenterGroup>summary').allTextContents();check(tag+' verified center grouping and explicit unknown',names.length===4&&names[0].includes('오산센터')&&names[1].includes('영남센터')&&names[2].includes('호남센터')&&names[3].includes('센터 미확인'));
  await page.locator('#clearVehicles').click();await page.locator('#vehicleQuery').fill('202-');check(tag+' partial hyphen search',await page.locator('.vehicleItem:not([hidden])').count()===3);
  await page.locator('[data-vehicle-group="center:yeongnam"]>.vehicleGroupActions button').first().click();check(tag+' group filtered selection exact',await page.locator('#vehicleList input:checked').count()===3);
  await page.locator('#vehicleQuery').fill('용');const rental=await page.locator('.vehicleItem:not([hidden]) input').evaluateAll(xs=>xs.map(x=>x.value));check(tag+' rental search plus preserved selected hidden stores',rental.length===3&&await page.locator('#vehicleList input:checked').count()===3);
  await page.getByRole('button',{name:'호차 검색 초기화',exact:true}).click();check(tag+' clear search preserves exact count',await page.locator('.vehicleItem:not([hidden])').count()===9&&(await page.locator('#vehiclePickerSelectedCount').innerText()).includes('3 / 9'));
  await page.locator('#vehicleQuery').fill('101');await page.locator('#vehicleQuery').press('Enter');check(tag+' Enter does not reset or submit selection',await page.locator('#vehicleQuery').inputValue()==='101'&&await page.locator('#vehicleList input:checked').count()===3);
  await page.getByRole('button',{name:'호차 검색 초기화',exact:true}).click();await page.locator('[data-vehicle-group="center:honam"]>summary').click();check(tag+' collapsed group hides its controls',!(await page.locator('[data-vehicle-group="center:honam"] input').first().isVisible()));await page.locator('[data-vehicle-group="center:honam"]>summary').click();
  await page.locator('#selectAllVehicles').click();check(tag+' all restores checked state',await page.locator('#vehicleList input:checked').count()===9&&(await page.locator('#vehiclePickerSelectedCount').innerText()).includes('전체 9 / 9'));
  await page.evaluate(()=>{for(let i=0;i<5;i++)window.dispatchEvent(new Event('map-vehicle-catalog'));});check(tag+' repeated data signal no duplicate controls',await page.locator('#vehicleQuery').count()===1&&await page.locator('#vehicleList input').count()===9&&await page.locator('.vehicleCenterGroup').count()===4);
  check(tag+' no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(out,'synthetic-component-'+width+'.png'),fullPage:false});await page.close();
 }
 check('no browser JavaScript errors',result.errors.length===0);check('no external requests or SDK substitution',result.requests.length===0);
 if(!boundaryOnly){
 const app=express();let sourceCalls=0;const sessionStore={get:async()=>null,set:async()=>{},touch:async()=>false,delete:async()=>{}};
 const env={OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_AUTH_ID:'qa-fixture',OPSMAP_AUTH_PASSWORD_HASH:await createStaffPasswordHash('synthetic-qa-only'),OPSMAP_AUTH_SESSION_SECRET:'a'.repeat(43),OPSMAP_AUTH_ORIGIN:'https://localhost:3000',OPSMAP_ROAD_ROUTE_ENABLED:'0'};
 const source=async()=>{sourceCalls++;throw Error('QA_EXTERNAL_SOURCE_MUST_NOT_RUN');};
 mountProductionOpsmapCandidate(app,{env,publicDir:path.resolve('public'),sessionStore,readPhase2bSnapshot:source,getSnapshotMemory:()=>null,callHub:source,phase2bKstDate:()=> '2026-10-31',normalizeCell:v=>String(v||''),normalizeDateValue:v=>String(v||''),phase2bSnapshotMeta:()=>({}),phase2bTodayStatus:source});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  for(const endpoint of ['/opsmap/api/map-phase2b/private/manual-pins/projection','/opsmap/api/map-phase2b/private/customer-detail?customerCode=S970001','/opsmap/api/map-phase2b/private/map-sdk-config','/opsmap/api/map-phase2b/preview/snapshot','/opsmap/api/map-phase2b/private/customer-search']){
   const response=await fetch(origin+endpoint);check('local candidate denies unauthenticated '+endpoint,response.status===401,{http:response.status});
  }
  check('unauthenticated requests never read Customer or Hub',sourceCalls===0);
 }finally{await new Promise(resolve=>server.close(resolve));}
 }

 if(boundaryOnly){
  const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>result.errors.push(e.message));
  await page.setContent('<body class="approvedShellCandidate"><details id="baseVehiclePicker" open><summary>호차 선택</summary></details><input id="vehicleQuery"><button id="selectAllVehicles">전체</button><button id="clearVehicles">해제</button><div id="vehicleList" class="routechecks"><label class="vehicleItem"><input type="checkbox" value="101"><span class="vehicleNo">101호차</span></label></div></body>');
  await page.addScriptTag({content:await fs.readFile(path.join(root,'phase2b-ui-helpers.js'),'utf8')});
  const runtime=await fs.readFile(path.join(root,'map-phase2b-runtime.js'),'utf8'),catalog=runtime.slice(runtime.indexOf('  function vehicleCatalog() {'),runtime.indexOf('  function synchronizeVehicleCatalog()'));
  await page.addScriptTag({content:`(() => {
   const state={mode:'BASE_60D',centerFilter:'',selectedVehicles:[]},baseVehicles=new Map([['S970001',{baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleStale:true}]]);
   let ready=false,allStores=[{vehicle:'101',vehicleGroup:'osan',baseVehicle:'101',baseVehicleGroup:'osan'}];
   const vehicleChecks=()=>[...document.querySelectorAll('#vehicleList input')],isDailyDataReady=()=>ready;
   ${catalog}
   window.MapUiLocalBridge={state,vehicleCatalog,vehicleSelectionScope:()=> 'all',selectVehicleGroup(){}};
   window.qaWaitingDaily=()=>{state.mode='DATE_ROUTE';window.dispatchEvent(new Event('map-vehicle-selection'));};
   window.qaReadyDaily=()=>{ready=true;allStores=[{vehicle:'101',dispatchCenterCode:'012',baseVehicleGroup:'osan'}];window.dispatchEvent(new Event('map-vehicle-catalog'));};
   window.qaReturnBase=()=>{state.mode='BASE_60D';window.dispatchEvent(new Event('map-vehicle-selection'));};
  })();`});
  await page.addScriptTag({content:await fs.readFile(path.join(root,'vehicle-picker.js'),'utf8')});
  check('boundary verified fixed master has Osan group',await page.locator('[data-vehicle-group="center:osan"]').count()===1);
  await page.evaluate(()=>qaWaitingDaily());check('boundary WAITING dated mode never inherits fixed-master center',await page.locator('[data-vehicle-group="center:osan"]').count()===0&&await page.locator('[data-vehicle-group="center:"]').count()===1);
  check('boundary WAITING keeps unconfirmed vehicle selectable',await page.locator('#vehicleList input[value="101"]').count()===1);
  await page.evaluate(()=>qaReadyDaily());check('boundary ready dated mode uses actual dispatch center rather than base center',await page.locator('[data-vehicle-group="center:yeongnam"]').count()===1&&await page.locator('[data-vehicle-group="center:osan"]').count()===0);
  await page.evaluate(()=>qaReturnBase());check('boundary return to base restores verified fixed center',await page.locator('[data-vehicle-group="center:osan"]').count()===1);
  check('boundary mode transitions create no duplicate controls',await page.locator('#vehicleQuery').count()===1&&await page.locator('#vehicleList input').count()===1);
  check('boundary has no JavaScript error',result.errors.length===0);await page.close();
 }
} catch(e){result.failure=e.message.slice(0,240);}finally{await browser.close();result.pass=result.checks.filter(x=>x.pass).length;result.fail=result.checks.filter(x=>!x.pass).length+(result.failure?1:0);await fs.writeFile(path.join(out,boundaryOnly?'BOUNDARY_RESULT.json':'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scope:result.scope,pass:result.pass,fail:result.fail,failure:result.failure,externalCalls:result.externalCalls}));if(result.fail)process.exitCode=1;}
