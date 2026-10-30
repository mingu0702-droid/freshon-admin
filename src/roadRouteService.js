// Private, explicitly requested routing. Reuses the shipped Kakao adapter.
import {createHash} from 'node:crypto';
import '../public/kakao-directions-adapter.js';
const adapter=globalThis.KakaoDirectionsAdapter;
const origin='https://apis-navi.kakaomobility.com';
const error=(code,status=400)=>Object.assign(new Error(code),{code,status});
export function validRoadRouteRequest(body){
  if(!body||body.mode!=='MANUAL_WAYPOINTS'||!Array.isArray(body.waypoints)||body.waypoints.length>30)throw error('WAYPOINT_LIMIT');
  if(!(Number.isSafeInteger(body.requestId)&&body.requestId>=0)&&!(typeof body.requestId==='string'&&/^[\w-]{1,80}$/.test(body.requestId)))throw error('INVALID_MANUAL_ROUTE');
  const ids=new Set();
  const point=(p,order)=>{
    if(!p||typeof p.id!=='string'||!(/^[\w-]{1,80}$/).test(p.id)||ids.has(p.id))throw error('INVALID_MANUAL_ROUTE');
    ids.add(p.id);adapter.coordinate(p);
    if(order!==undefined&&p.order!==order)throw error('INVALID_MANUAL_ROUTE');
    return {id:p.id,lat:p.lat,lng:p.lng,...(order===undefined?{}:{order})};
  };
  const clean={mode:body.mode,requestId:body.requestId,origin:point(body.origin),waypoints:body.waypoints.map((p,i)=>point(p,i+1)),destination:point(body.destination)};
  adapter.plan(clean);return clean;
}
async function boundedJson(response,maxBytes=8388608){
  if(!/json/i.test(response.headers.get('content-type')||''))throw error('PROVIDER_UNAVAILABLE',502);
  const reader=response.body?.getReader();if(!reader)throw error('PROVIDER_UNAVAILABLE',502);
  const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw error('PROVIDER_UNAVAILABLE',502);parts.push(value);}}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw error('PROVIDER_UNAVAILABLE',502);}
}
export function createRoadRouteService({env=process.env,fetchImpl=fetch,now=Date.now,budget=null,requireDurableBudget=false,maxCacheBytes=12*1024*1024}={}){
  const cache=new Map(),pending=new Map();let bytes=0,used=0,active=0;
  const rawLimit=Number(env.OPSMAP_ROAD_ROUTE_REQUEST_LIMIT);
  const limit=env.OPSMAP_ROAD_ROUTE_REQUEST_LIMIT!==undefined&&Number.isSafeInteger(rawLimit)&&rawLimit>=0?Math.min(30000,rawLimit):30000;
  const configured=()=>env.OPSMAP_ROAD_ROUTE_ENABLED==='1'||env.OPSMAP_ROAD_ROUTE_ENABLED==='true';
  const key=()=>String(env.KAKAO_MOBILITY_REST_API_KEY||env.KAKAO_REST_API_KEY||'').trim();
  const ttl=Math.min(300000,Math.max(0,Number(env.OPSMAP_ROAD_ROUTE_CACHE_MS)||60000));
  const remove=k=>{const row=cache.get(k);if(row)bytes-=row.bytes;cache.delete(k);};
  function configuration(){return {enabled:configured(),keyConfigured:!!key()&&!/REDACTED|PLACEHOLDER|YOUR_|<|>/i.test(key()),maxWaypoints:30,requestLimit:limit,used,remaining:Math.max(0,limit-used),durableBudgetRequired:requireDurableBudget,persistentBudgetConfigured:!!budget&&budget.durable===true&&typeof budget.reserve==='function',budgetScope:budget?'EXTERNAL_APPROVED_BUDGET':'PROCESS_SAFETY_LIMIT_NOT_ACCOUNT_QUOTA'};}
  async function readiness(){
    const config=configuration(),blocked=[];
    if(!config.enabled)blocked.push('FEATURE_DISABLED');
    if(!config.keyConfigured)blocked.push('KEY_MISSING');
    if(config.remaining===0)blocked.push('QUOTA_EXCEEDED');
    if(requireDurableBudget&&!config.persistentBudgetConfigured)blocked.push('PERSISTENT_BUDGET_REQUIRED');
    let approvedRemaining=null;
    // Configuration inspection is read-only and never reserves or calls Kakao.
    if(!blocked.length&&budget){
      if(typeof budget.status!=='function')blocked.push('ROAD_BUDGET_UNVERIFIED');
      else try{const status=await budget.status();if(status.durable!==true||status.scope!=='CUMULATIVE_APPROVED_ACCOUNT'||!Number.isSafeInteger(status.remaining)||status.remaining<0)throw Error('INVALID_BUDGET');approvedRemaining=status.remaining;if(!approvedRemaining)blocked.push('QUOTA_EXCEEDED');}
      catch{blocked.push('ROAD_BUDGET_UNVERIFIED');}
    }
    return {...config,canRequest:blocked.length===0,blockedReasons:blocked,approvedRemaining};
  }
  async function load(clean,plan){
    if(active>=3)throw error('PROVIDER_UNAVAILABLE',503);
    if(used>=limit)throw error('QUOTA_EXCEEDED',429);
    // Reserve the local slot before yielding to an optional shared budget.
    used++;active++;
    try{if(budget)await budget.reserve({cost:1,provider:'kakao-directions'});}catch(e){used--;active--;throw error(e.code==='QUOTA_EXCEEDED'?'QUOTA_EXCEEDED':'CALL_POLICY_BLOCKED',429);}
    const timeout=Math.min(45000,Math.max(1000,Number(env.OPSMAP_ROAD_ROUTE_TIMEOUT_MS)||15000));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const url=new URL(plan.path,origin);if(plan.query)for(const[k,v]of Object.entries(plan.query))url.searchParams.set(k,String(v));
      const response=await fetchImpl(url.href,{method:plan.method,redirect:'error',signal:controller.signal,
        headers:{Authorization:'KakaoAK '+key(),Accept:'application/json',...(plan.method==='POST'?{'content-type':'application/json'}:{})},...(plan.body?{body:JSON.stringify(plan.body)}:{})});
      if(!response.ok){void response.body?.cancel();throw error(response.status===401?'AUTHENTICATION_FAILED':response.status===403?'PERMISSION_DENIED':response.status===429?'QUOTA_EXCEEDED':'PROVIDER_UNAVAILABLE',response.status===429?429:502);}
      const provider=await boundedJson(response);const data=adapter.fromProvider(provider,clean);
      return {...data,calculatedAt:new Date(now()).toISOString()};
    }catch(e){if(controller.signal.aborted)throw error('TIMEOUT',504);if(e.code&&e.status)throw e;throw error('PROVIDER_UNAVAILABLE',502);}
    finally{clearTimeout(timer);active--;}
  }
  async function route(input){
    let clean,plan;try{clean=validRoadRouteRequest(input);plan=adapter.plan(clean);}catch(e){throw error(e.code||'INVALID_MANUAL_ROUTE',400);}
    if(plan.zeroDistance)return {ok:true,data:{...adapter.fromProvider(null,clean),calculatedAt:new Date(now()).toISOString()},meta:{cache:'NOT_NEEDED',...configuration()}};
    if(!configured())throw error('FEATURE_DISABLED',503);
    if(!configuration().keyConfigured)throw error('KEY_MISSING',503);
    // Preserve the deployed Stage call-authorization boundary. A process-only
    // counter cannot stand in for the caller's durable, approved API budget.
    if(requireDurableBudget&&(!budget||budget.durable!==true||typeof budget.reserve!=='function'))throw error('PERSISTENT_BUDGET_REQUIRED',503);
    const id=createHash('sha256').update(JSON.stringify({plan,stationaryLegs:adapter.routePlan(clean).stationaryLegs})).digest('hex');
    for(const[k,v]of cache)if(v.until<=now())remove(k);
    const saved=cache.get(id);
    if(saved)return {ok:true,data:{...structuredClone(saved.value),requestId:clean.requestId},meta:{cache:'HIT',...configuration()}};
    if(!pending.has(id)){
      const task=load(clean,plan).then(value=>{
        const size=Buffer.byteLength(JSON.stringify(value));
        if(value.state==='success'&&size<=maxCacheBytes){while(cache.size>=32||bytes+size>maxCacheBytes)remove(cache.keys().next().value);cache.set(id,{value,until:now()+ttl,bytes:size});bytes+=size;}
        return value;
      }).finally(()=>pending.delete(id));pending.set(id,task);
    }
    const result=await pending.get(id);
    return {ok:true,data:{...structuredClone(result),requestId:clean.requestId},meta:{cache:'MISS_OR_SHARED',...configuration()}};
  }
  return {route,configuration,readiness,clear(){cache.clear();bytes=0;}};
}
export function isRoadRouteRequest(req){return req.method==='POST'&&['/api/map-phase2b/private/manual-road-route','/api/map-phase2b/private/road-route'].includes(req.path);}
export function mountRoadRouteRoutes({app,requireStaff,jsonBody,service,env=process.env,readRecordedRoute}={}){
  if(!app||!requireStaff||!service||!jsonBody)throw Error('ROAD_ROUTE_MOUNT_REQUIRED');
  function sameOrigin(req,res,next){
    const expected=env.RENDER_EXTERNAL_URL||env.MAP_STAFF_ORIGIN||'';
    if(!expected||req.get('origin')!==new URL(expected).origin||req.get('sec-fetch-site')&&!['same-origin','none'].includes(req.get('sec-fetch-site')))return res.status(403).json({ok:false,error:'ORIGIN_REJECTED'});
    if(!req.is('application/json'))return res.status(415).json({ok:false,error:'INVALID_MANUAL_ROUTE'});
    next();
  }
  const respond=async(req,res,recorded)=>{
    res.set('Cache-Control','private, no-store');
    try{
      let body=req.body;
      if(recorded){
        if(typeof readRecordedRoute!=='function')throw error('RECORDED_ORDER_REQUIRED',409);
        body=await readRecordedRoute(req.body); // adapter must return a verified ordered draft
      }
      const result=await service.route(body);
      if(recorded)result.data={...result.data,date:req.body.date,vehicle:req.body.vehicle};
      return requireStaff(req,res,()=>res.json(result));
    }catch(e){return requireStaff(req,res,()=>res.status(e.status||502).json({ok:false,error:e.code||'ROAD_ROUTE_FAILED'}));}
  };
  app.get('/api/map-phase2b/private/road-route/config',requireStaff,async(_q,r)=>{
    const config=typeof service.readiness==='function'?await service.readiness():service.configuration();
    return requireStaff(_q,r,()=>r.set('Cache-Control','private, no-store').json({ok:true,data:{...config,recordedRouteConfigured:typeof readRecordedRoute==='function'}}));
  });
  app.post('/api/map-phase2b/private/manual-road-route',requireStaff,sameOrigin,jsonBody,(q,r)=>respond(q,r,false));
  app.post('/api/map-phase2b/private/road-route',requireStaff,sameOrigin,jsonBody,(q,r)=>respond(q,r,true));
}
