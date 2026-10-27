/**
 * Local DOM / interaction fixture only. No upstream network IO.
 * Ships the real public HTML/JS/CSS unchanged except for test-only bootstrap,
 * SDK/data/auth substitutions and an unmistakable synthetic-preview banner.
 * Synthetic route geometry is NOT a real road or provider-success verification.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');
export const DAY = '2026-10-23';
const VERSION = 'a'.repeat(64);
const LABEL = '화면·동작 검증 전용 | 합성 2,036매장 / 10·23 방문 96매장 | 실제 지도·실제 도로경로가 아닙니다';
const META = {date:DAY,latestDate:DAY,startDate:'2026-09-01',endDate:DAY,complete:true,displayComplete:true,reviewOnly:true,coverageComplete:false,businessCoverageVerified:false,published:false,source:'SYNTHETIC_DOM_FIXTURE',sourceObservedAt:'2026-10-23T10:00:00+09:00'};
const fixtureNames = ['가상베이글 오산점','가상카페 오산점','가상식당 세교점','가상분식 동탄점','가상제과 병점점','가상식당 원동점','가상카페 수원점','가상마트 화성점'];
export const generalRows = Array.from({length:2036},(_,index)=>{
  const n=index+1, center=index%23===0?'honam':index%19===0?'yeongnam':'osan';
  const anchor=center==='honam'?[35.15,126.85]:center==='yeongnam'?[35.20,128.95]:[37.12,126.97];
  const sameBuilding=index===0||index===1;const missing=index>0&&index%47===0;
  const lat=sameBuilding?37.1535:anchor[0]+(index%32)*.009,lng=sameBuilding?127.0702:anchor[1]+(Math.floor(index/32)%32)*.009;
  const vehicle=String(101+index%16),date=index<96?DAY:index%2?'2026-10-01':'2026-09-20';
  const address=sameBuilding?'경기도 오산시 합성로 100':`${center==='osan'?'경기도 오산시':center==='honam'?'광주광역시':'부산광역시'} 합성로 ${n}`;
  return {customerCode:'S'+String(9901000+index),customerName:index<fixtureNames.length?fixtureNames[index]:`합성 매장 ${n}`,address,customerAddress:address,detailAddress:index===1?'같은 건물 2층':'',lat:missing?null:lat,lng:missing?null:lng,coordinateStatus:missing?'UNCONFIRMED':'VERIFIED',coordinateSource:missing?'UNCONFIRMED':'SYNTHETIC_FIXTURE',coordinateAccuracy:'BUILDING',vehicle,confirmedVehicle:vehicle,actualVehicle:vehicle,baseVehicle:vehicle,baseVehicleGroup:center,baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:VERSION,baseVehicleStale:false,baseVehicleCheckedAt:DAY,dispatchCenterCode:({osan:'011',yeongnam:'012',honam:'013'})[center],addressRegion:center==='osan'?'수도권':center==='honam'?'호남권':'영남권',deliveryDate:date,lastDeliveryDate:date,deliveryCount:1,order:Math.floor(index/16)+1,status:index%3===0?'COMPLETED':'PENDING',driverName:'합성 기사 '+vehicle,driverKey:'FIXTURE_'+vehicle,history:[{deliveryDate:date,vehicle,driverName:'합성 기사 '+vehicle,driverKey:'FIXTURE_'+vehicle,count:1,deliveryCount:1}],residentSummary:{verified:true,count:1,lastDeliveryDate:date}};
});
export const dailyRows = generalRows.filter(row=>row.history.some(item=>item.deliveryDate===DAY)).map(row=>({...row,history:row.history.filter(item=>item.deliveryDate===DAY),relations:row.history.filter(item=>item.deliveryDate===DAY)}));
const byCode = new Map(generalRows.map(row=>[row.customerCode,row]));
const periods = {ready:false,completionVerified:false,reviewOnly:true,availableReviewDate:DAY};
const fixtureCenters = [
  {id:'osan',lat:37.14,lng:127.065,address:'합성 오산센터 위치'},
  {id:'yeongnam',lat:35.19,lng:128.94,address:'합성 영남센터 위치'},
  {id:'honam',lat:35.14,lng:126.84,address:'합성 호남센터 위치'}
].map(center=>({...center,verified:true,sourceVersion:'SYNTHETIC_ONLY'}));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.json':'application/json; charset=utf-8'};

function manualFixture(body){
  const points=[body.origin,...(body.waypoints||[]),body.destination];
  if(points.length<2||points.length>32||points.some(p=>!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)))return {ok:false,error:'INVALID_MANUAL_ROUTE'};
  const stationaryLegs=[],legs=[],geometry=[];
  for(let i=0;i<points.length-1;i++){
    const a=points[i],b=points[i+1],stationary=a.lat===b.lat&&a.lng===b.lng;
    if(stationary)stationaryLegs.push(i);
    const distanceMeters=stationary?0:1000+i*120,durationSeconds=stationary?0:60+i*15;
    legs.push({index:i,distanceMeters,durationSeconds});
    if(!stationary)geometry.push({legOffset:i,latLngs:[[a.lat,a.lng],[a.lat,(a.lng+b.lng)/2],[b.lat,(a.lng+b.lng)/2],[b.lat,b.lng]]});
  }
  const n=points.length-1,noDrivingRequired=stationaryLegs.length===n;
  return {ok:true,fixture:true,verification:'DOM_ONLY_NOT_REAL_PROVIDER',data:{mode:'MANUAL_WAYPOINTS',requestId:body.requestId,source:noDrivingRequired?'stationary-stops':'kakao-directions',isGpsActual:false,state:'success',complete:true,totalLegs:n,coveredLegs:n,stationaryLegs,noDrivingRequired,distanceMeters:legs.reduce((s,p)=>s+p.distanceMeters,0),durationSeconds:legs.reduce((s,p)=>s+p.durationSeconds,0),legs,chunks:[{state:'success',startLeg:0,endLeg:n-1,geometry}]}};
}

const hybridBoot = `/* SYNTHETIC DOM FIXTURE. No application controller is replaced. */
window.HybridMapUiReady=Promise.resolve({createHybridMapUiAdapter:({onState=()=>{}}={})=>{
  const read=async(path)=>{const r=await fetch('/__fixture/'+path,{cache:'no-store'});if(!r.ok)throw Error('FIXTURE_DATE_UNAVAILABLE');return r.json();};
  return {readCachedGeneral:async()=>null,readCachedDay:async()=>null,
    readGeneral:async()=>{const r=await read('general');onState({state:'ready'});return r;},
    readDate:async(date)=>{const r=await read('day?date='+encodeURIComponent(date));onState({state:'ready'});return r;},
    refreshLatest:async()=>(${JSON.stringify(periods)}),readPeriodStatus:async()=>(${JSON.stringify(periods)}),readDateStatus:async()=>(${JSON.stringify(periods)}),
    readPeriodWindow:async(start,end)=>read('period?start='+encodeURIComponent(start)+'&end='+encodeURIComponent(end)),
    closePeriod(){},cancel(){},dispose(){},logout:async()=>{onState({state:'logged-out'});}};
}});`;

export async function createPreviewServer(){
  const state={routeMode:'synthetic',routeDelayMs:150,authenticated:true,requests:[],routeRequests:0,externalRequests:0};
  const sdk=await fs.readFile(path.join(ROOT,'tests/patch/kakao-test-double.js'),'utf8');
  const bootstrap=`${sdk}\nwindow.MAP_ROLLING_DATE_INDEX_ENABLED=true;window.LOCAL_REVIEW_CONFIG=${JSON.stringify({date:DAY,currentStoredReview:true,startDate:'2026-09-01',endDate:DAY,privateCustomerSearch:false,syntheticFixture:true})};window.KAKAO_MAP_CONFIG=${JSON.stringify({centers:fixtureCenters})};window.__DOM_FIXTURE__=${JSON.stringify({synthetic:true,date:DAY,generalCount:generalRows.length,dayCount:dailyRows.length,realKakaoSDK:false,realProvider:false})};window.__fixtureErrors=[];window.addEventListener('error',e=>window.__fixtureErrors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__fixtureErrors.push(String(e.reason)));`;
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');const pathname=decodeURIComponent(url.pathname);
      state.requests.push({method:req.method,path:pathname,time:Date.now()});if(state.requests.length>600)state.requests.shift();
      const common={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Fixture-Only':'synthetic-dom-not-provider',
        'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'"};
      const send=(value,status=200,type='application/json; charset=utf-8')=>{res.writeHead(status,{...common,'Content-Type':type});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
      let body={};if(['POST','PUT','PATCH'].includes(req.method)){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536){send({ok:false,error:'REQUEST_TOO_LARGE'},413);return;}}try{body=raw?JSON.parse(raw):{};}catch{send({ok:false,error:'INVALID_JSON'},400);return;}}
      if(pathname==='/__fixture/state'){if(req.method==='POST'){if(['synthetic','error'].includes(body.routeMode))state.routeMode=body.routeMode;if(Number.isInteger(body.routeDelayMs)&&body.routeDelayMs>=0&&body.routeDelayMs<=30000)state.routeDelayMs=body.routeDelayMs;}
        send({...state,generalCount:generalRows.length,dayCount:dailyRows.length,availableReviewDate:DAY,realKakaoSDK:false,realProvider:false});return;}
      if(pathname==='/__fixture/bootstrap.js'){send(bootstrap,200,types['.js']);return;}
      if(pathname==='/__fixture/xlsx-disabled.js'){send('/* External spreadsheet library intentionally unavailable in this DOM fixture. */ window.XLSX=undefined;',200,types['.js']);return;}
      if(pathname==='/__fixture/general'){send({ok:true,data:generalRows,meta:META});return;}
      if(pathname==='/__fixture/day'){
        const date=url.searchParams.get('date');if(date!==DAY){send({ok:false,error:'FIXTURE_DATE_UNAVAILABLE',availableReviewDate:DAY},404);return;}
        send({ok:true,data:dailyRows,meta:{...META,date:DAY,vehicleBasis:'STORED_DATED_ASSIGNMENT'}});return;
      }
      if(pathname==='/__fixture/period'){
        const start=url.searchParams.get('start'),end=url.searchParams.get('end');const rows=generalRows.filter(row=>row.history.some(item=>item.deliveryDate>=start&&item.deliveryDate<=end));
        send({ok:true,data:rows,meta:{...META,startDate:start,endDate:end,aggregateComplete:false}});return;
      }
      if(pathname==='/hybrid-map-ui-boot.js'){send(hybridBoot,200,types['.js']);return;}
      if(pathname==='/vehicle-data.js'){send('window.VEHICLE_AREA_DATA='+JSON.stringify({vehicles:[]})+';',200,types['.js']);return;}
      if(pathname==='/admin-features.js'){send('window.ADMIN_FEATURES=[];',200,types['.js']);return;}
      if(pathname.startsWith('/api/')){
        if(pathname.includes('/auth/')){
          if(pathname.endsWith('/logout'))state.authenticated=false;if(pathname.endsWith('/login'))state.authenticated=true;
          send({authenticated:state.authenticated,configured:true,expiresAt:Date.now()+43200000,idleExpiresAt:Date.now()+28800000,fixture:true});return;
        }
        if(!state.authenticated){send({ok:false,error:'STAFF_LOGIN_REQUIRED'},401);return;}
        if(pathname.endsWith('/base-vehicles')){
          const codes=body.customerCodes||url.searchParams.get('customerCodes')?.split(',')||[];
          const data=codes.flatMap(code=>{const row=byCode.get(code);if(!row)return[];return[{customerCode:code,baseVehicle:row.baseVehicle,baseVehicleGroup:row.baseVehicleGroup,baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:VERSION,baseVehicleCheckedAt:DAY,baseVehicleStale:false}];});
          send({ok:true,data,meta:{version:VERSION,checkedAt:DAY,stale:false,basis:'FIXED_DISPATCH_PRIMARY',refresh:'IDLE'}});return;
        }
        if(pathname.endsWith('/private/customer-detail')){
          const code=url.searchParams.get('customerCode'),row=byCode.get(code);if(!row){send({ok:false,error:'NOT_FOUND'},404);return;}
          const publicData={customerCode:code,customerName:row.customerName,address:row.address,detailAddress:row.detailAddress||'합성 건물 1층',detailAddressState:'PRESENT',detailDate:url.searchParams.get('date')||DAY,addressRegion:row.addressRegion,deliveryPattern:'월·수·금',sourceBasis:'STORED_DAY',sourceDate:DAY,businessCoverageVerified:false};
          send({ok:true,data:url.searchParams.get('view')==='store'?publicData:{customerCode:code,password:'DEMO1234',accessInfo:'합성 출입 안내',specialRemark:'실제 매장 정보가 아닙니다.',deliveryPattern:'월·수·금',memoState:'REGISTERED',memoDate:DAY},meta:{cache:{stale:false,checkedAt:'2026-10-23T01:00:00Z',refreshing:false}}});return;
        }
        if(pathname.endsWith('/private/driver-history')){send({ok:true,data:{customerCode:url.searchParams.get('customerCode'),history:[],rows:[]},meta:{complete:true,fixture:true}});return;}
        if(pathname.endsWith('/private/delivery-photos')){send({ok:true,data:{customerCode:url.searchParams.get('customerCode'),deliveries:[]},fixture:true});return;}
        if(pathname.endsWith('/manual-pins/projection')||pathname.endsWith('/manual-pins')){send({ok:true,data:[],fixture:true});return;}
        if(pathname.endsWith('/manual-road-route')){
          state.routeRequests++;await new Promise(resolve=>setTimeout(resolve,state.routeDelayMs));
          if(state.routeMode==='error'){send({ok:false,error:'PROVIDER_UNAVAILABLE',fixture:true},503);return;}
          send(manualFixture(body));return;
        }
        if(pathname.endsWith('/private/road-route')){send({ok:false,error:'RECORDED_ORDER_REQUIRED',fixture:true},409);return;}
        if(pathname.endsWith('/vehicle-driver-master')){send({vehicles:Array.from({length:16},(_,i)=>({vehicle:String(101+i),driverName:'합성 기사 '+(101+i),driverKey:'FIXTURE_'+(101+i)}))});return;}
        if(pathname.endsWith('/data-status')){send({data:{customer:{freshon:DAY,delivery:DAY},published:{endDate:DAY},live:{ready:true,generation:'SYNTHETIC_FIXTURE_V1',periodLatest:DAY},job:null}});return;}
        if(pathname.endsWith('/period-status')){send(periods);return;}
        if(pathname.endsWith('/status')){send({snapshot:{latest:DAY,stale:false},fixture:true});return;}
        if(pathname.endsWith('/snapshot')){send({ok:true,data:generalRows,meta:META});return;}
        if(pathname.endsWith('/assignments')){const date=url.searchParams.get('date');send({ok:true,data:dailyRows,meta:{...META,date:date==='latest'?DAY:date}});return;}
        if(pathname.endsWith('/search')||pathname.endsWith('/customer-search')){const key=(url.searchParams.get('q')||decodeURIComponent(req.headers['x-map-customer-query']||'')).toLowerCase();send({ok:true,data:generalRows.filter(row=>[row.customerCode,row.customerName,row.address].some(v=>v.toLowerCase().includes(key))).slice(0,50),meta:{complete:true,fixture:true}});return;}
        if(pathname.endsWith('/detail')){const row=byCode.get(url.searchParams.get('customerCode'));send({ok:!!row,data:row||null,fixture:true},row?200:404);return;}
        send({ok:false,error:'FIXTURE_ENDPOINT_UNAVAILABLE',fixture:true},404);return;
      }
      const relative=pathname==='/'||pathname==='/preview'?'map-phase2b-preview.html':pathname.replace(/^\/+/, '');
      const target=path.resolve(PUBLIC,relative);if(!target.startsWith(PUBLIC+path.sep)){send({ok:false,error:'NOT_FOUND'},404);return;}
      let bytes;try{bytes=await fs.readFile(target);}catch{send({ok:false,error:'NOT_FOUND'},404);return;}
      if(path.extname(target)==='.html'){
        let html=bytes.toString('utf8');
        // Preserve the actual product markup/controllers; inject only a fixture bootstrap/banner.
        html=html.replace('<head>','<head>\n<script src="/__fixture/bootstrap.js"></script>');
        html=html.replace(/src="https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx@[^\"]+"/g,'src="/__fixture/xlsx-disabled.js"');
        html=html.replace('<body>',`<body><aside id="fixtureBanner" role="note" style="position:fixed;z-index:30000;bottom:0;left:0;right:0;padding:7px 12px;background:#5b3b0b;color:#fff;font:11px/1.4 sans-serif;text-align:center;pointer-events:none">${LABEL}</aside>`);
        send(html,200,types['.html']);return;
      }
      send(bytes,200,types[path.extname(target)]||'application/octet-stream');
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'FIXTURE_SERVER_ERROR',message:String(error.message)}));}
  });
  return {server,state};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const port=Number(process.env.OPSMAP_PREVIEW_PORT||4173),host=process.env.OPSMAP_PREVIEW_HOST||'127.0.0.1';
  const {server}=await createPreviewServer();
  server.listen(port,host,()=>{
    console.log(`DOM_FIXTURE_READY http://${host}:${port}/`);
    console.log(`SYNTHETIC ONLY: ${generalRows.length} general rows -> ${dailyRows.length} rows on ${DAY}.`);
    console.log('No upstream IO. Kakao SDK/auth/data/route responses are doubles. Real road routing/provider success is NOT verified.');
    console.log('GET /__fixture/state shows request evidence. POST {"routeMode":"error"} to that endpoint tests the error UI.');
  });
}
