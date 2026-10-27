"""Offline DOM components only. No navigation, network, auth, real SDK or source data."""
from pathlib import Path
import json,traceback
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'reports/patch';OUT.mkdir(parents=True,exist_ok=True)
results=[];errors=[]
def check(name,value,detail=None):
 results.append({'name':name,'passed':bool(value),'detail':detail});print(('PASS ' if value else 'FAIL ')+name,flush=True)
html='''<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body>
<header><b>운영지도 · 오프라인 구성요소 검수</b><p>합성 자료 · 실제 Kakao/직원 인증/배송 조회 시험 아님</p></header>
<button id="modeDaily" aria-pressed="true">일자별 운행</button><div class="scrollside">
<details id="waypointPlanner" open><summary>경유 내비</summary><p class="plannerHelp">선택한 순서로 조회</p></details>
<section id="runListTool"><div id="runList"></div></section><button id="syncOperation">동기화</button></div>
<div class="maparea"><div id="map"></div></div>
<section id="detailSection" class="detailWrap open"><div id="detail"><div class="detailHead"><button class="detailClose">×</button><div class="code">S970009</div><div class="storeName">합성 배송지 A</div></div><div class="detailBody"><p>주소 기준 지역 권역: 수도권</p><p>도로 경로와 위치 지정 화면 확인용 합성 자료입니다.</p></div></div></section>
</body></html>'''
basecss='''body{margin:0;font-family:Arial,sans-serif;color:#172033;background:#f3f6fa}header{padding:14px 20px;background:white;border-bottom:1px solid #ddd}header p{font-size:12px;color:#64748b}.scrollside{padding:15px;width:290px;box-sizing:border-box;background:white;float:left}button,input{padding:9px;margin:3px;border:1px solid #cbd5e1;border-radius:8px;background:white;color:#172033}.maparea{margin-left:290px;position:relative}.maparea #map{height:540px;position:relative;overflow:hidden}.detailWrap{position:absolute;right:15px;top:105px;width:265px;background:white;border:1px solid #dbe1e7;border-radius:14px;padding:15px;z-index:25}.storeName{font-size:20px;font-weight:700}.code{font-size:15px;font-weight:bold;color:#2563eb}.detailClose{position:absolute;right:0;top:0}#navStopPicker{width:95%;box-sizing:border-box}.marker{position:absolute}.navRoutePoint{cursor:pointer}@media(max-width:600px){.scrollside{float:none;width:auto}.maparea{margin-left:0}.maparea #map{height:460px}.detailWrap{top:auto;bottom:12px;right:12px;left:12px;width:auto;position:relative}.navPickActions{display:flex;flex-wrap:wrap}}'''
setup='''
window.__fixtureRows=[{customerCode:'S970009',customerName:'합성 배송지 A',address:'서울 합성로 1',lat:37.5,lng:127,vehicle:'101'},{customerCode:'S970010',customerName:'합성 배송지 B',address:'서울 합성로 2',lat:37.503,lng:127.004,vehicle:'102'},{customerCode:'S970011',customerName:'합성 배송지 C',address:'서울 합성로 3',lat:37.506,lng:127.008,vehicle:'103'}];
const m=new kakao.maps.Map(document.querySelector('#map'),{center:new kakao.maps.LatLng(37.503,127.004),level:9});
window.__draft=['',''];window.__selects=[];window.__fits=0;
window.MapUiLocalBridge={state:{map:m,mode:'DATE_ROUTE',selectedVehicles:[],selected:null},navigationStores:()=>__fixtureRows,stores:()=>__fixtureRows,selectNavigationStore:code=>__selects.push(code),relayoutPreservingView(){},toggleRoadLines(){},toggleConnections:()=>({shown:false}),queryRecordedRoute(){},highlightManualLeg(){},fitNavigationBounds(){__fits++;}};
window.MapNavigationEditor={values:()=>__draft.slice(),setPoint(role,code){if(role==='origin')__draft[0]=code;else if(role==='destination')__draft[__draft.length-1]=code;else __draft.splice(__draft.length-1,0,code);window.dispatchEvent(new CustomEvent('map-navigation-draft'));},clear(){__draft=['',''];window.dispatchEvent(new CustomEvent('map-navigation-draft'));}};
window.MapDotUi={arrangeNavigation:()=>true,describeRoute:v=>v?.state==='success'?'자동차 도로 경로':'경로 조회 대기'};
'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for label,vp in [('desktop',{'width':1365,'height':900}),('mobile',{'width':390,'height':844})]:
  context=browser.new_context(viewport=vp)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  # Rendering strings does not navigate to a blocked URL or perform requests.
  context.route('**/*',lambda r:r.abort())
  try:
   page.set_content(html);page.add_style_tag(content=basecss)
   page.add_style_tag(content=(ROOT/'public/map-performance.css').read_text())
   page.add_script_tag(content=(ROOT/'tests/patch/kakao-test-double.js').read_text())
   page.add_script_tag(content=(ROOT/'public/map-view-policy.js').read_text())
   page.add_script_tag(content=(ROOT/'public/road-route-ui.js').read_text())
   page.evaluate(setup)
   page.add_script_tag(content=(ROOT/'public/navigation-ui.js').read_text())
   check(label+' navigation component initializes',page.locator('#navStopPicker').count()==1)
   rect=page.evaluate("(()=>{const a=document.querySelector('.code').getBoundingClientRect(),b=document.querySelector('.storeName').getBoundingClientRect();return {code:a.top,name:b.top}})()")
   check(label+' shipped CSS puts code above name',rect['code']<rect['name'],rect)
   for code,role in [('S970009','origin'),('S970010','waypoint'),('S970011','destination')]:
    page.locator('#navStopPicker').fill(code);page.locator('[data-nav-role="'+role+'"]').click()
   values=page.locator('#map .navRoutePoint').all_text_contents()
   check(label+' roles appear before API response',len(values)==3 and [v.split('합성')[0] for v in values]==['출발','경유 1','도착'],values)
   check(label+' selecting roles does not auto-fit camera',page.evaluate('__fits')==0)
   page.locator('#map .navRoutePoint[data-role="origin"]').click(force=True)
   check(label+' role click selects correct customer',page.evaluate('__selects.at(-1)')=='S970009')
   before=page.evaluate('__sdkCalls.overlays');page.evaluate('MapNavigation.sync();MapNavigation.sync();')
   check(label+' unchanged role overlay count is stable',page.evaluate('__sdkCalls.overlays')==before)
   page.evaluate("window.__draft=['S970009','S970011','S970010'];window.dispatchEvent(new CustomEvent('map-navigation-draft'))")
   check(label+' waypoint order updates immediately','합성 배송지 C' in page.locator('#map .navRoutePoint[data-role="waypoint"]').text_content())
   cam=page.evaluate("""(()=>{const el=document.querySelector('#map'),m=MapUiLocalBridge.state.map,c=MapViewPolicy.createCamera({map:m,element:el}),before=__sdkCalls.relayout;c.relayout();c.relayout();c.relayout();const changed=__sdkCalls.relayout-before;c.dispose();return changed})()""")
   check(label+' equal-size relayout executes once',cam==1,cam)
   page.screenshot(path=str(OUT/(label+'-components.png')),full_page=True)
   page.evaluate('MapNavigationEditor.clear()')
   check(label+' clear removes role overlays',page.locator('#map .navRoutePoint').count()==0)
   page.evaluate("MapUiLocalBridge.state.mode='BASE_60D';MapNavigation.sync()")
   check(label+' daily workspace hides in general mode',page.locator('#navigationWorkspace').is_hidden())
  except Exception as e:
   check(label+' components execution',False,str(e));(OUT/(label+'-component-error.txt')).write_text(traceback.format_exc())
  context.close()
 browser.close()
check('no unhandled component JS errors',not errors,errors)
report={'type':'OFFLINE_DOM_COMPONENTS_ONLY','realKakaoSDK':False,'fullApplication':False,'realMobileDevice':False,'networkRequests':0,'results':results,'errors':errors}
(OUT/'dom-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
