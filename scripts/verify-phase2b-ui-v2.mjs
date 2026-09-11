import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin = 'https://freshon-admin-stage-preview-template.onrender.com';
const output = process.env.PHASE2B_VERIFY_OUTPUT;
if (!output) throw new Error('PHASE2B_VERIFY_OUTPUT required');
await fs.mkdir(output, {recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const result = {at:new Date().toISOString(),errors:[],requests:[],checks:{},screenshots:[]};
if (process.env.PHASE2B_LOCAL_UI === 'true') for (const name of ['map-phase2b-preview.html','map-phase2b-runtime.js','phase2b-ui-helpers.js','phase2b-operations-ui.css']) await page.route(origin+'/'+name, route=>route.fulfill({path:path.resolve('public',name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript'}));
page.on('pageerror',error=>result.errors.push(error.message));
page.on('response',response=>{const u=new URL(response.url());if(u.origin===origin&&u.pathname.startsWith('/api/'))result.requests.push({path:u.pathname,date:u.searchParams.get('date'),status:response.status()});if(u.hostname==='dapi.kakao.com'&&u.pathname.includes('sdk'))result.sdk=response.status();});
async function shot(name){const target=path.join(output,name+'.png');await page.screenshot({path:target,fullPage:true});result.screenshots.push(target);}
async function check(name,value){result.checks[name]=value;console.log(name+': '+JSON.stringify(value));}
try{
 await page.goto(origin+'/map-phase2b-preview.html',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>document.querySelector('#freshnessState').title.includes('실제 배송 편성'),null,{timeout:120000});
 await check('date',await page.locator('#selectedDate').inputValue());
 await check('defaultOff',await page.locator('#areaToggle').getAttribute('aria-pressed')==='false');
 await page.locator('#operationVehicle').selectOption('101');
 await page.locator('.runStop').first().waitFor({timeout:60000});
 const all=await page.locator('.runStop').count();
 await page.locator('[data-run-filter="COMPLETED"]').click();const done=await page.locator('.runStop').count();
 await page.locator('[data-run-filter="PENDING"]').click();const pending=await page.locator('.runStop').count();
 await page.locator('[data-run-filter="ALL"]').click();
 await check('runFilters',{all,done,pending,sum:all===done+pending});
 await page.locator('.runStop').nth(2).click();await page.waitForTimeout(650);
 await check('listToPin',{listSelected:await page.locator('.runStop.selected').count(),pinSelected:await page.locator('.marker.selected').count(),popup:await page.locator('#detailSection').boundingBox()});
 await page.locator('#detailClose').click();
 const different=page.locator('.marker').nth(2);if(await different.count()){await different.click();await page.waitForTimeout(400);await check('pinToList',await page.locator('.runStop.selected').count()===1);}
 const tiles=()=>page.locator('#map').evaluate(el=>[...el.querySelectorAll('img')].map(x=>({src:x.src,x:x.getBoundingClientRect().x,y:x.getBoundingClientRect().y})).filter(x=>x.src.includes('map')||x.src.includes('daumcdn')));
 const before=await tiles(),pins=await page.locator('.marker').count();
 await page.locator('#areaToggle').click();await page.locator('#areaToggle').click();
 await check('toggleStable',{tiles:JSON.stringify(before)===JSON.stringify(await tiles()),pinsBefore:pins,pinsAfter:await page.locator('.marker').count()});
 await page.locator('#query').fill('S222538');await page.locator('#searchBtn').click();await page.waitForFunction(()=>document.querySelector('#searchState').textContent.includes('건'),null,{timeout:60000});await page.waitForTimeout(700);
 await check('codeSearch',await page.locator('#searchState').innerText());
 await check('font',await page.evaluate(()=>getComputedStyle(document.querySelector('.code')).fontFamily===getComputedStyle(document.querySelector('.storeName')).fontFamily));
 await check('wmsAbsent',await page.getByRole('button',{name:'WMS',exact:true}).count()===0);
 await check('layout',await page.evaluate(()=>({barX:document.querySelector('#operationBar').getBoundingClientRect().x,sidebarRight:document.querySelector('#leftPanel').getBoundingClientRect().right,mapTop:document.querySelector('#map').getBoundingClientRect().top,barBottom:document.querySelector('#operationBar').getBoundingClientRect().bottom})));
 await shot('pc');
 for(const [width,height] of [[390,844],[412,915]]){await page.setViewportSize({width,height});await page.locator('[data-sheet-tab="detail"]').click();await page.waitForTimeout(300);await check('mobile'+width,await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,sheetHeight:document.querySelector('#mobileWorkspace').getBoundingClientRect().height,bar:document.querySelector('#operationBar').getBoundingClientRect().height})));await shot('mobile-'+width);await page.locator('[data-sheet-tab="runs"]').click();await check('mobileRuns'+width,await page.locator('#mobileSheetContent .runStop').count());}
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('#query').fill('준코 구리');await page.locator('#searchBtn').click();await page.waitForFunction(()=>!document.querySelector('#searchState').textContent.includes('검색 중'),null,{timeout:60000});await check('nameSearch',await page.locator('#searchState').innerText());
 await page.locator('#addressQuery').fill('서울 중구 세종대로 110');await page.locator('#addressBtn').click();await page.waitForFunction(()=>document.querySelector('#addressJudgeResults').textContent.includes('권역판정'),null,{timeout:30000});await check('address',await page.locator('#searchNotice').innerText());await check('500m',await page.locator('#addressJudgeResults').innerText());await check('30km',await page.locator('#nearWrap').innerText());
 await page.locator('#openOperations').click();await page.locator('.diagnosticTable').waitFor({timeout:15000});await check('diagnostics',await page.locator('.diagnosticTable tr').count());
 await page.locator('#selectedDate').fill('2026-08-11');await page.locator('#selectedDate').dispatchEvent('change');await page.waitForFunction(()=>document.querySelector('#freshnessState').textContent.includes('과거')||document.querySelector('#freshnessState').textContent.includes('실패'),null,{timeout:130000});await check('historicalAssignment',await page.locator('#freshnessState').innerText());
 await page.locator('#operationVehicle').selectOption('101');await page.waitForFunction(()=>document.querySelector('#opTotal').textContent==='27',null,{timeout:60000});await check('historicalRoute',await page.evaluate(()=>['opTotal','opCompleted','opRemaining','opEta'].map(id=>document.getElementById(id).textContent)));await shot('historical');
}catch(error){result.errors.push(error.message);await shot('error').catch(()=>{});}
finally{await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));await browser.close();console.log(JSON.stringify(result));}
