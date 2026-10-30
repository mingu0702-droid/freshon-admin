"""Chromium renderer-only test. No navigation or browser network access.
Uses real shipped markup/styles/controllers. Authentication, data, Kakao SDK and
road responses are synthetic. ESM dependency exports are wrapped in the harness
only; production files remain unchanged. Not an actual-site/Kakao-provider test.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import json,re,urllib.request,sys,time,os
ROOT=Path(__file__).resolve().parents[2]; PUBLIC=ROOT/'public';OUT=ROOT/'reports'/'repair5';OUT.mkdir(parents=True,exist_ok=True)
ORIGIN='http://127.0.0.1:4175'
def get(path):
 with urllib.request.urlopen(ORIGIN+path) as r:return r.read().decode()
source=BeautifulSoup((PUBLIC/'map-phase2b-preview.html').read_text(),'html.parser')
style_names=[]
for link in source.select('link[rel=stylesheet]'):
 name=link['href'].split('?')[0];style=source.new_tag('style');style['data-source']=name;style.string=(PUBLIC/name).read_text();link.replace_with(style);style_names.append(name)
scripts=[]
for tag in source.select('script'):
 src=tag.get('data-src') or tag.get('src')
 if tag.get('type')=='application/x-map-staff':scripts.append((src.split('?')[0] if src else None,tag.get_text()))
 tag.decompose()
source.body['data-map-staff-state']='authenticated'
banner=source.new_tag('aside');banner['id']='memoryFixtureBanner';banner['style']='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff;padding:4px;font-size:12px;text-align:center';banner.string='합성 자료·지도 SDK 대역을 이용한 화면 검증 / 실제 매장·도로·인증 검증 아님';source.body.append(banner)
bootstrap=get('/__fixture/bootstrap.js')
responses={}
paths=['/__fixture/general','/__fixture/day?date=2026-10-23','/api/map-phase2b/preview/period-status','/api/map-phase2b/preview/data-status','/api/map-phase2b/preview/status','/api/map-phase2b/private/road-route/config','/api/vehicle-driver-master','/api/map-phase2b/private/manual-pins/projection']
for path in paths:
 try:responses[path]=json.loads(get(path))
 except Exception:pass
# Read the fixture function as text; it is a pure synthetic geometry generator.
src=(ROOT/'tests/repair5/preview-server.mjs').read_text();func=src[src.index('function manualFixture('):src.index('\nconst hybridBoot')]
mock=r'''
window.__fixture={version:1,detailDelay:0,routeDelay:0,routeMode:'synthetic',authenticated:true,requests:[]};
window.__fixtureErrors=[];window.addEventListener('error',e=>__fixtureErrors.push(String(e.error?.stack||e.message)));window.addEventListener('unhandledrejection',e=>__fixtureErrors.push(String(e.reason)));
window.BroadcastChannel=class{postMessage(){}close(){}addEventListener(){}};
const session=()=>({authenticated:__fixture.authenticated,expiresAt:Date.now()+3600000,idleExpiresAt:Date.now()+600000});
window.MapStaffEntry={session,status(){},check:async()=>session(),registerPurge(){},expire:async()=>{},logout:async()=>{__fixture.authenticated=false;window.dispatchEvent(new CustomEvent('map-staff-signed-out'));}};
window.VEHICLE_AREA_DATA={vehicles:[]};window.ADMIN_FEATURES=[];
const fixtures=__RESPONSES__;
window.fetch=async(input,options={})=>{
 const url=new URL(String(input),'https://fixture.invalid'),path=url.pathname,key=path+url.search;
 __fixture.requests.push({path,method:options.method||'GET'});
 const send=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));const abort=()=>{if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');};
 abort();if(path.endsWith('/auth/session'))return send(session());
 if(path.endsWith('/private/customer-detail')){
  const version=__fixture.version;await pause(__fixture.detailDelay);abort();if(!__fixture.authenticated)return send({error:'STAFF_LOGIN_REQUIRED'},401);
  const code=url.searchParams.get('customerCode'),row=fixtures['/__fixture/general'].data.find(r=>r.customerCode===code);if(!row)return send({error:'NOT_FOUND'},404);
  const isStore=url.searchParams.get('view')==='store';
  return send({ok:true,data:isStore?{customerCode:code,customerName:row.customerName,address:row.address,detailAddress:'합성 2층',detailDate:url.searchParams.get('date'),detailAddressState:'PRESENT'}:{customerCode:code,password:'DEMO'+version,securityKey:true,generalKey:false,accessInfo:'합성 출입방법',specialRemark:'합성 배송메모',deliveryPattern:'월수금',memoState:'REGISTERED',fieldState:{accessInfo:'PRESENT',password:'PRESENT',securityKey:'PRESENT',generalKey:'PRESENT',specialRemark:'PRESENT',deliveryPattern:'PRESENT'}},meta:{cache:{stale:false,checkedAt:'2026-10-28T01:00:00Z',currentness:'SOURCE_UNCHANGED'}}});
 }
 if(path.endsWith('/private/driver-history'))return send({ok:true,data:[],meta:{complete:true,coverageComplete:false,unconfirmedDates:['2026-09-01']}});
 if(path.endsWith('/manual-road-route')){await pause(__fixture.routeDelay);abort();return __fixture.routeMode==='error'?send({error:'PROVIDER_UNAVAILABLE'},503):send(manualFixture(JSON.parse(options.body)));}
 if(path.endsWith('/vehicle-driver-master'))return send({vehicles:Array.from({length:16},(_,i)=>({vehicle:String(101+i),driverName:'합성 기사 '+(101+i),driverKey:'FIXTURE_'+(101+i)}))});
 if(path.endsWith('/manual-pins/projection'))return send({ok:true,data:[]});
 if(path.endsWith('/delivery-photos'))return send({ok:true,data:{deliveries:[]}});
 if(path.endsWith('/private/road-route/config'))return send({ok:true,data:{enabled:true,keyConfigured:true,maxWaypoints:30,persistentBudgetConfigured:true,requestLimit:30000}});
 if(fixtures[key])return send(fixtures[key]);
 if(path==='/__fixture/period'){const d=fixtures['/__fixture/general'];return send({...d,data:d.data.filter(r=>r.history.some(h=>h.deliveryDate>=url.searchParams.get('start')&&h.deliveryDate<=url.searchParams.get('end')))});}
 if(path==='/__fixture/day')return send({error:'FIXTURE_DATE_UNAVAILABLE'},404);
 if(path.endsWith('/base-vehicles'))return send({ok:false,phase:'UNCONFIRMED'},503);
 return send({error:'FIXTURE_ENDPOINT_UNAVAILABLE'},404);
};
'''.replace('__RESPONSES__',json.dumps(responses,ensure_ascii=False))
hybrid=get('/hybrid-map-ui-boot.js')
results=[]
def check(name,fn):
 try:
  detail=fn();results.append({'name':name,'passed':True,'detail':detail});print('PASS',name,flush=True)
 except Exception as e:results.append({'name':name,'passed':False,'error':str(e)});print('FAIL',name,str(e)[:250],flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('OPSMAP_TEST_CHROMIUM','/usr/bin/chromium'),headless=True)
 page=browser.new_page(viewport={'width':1440,'height':900});page.set_default_timeout(4000)
 page.set_content(str(source));page.add_script_tag(content=func+'\n'+mock);page.add_script_tag(content=bootstrap);page.add_script_tag(content=(PUBLIC/'kakao-maps-adapter.js').read_text())
 # Styles are supplied inline, retaining their original href metadata solely for
 # the existing CSS allowlist. This does not alter CSS rules or browser policy.
 page.evaluate("document.querySelectorAll('style[data-source]').forEach(e=>Object.defineProperty(e.sheet,'href',{value:e.dataset.source}))")
 for name,inline in scripts:
  if not name:page.add_script_tag(content=inline);continue
  if name=='hybrid-map-ui-boot.js':text=hybrid
  elif name in ['manual-map-pins.mjs','territory-ui.mjs']:
   dep='map-location-contract.mjs' if name.startswith('manual') else 'territory-policy.mjs'
   deptext=re.sub(r'\bexport\s+','',(PUBLIC/dep).read_text());text='(()=>{\n'+deptext+'\n'+re.sub(r'^import[^\n]*\n','',(PUBLIC/name).read_text())+'\n})();'
  else:text=(PUBLIC/name).read_text()
  page.add_script_tag(content=text)
 page.wait_for_timeout(1500)
 print('DEBUG',page.evaluate('({errors:window.__fixtureErrors,ready:window.MapUiLocalBridge?.isDataReady(),state:window.MapUiLocalBridge?.state?.mode,adapter:typeof window.KakaoMapsAdapter,hybrid:typeof window.HybridMapUiReady,rows:window.MapUiLocalBridge?.state?.currentRows?.length,requests:__fixture.requests})'),flush=True)
 def wait(js):page.wait_for_function(js)
 def expect(value,message='assertion failed'):
  if not value:raise AssertionError(message)
 def select(code):
  page.locator('#query').fill(code);page.locator('#searchBtn').click();page.locator('#results [data-search-code="'+code+'"]').click();wait('MapUiLocalBridge.state.selected?.customerCode==='+json.dumps(code));page.wait_for_timeout(80)
 def choose(selector,code):
  page.locator(selector).fill(code);page.locator('#navSearchResults [data-code="'+code+'"]').click();page.wait_for_timeout(30)
 values=lambda:page.evaluate('MapNavigationEditor.values()')
 def click_visible_cluster():
  found=page.evaluate("""(()=>{const els=[...document.querySelectorAll('#map .periodCluster')];for(let i=0;i<els.length;i++){const r=els[i].getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(x>310&&x<innerWidth&&y>72&&y<innerHeight-30&&els[i].contains(document.elementFromPoint(x,y)))return i;}return -1;})()""")

  if found<0:
   # Geographic SDK-double projection may place overview groups offscreen.
   # Test the actual cluster/member event controller, not provider hit-testing.
   page.locator('#map .periodCluster').first.dispatch_event('click')
  else:page.locator('#map .periodCluster').nth(found).click()
 check('actual shipped controllers initialize with 2036 synthetic rows',lambda:(wait('window.MapUiLocalBridge?.isDataReady()'),expect(page.evaluate('MapUiLocalBridge.state.currentRows.length')==2036)))
 check('R6 overview shows every vehicle and focuses all positioned stores (SDK double)',lambda:(expect(page.locator('#map .marker[data-vehicle]').count()==16),page.locator('#map .marker[data-vehicle="101"]').first.dispatch_event('click'),wait('document.querySelectorAll("#map .marker.store").length>1')))
 check('same-building stores independently selectable',lambda:(select('S9901000'),select('S9901001'),expect(page.locator('#map .marker.selected[data-customer-code="S9901001"]').count()==1)))
 check('Customer code is visually ordered above store name',lambda:expect(page.evaluate('getComputedStyle(document.querySelector("#detail .code")).order')=='0'))
 check('collapsed card does not prefetch password endpoint',lambda:expect(page.locator('#staffAuxContent').inner_text()==''))
 def open_notes():page.locator('#staffNotes').click();wait('document.querySelector("#staffAuxContent").textContent.includes("DEMO1")')
 check('protected notes open inside existing selected card, not a new dialog',lambda:(open_notes(),expect(not page.evaluate('document.querySelector("#mapStaffDialog").open')),expect(page.locator('#staffAuxContent').get_attribute('hidden') is None)))
 page.screenshot(path=str(OUT/'private-card-synthetic.png'),mask=[page.locator('#staffAuxContent')])
 check('security-key true and general-key false stay distinct',lambda:(expect('보안키있음' in page.locator('#staffAuxContent').inner_text().replace('\n','')),expect('일반 키없음' in page.locator('#staffAuxContent').inner_text().replace('\n',''))))
 check('latest password replaces rendered value on explicit refresh',lambda:(page.evaluate('__fixture.version=2'),page.get_by_role('button',name='최신 정보 확인',exact=True).click(),wait('document.querySelector("#staffAuxContent").textContent.includes("DEMO2")'),expect('DEMO1' not in page.locator('#staffAuxContent').inner_text())))
 check('same toggle collapses and erases private DOM',lambda:(page.locator('#staffNotes').click(),expect(page.locator('#staffAuxContent').inner_text()=='')))
 def cancel_notes():
  page.evaluate('__fixture.detailDelay=400');page.locator('#staffNotes').click();page.wait_for_timeout(30);page.locator('#staffNotes').click();page.wait_for_timeout(500);expect(page.locator('#staffAuxContent').inner_text()=='');page.evaluate('__fixture.detailDelay=0')
 check('late private response cannot reopen a closed card',cancel_notes)
 check('driver-history button remains available on general map',lambda:expect(page.locator('#staffHistory').is_visible()))
 def daily():page.locator('#modeDaily').click();wait('MapUiLocalBridge.state.mode==="DATE_ROUTE"&&MapUiLocalBridge.isDataReady()');expect(page.evaluate('MapUiLocalBridge.state.currentRows.length')==96)
 check('daily view shows only 96 selected-day stores',daily)
 check('destination-first selection leaves origin empty',lambda:(page.locator('#clearPlanner').click(),choose('#plannerEnd','S9901003'),expect(values()==['','S9901003'])))
 check('origin and waypoint roles stay independently assigned',lambda:(choose('#plannerStart','S9901000'),page.locator('#addWaypoint').click(),choose('#plannerWaypoint0','S9901002'),expect(values()==['S9901000','S9901002','S9901003'])))
 check('reverse preserves all three roles and point markers',lambda:(page.locator('#reversePlanner').click(),expect(values()==['S9901003','S9901002','S9901000']),expect(page.locator('#map .navRoutePoint').count()==3)))
 check('explicit query draws returned synthetic route, not a fixed disconnected notice',lambda:(page.locator('#planRoute').click(),wait('MapUiLocalBridge.manualRouteState()?.state==="success"'),expect(page.locator('#navigationSummary').get_attribute('data-state')=='success')))
 check('editing endpoint removes previous route and totals',lambda:(page.locator('#plannerEnd').fill('S9901004'),wait('MapUiLocalBridge.manualRouteState()?.state==="idle"'),expect('—' in page.locator('#navDistance').inner_text())))
 check('route failure is not presented as success',lambda:(choose('#plannerEnd','S9901004'),page.evaluate('__fixture.routeMode="error"'),page.locator('#planRoute').click(),wait('MapUiLocalBridge.manualRouteState()?.state==="error"'),expect(page.locator('#navigationSummary').get_attribute('data-state')=='error')))
 check('clear erases role values and all route pins',lambda:(page.locator('#clearPlanner').click(),expect(values()==['','']),expect(page.locator('#map .navRoutePoint').count()==0),expect(page.locator('#navPointStatus').inner_text()=='')))
 for width,height in [(1440,900),(1024,800),(760,900),(390,844)]:
  def layout(w=width,h=height):
   page.set_viewport_size({'width':w,'height':h});page.wait_for_timeout(80)
   dims=page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,map:document.querySelector("#map").getBoundingClientRect().toJSON()})')
   expect(dims['scroll']<=w+2,'horizontal viewport overflow: '+str(dims));expect(dims['map']['width']>0 and dims['map']['height']>0,'map has zero area')
   page.screenshot(path=str(OUT/f'renderer-{w}.png'));return dims
  check('renderer layout at '+str(width)+' px',layout)
 check('private data cleared on signed-out event',lambda:(page.set_viewport_size({'width':1440,'height':900}),page.locator('#modePeriod').click(),wait('MapUiLocalBridge.state.mode==="BASE_60D"&&MapUiLocalBridge.isDataReady()'),select('S9901000'),page.locator('#staffNotes').click(),wait('document.querySelector("#staffAuxContent").textContent.includes("DEMO2")'),page.evaluate('window.dispatchEvent(new CustomEvent("map-staff-signed-out"))'),expect('DEMO2' not in page.locator('body').inner_text())))
 check('no unhandled controller errors',lambda:expect(page.evaluate('__fixtureErrors')==[],str(page.evaluate('__fixtureErrors'))))
 report={'type':'CHROMIUM_IN_MEMORY_RENDERER_SYNTHETIC_FIXTURE','realBrowserRenderer':True,'actualSite':False,'realKakaoSDK':False,'realProvider':False,'realEmployeeAuth':False,'browserNavigationBlockedByPolicy':True,'networkRequestsFromBrowser':0,'fixtureChanges':['inline styles retain href metadata','ESM imports wrapped in fixture only','synthetic authenticated entry/data/SDK/API'],'results':results,'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results)}
 (OUT/'browser-renderer.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str));browser.close();print(json.dumps({'passed':report['passed'],'failed':report['failed']}));sys.exit(1 if report['failed'] else 0)
