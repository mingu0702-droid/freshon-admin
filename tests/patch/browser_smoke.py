"""Full shipped HTML/JS in Chromium, synthetic data and SDK double. No external IO."""
from pathlib import Path
import json,time,traceback,sys,mimetypes
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from functools import partial
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]; PUBLIC=ROOT/'public'; OUT=ROOT/'reports'/'patch';OUT.mkdir(exist_ok=True)
SERVER=ThreadingHTTPServer(('127.0.0.1',0),partial(SimpleHTTPRequestHandler,directory=str(PUBLIC)))
Thread(target=SERVER.serve_forever,daemon=True).start()
ORIGIN='http://127.0.0.1:'+str(SERVER.server_port)
DAY='2026-10-23'; VERSION='a'*64
rows=[dict(customerCode=f'S{9901000+i}',customerName=f'합성 매장 {i+1}',address=f'서울 가상로 {i+1}',customerAddress=f'서울 가상로 {i+1}',lat=37.40+(i%14)*.012,lng=126.9+(i//14)*.013,vehicle=str(101+i%12),baseVehicle=str(101+i%12),baseVehicleGroup='osan',addressRegion='수도권',deliveryDate=DAY,lastDeliveryDate=DAY,driverName='합성 기사',history=[dict(deliveryDate=DAY,vehicle=str(101+i%12),count=1,driverName='합성 기사')]) for i in range(2036)]
store={r['customerCode']:r for r in rows};results=[];errors=[];requests=[]
def record(name,passed,detail=''):
 results.append({'name':name,'passed':bool(passed),'detail':detail});print(('PASS ' if passed else 'FAIL ')+name,flush=True)
def response_data(path,qs,post):
 if '/auth/session' in path or '/auth/login' in path:return dict(authenticated=True,configured=True,expiresAt=int(time.time()*1000)+12*3600000,idleExpiresAt=int(time.time()*1000)+8*3600000)
 if '/auth/logout' in path:return dict(authenticated=False)
 if path.endswith('/base-vehicles'):
  codes=qs.get('customerCodes',[''])[0].split(',') if qs.get('customerCodes') else post.get('customerCodes',list(store))
  data=[]
  for c in codes:
   if c not in store:continue
   r=store[c];data.append(dict(customerCode=c,baseVehicle=r['baseVehicle'],baseVehicleGroup='osan',baseVehicleState='VERIFIED_MASTER',baseVehicleSource='FIXED_DISPATCH_PRIMARY',baseVehicleVersion=VERSION,baseVehicleCheckedAt=DAY,baseVehicleStale=False))
  return dict(ok=True,data=data,meta=dict(version=VERSION,checkedAt=DAY,stale=False,basis='FIXED_DISPATCH_PRIMARY',refresh='IDLE'))
 if path.endswith('/private/customer-detail'):
  c=qs.get('customerCode',[''])[0];r=store.get(c,rows[0]);date=qs.get('date',[DAY])[0]
  if qs.get('view')==['store']:return dict(ok=True,data=dict(customerCode=c,customerName=r['customerName'],address=r['address'],detailAddress='합성 상세 2층',detailAddressState='PRESENT',detailDate=date,addressRegion='수도권',deliveryPattern='월수금',sourceBasis='STORED_DAY',sourceDate=DAY))
  return dict(ok=True,data=dict(customerCode=c,password='SYNTHETIC-1234',accessInfo='합성 배송지',specialRemark='합성 특이사항',deliveryPattern='월수금'),meta=dict(cache=dict(stale=True,checkedAt='2026-10-23T00:00:00Z',refreshing=False)))
 if path.endswith('/manual-pins/projection'):return dict(ok=True,data=[])
 if path.endswith('/manual-road-route'):
  pts=[post['origin'],*post['waypoints'],post['destination']];n=len(pts)-1
  return dict(ok=True,data=dict(mode='MANUAL_WAYPOINTS',requestId=post['requestId'],source='kakao-directions',isGpsActual=False,state='success',complete=True,totalLegs=n,coveredLegs=n,distanceMeters=n*1000,durationSeconds=n*60,legs=[dict(index=i,distanceMeters=1000,durationSeconds=60) for i in range(n)],chunks=[dict(state='success',startLeg=0,endLeg=n-1,geometry=[dict(legOffset=i,latLngs=[[pts[i]['lat'],pts[i]['lng']],[pts[i]['lat']+.001,pts[i]['lng']+.0003],[pts[i+1]['lat'],pts[i+1]['lng']]]) for i in range(n)])]))
 if path.endswith('/vehicle-driver-master'):return dict(vehicles=[dict(vehicle=str(101+i),driverName='합성 기사 '+str(i)) for i in range(12)])
 if path.endswith('/data-status'):return dict(data=dict(customer={'freshon':DAY,'delivery':DAY},published={'endDate':DAY},live={'ready':True,'generation':'fixture1','periodLatest':DAY},job=None))
 if path.endswith('/status'):return dict(snapshot=dict(latest=DAY,stale=False))
 if path.endswith('/manual-pins'):return dict(ok=True,data=[])
 return dict(ok=True,data=[],meta=dict(complete=True,date=DAY))
meta=dict(latestDate=DAY,date=DAY,startDate=DAY,endDate=DAY,complete=True,displayComplete=True,reviewOnly=True)
boot='''window.HybridMapUiReady=Promise.resolve({createHybridMapUiAdapter:()=>({
 readCachedGeneral:async()=>null,readGeneral:async()=>window.__fixtureEnvelope,refreshLatest:async()=>({ready:false}),readDate:async(date)=>({...window.__fixtureEnvelope,meta:{...window.__fixtureEnvelope.meta,date}}),readDateStatus:async()=>({ready:true,completedThrough:'2026-10-23'}),readPeriodStatus:async()=>({ready:true}),closePeriod(){},cancel(){},dispose(){},logout:async()=>{},readCachedDay:async()=>null})});'''

def run(viewport,name):
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  context=browser.new_context(viewport=viewport,is_mobile=(name=='mobile'),has_touch=(name=='mobile'))
  context.add_init_script((ROOT/'tests/patch/kakao-test-double.js').read_text())
  context.add_init_script('window.__fixtureEnvelope='+json.dumps(dict(data=rows,meta=meta),ensure_ascii=False)+';')
  def handle(route):
   req=route.request;u=urlparse(req.url);path=u.path;qs=parse_qs(u.query);post={}
   if req.post_data:
    try:post=json.loads(req.post_data)
    except:pass
   if u.netloc!=urlparse(ORIGIN).netloc:route.fulfill(status=200,content_type='application/javascript',body='window.XLSX={};');return
   if path.startswith('/api/'):
    requests.append({'path':path,'method':req.method});route.fulfill(status=200,content_type='application/json',body=json.dumps(response_data(path,qs,post),ensure_ascii=False));return
   if path=='/vehicle-data.js':route.fulfill(content_type='application/javascript',body='window.VEHICLE_AREA_DATA={vehicles:[]};');return
   if path=='/admin-features.js':route.fulfill(content_type='application/javascript',body='window.ADMIN_FEATURES=[];');return
   if path=='/hybrid-map-ui-boot.js':route.fulfill(content_type='application/javascript',body=boot);return
   f=PUBLIC/(path.lstrip('/') or 'map-phase2b-preview.html')
   if not f.is_file():route.fulfill(status=404,body='not found');return
   c='text/javascript' if f.suffix in ('.js','.mjs') else mimetypes.guess_type(str(f))[0] or 'application/octet-stream'
   route.fulfill(content_type=c,body=f.read_bytes())
  context.route('**/*',handle);page=context.new_page();page.on('pageerror',lambda e:errors.append({'viewport':name,'error':str(e)}))
  try:
   page.goto(ORIGIN+'/',wait_until='networkidle',timeout=20000)
   page.wait_for_function("window.MapUiLocalBridge?.state.map && document.body.dataset.mapStaffState==='authenticated'",timeout=10000)
   page.wait_for_timeout(400)
   record(name+' full application boot',True)
   active=page.evaluate("document.querySelectorAll('#map .marker').length")
   record(name+' zoomed-out overlays bounded',active<=220,str(active))
   # Inspect actual shipped detail markup and CSS.
   page.evaluate("MapUiLocalBridge.selectNavigationStore('S970009')")
   page.wait_for_timeout(150)
   order=page.evaluate("(()=>{let a=document.querySelector('#detail .code').getBoundingClientRect(),b=document.querySelector('#detail .storeName').getBoundingClientRect();return {code:a.top,name:b.top,text:document.querySelector('#detail').textContent}})()")
   record(name+' code above store title',order['code']<order['name'])
   record(name+' no irrelevant operation status in store card','운행 상태' not in order['text'])
   record(name+' selected Customer detail loaded','합성 상세 2층' in order['text'])
   page.evaluate("MapUiLocalBridge.state.map.setLevel(10)")
   page.wait_for_timeout(100)
   before=page.evaluate("({...__sdkCalls})")
   page.evaluate("document.querySelector('#map').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,clientX:700,clientY:300,bubbles:true,cancelable:true}))")
   page.wait_for_timeout(600)
   after=page.evaluate("({...__sdkCalls})")
   record(name+' wheel does not cause automatic bounds reset',after['setBounds']==before['setBounds'],str({'before':before,'after':after}))
   # Daily navigation uses the same application, not a separate invented component.
   page.locator('#modeDaily').click(force=True);page.wait_for_timeout(200)
   record(name+' daily marker cap',page.evaluate("document.querySelectorAll('#map .marker').length")<=220)
   page.evaluate("MapNavigationEditor.setPoint('origin','S970009');MapNavigationEditor.setPoint('waypoint','S970010');MapNavigationEditor.setPoint('destination','S970011')")
   page.wait_for_timeout(100)
   labels=page.locator('#map .navRoutePoint').all_text_contents()
   record(name+' roles visible before route lookup',len(labels)==3 and any(x.startswith('출발') for x in labels) and any(x.startswith('경유 1') for x in labels) and any(x.startswith('도착') for x in labels),str(labels))
   page.evaluate("document.querySelector('#waypointPlanner').open=true")
   page.locator('#planRoute').click(force=True);page.wait_for_timeout(200)
   record(name+' existing route controller succeeds',page.evaluate("MapUiLocalBridge.manualRouteState()?.state")=='success')
   record(name+' provider road geometry drawn',page.evaluate('__sdkCalls.lines')>=2)
   page.locator('#clearPlanner').click(force=True);page.wait_for_timeout(100)
   record(name+' clear removes role labels',page.locator('#map .navRoutePoint').count()==0)
   if name=='mobile':
    page.set_viewport_size({'width':844,'height':390});page.wait_for_timeout(200);page.evaluate("MapUiLocalBridge.selectNavigationStore('S970009')");page.wait_for_timeout(100)
    dimensions=page.evaluate("(()=>{const r=document.querySelector('#detailSection').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()")
    record(name+' landscape panel within viewport',dimensions['left']>=-1 and dimensions['right']<=dimensions['width']+1,str(dimensions))
   page.screenshot(path=str(OUT/(name+'-component.png')),full_page=False)
  except Exception as e:
   record(name+' browser flow',False,str(e));(OUT/(name+'-failure.txt')).write_text(traceback.format_exc());page.screenshot(path=str(OUT/(name+'-failure.png')),full_page=False)
  finally:
   (OUT/(name+'-dom.html')).write_text(page.content(),encoding='utf8');browser.close()

run({'width':1440,'height':900},'desktop')
run({'width':390,'height':844},'mobile')
record('no unhandled JavaScript errors',not errors,json.dumps(errors,ensure_ascii=False))
report={'type':'CHROMIUM_COMPONENT_TEST_WITH_SYNTHETIC_DATA_AND_KAKAO_TEST_DOUBLE','realKakaoSDK':False,'externalSourceCalls':0,'results':results,'pageErrors':errors,'requests':requests}
(OUT/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));sys.exit(0 if all(x['passed'] for x in results) else 1)
