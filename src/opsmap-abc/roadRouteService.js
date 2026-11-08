// Private, explicitly requested routing. Reuses the shipped Kakao adapter.
import {createHash} from 'node:crypto';
import '../../public/opsmap/kakao-directions-adapter.js';
const adapter=globalThis.KakaoDirectionsAdapter;
const origin='https://apis-navi.kakaomobility.com';
const error=(code,status=400)=>Object.assign(new Error(code),{code,status});
const routeValidationCodes=new Set(['INVALID_ROAD_ROUTE_RESPONSE','INVALID_ROAD_GEOMETRY','INVALID_COORDINATE','INCOMPLETE_ROAD_ROUTE']);
const bodyFailureCodes=new Set(['CONTENT_TYPE','MISSING_BODY','RESPONSE_LIMIT']);
const invalidProviderResponse=providerFailure=>Object.assign(error('INVALID_RESPONSE',502),{providerFailure});
const serializationFailure=()=>Object.assign(error('ROAD_ROUTE_FAILED',502),{providerFailure:'SERIALIZATION_FAILED'});

function classifyProviderFailure(cause, observation, timedOut) {
  if (timedOut) return error('TIMEOUT', 504);
  const {failureStage, providerHttp} = observation;
  switch (failureStage) {
    case 'FETCH': {
      if (providerHttp === 401) return error('AUTHENTICATION_FAILED', 502);
      if (providerHttp === 403) return error('PERMISSION_DENIED', 502);
      if (providerHttp === 429) return error('QUOTA_EXCEEDED', 429);
      const failure = error('PROVIDER_UNAVAILABLE', 502);
      if (providerHttp === null) failure.providerFailure = 'TRANSPORT';
      return failure;
    }
    case 'READ_BODY':
      if (bodyFailureCodes.has(cause?.providerFailure)) return invalidProviderResponse(cause.providerFailure);
      return Object.assign(error('PROVIDER_UNAVAILABLE', 502), {providerFailure:'RESPONSE_STREAM'});
    case 'JSON_PARSE':
      return invalidProviderResponse('MALFORMED_JSON');
    case 'VALIDATE_ROUTE':
      if (!routeValidationCodes.has(cause?.code)) return invalidProviderResponse('ROUTE_VALIDATION_FAILED');
      // The adapter supplies fixed check names. No provider data is copied.
      return Object.assign(invalidProviderResponse(cause.code), {validationCheck:cause.validationCheck});
    case 'SERIALIZE':
      return serializationFailure();
  }
}

function failurePayload(failure) {
  return {
    ok:false,
    error:failure.code || 'ROAD_ROUTE_FAILED',
    providerHttp:Number.isInteger(failure.providerHttp) ? failure.providerHttp : null,
    ...(failure.providerFailure ? {providerFailure:failure.providerFailure} : {}),
    ...(failure.failureStage ? {failureStage:failure.failureStage,responseBytes:failure.responseBytes} : {}),
    ...(failure.validationCheck ? {validationCheck:failure.validationCheck} : {})
  };
}

function recordProviderFailure(failure, observation) {
  Object.assign(failure, observation);
  console.warn(JSON.stringify({
    component:'opsmap-road-route',
    httpStatus:failure.status,
    ...failurePayload(failure)
  }));
  return failure;
}

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
async function readProviderBody(response, observation, maxBytes=8388608){
  if(!/json/i.test(response.headers.get('content-type')||'')){
    void response.body?.cancel().catch(()=>{});
    throw invalidProviderResponse('CONTENT_TYPE');
  }
  const reader=response.body?.getReader();if(!reader)throw invalidProviderResponse('MISSING_BODY');
  const parts=[];
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      observation.responseBytes+=value.byteLength;
      if(observation.responseBytes>maxBytes)throw invalidProviderResponse('RESPONSE_LIMIT');
      parts.push(value);
    }
  }
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(parts, observation.responseBytes);
}
export function createRoadRouteService({env=process.env,fetchImpl=fetch,now=Date.now,budget=null,requireDurableBudget=false,maxCacheBytes=12*1024*1024}={}){
  const cache=new Map(),pending=new Map();let bytes=0,used=0,active=0;
  // A durable ledger owns account limits and period rollover. The local counter
  // observes dispatches only; its fallback limit must not block a later month.
  const durableBudget=!!budget&&budget.durable===true&&typeof budget.reserve==='function';
  const limit=durableBudget?null:30000;
  const configured=()=>env.OPSMAP_ROAD_ROUTE_ENABLED==='1'||env.OPSMAP_ROAD_ROUTE_ENABLED==='true';
  const key=()=>String(env.KAKAO_MOBILITY_REST_API_KEY||env.KAKAO_REST_API_KEY||'').trim();
  const ttl=Math.min(300000,Math.max(0,Number(env.OPSMAP_ROAD_ROUTE_CACHE_MS)||60000));
  const remove=k=>{const row=cache.get(k);if(row)bytes-=row.bytes;cache.delete(k);};
  function configuration(){return {enabled:configured(),keyConfigured:!!key()&&!/REDACTED|PLACEHOLDER|YOUR_|<|>/i.test(key()),keySource:env.KAKAO_MOBILITY_REST_API_KEY?'KAKAO_MOBILITY_REST_API_KEY':env.KAKAO_REST_API_KEY?'KAKAO_REST_API_KEY':'NONE',maxWaypoints:30,requestLimit:limit,used,remaining:limit===null?null:Math.max(0,limit-used),processLimitEnforced:!durableBudget,usageScope:durableBudget?'PROCESS_OBSERVABILITY_COUNTER_NOT_PROVIDER_QUOTA':'PROCESS_SAFETY_COUNTER_NOT_PROVIDER_QUOTA',durableBudgetRequired:requireDurableBudget,persistentBudgetConfigured:durableBudget,budgetBackend:budget?.kind|| (budget?'HUB_ACTIONS_UNVERIFIED':'NONE'),budgetScope:durableBudget?'DURABLE_APPROVED_ACCOUNT_LEDGER':budget?'EXTERNAL_APPROVED_BUDGET':'PROCESS_SAFETY_LIMIT_NOT_ACCOUNT_QUOTA'};}
  async function readiness(){
    const config=configuration(),blocked=[];
    if(!config.enabled)blocked.push('FEATURE_DISABLED');
    if(!config.keyConfigured)blocked.push('KEY_MISSING');
    if(config.remaining===0)blocked.push('QUOTA_EXCEEDED');
    if(requireDurableBudget&&!config.persistentBudgetConfigured)blocked.push('PERSISTENT_BUDGET_REQUIRED');
    let approvedRemaining=null,budgetVerified=false,budgetError=null,apiRemaining=null;
    // Configuration inspection is read-only and never reserves or calls Kakao.
    if(budget&&(!blocked.length||budget.inspectWhenDisabled===true&&config.persistentBudgetConfigured)){
      if(typeof budget.status!=='function')blocked.push('ROAD_BUDGET_UNVERIFIED');
      else try{const status=await budget.status();if(status.durable!==true||status.scope!=='CUMULATIVE_APPROVED_ACCOUNT'||!Number.isSafeInteger(status.remaining)||status.remaining<0)throw Error('INVALID_BUDGET');approvedRemaining=status.remaining;apiRemaining=status.apiRemaining||null;budgetVerified=true;if(!approvedRemaining)blocked.push('QUOTA_EXCEEDED');}
      catch(e){blocked.push('ROAD_BUDGET_UNVERIFIED');budgetError=/^ROAD_BUDGET_[A-Z_]+$/.test(e?.code||'')?e.code:'ROAD_BUDGET_UNVERIFIED';}
    }
    return {...config,canRequest:blocked.length===0,blockedReasons:blocked,approvedRemaining,apiRemaining,budgetVerified,budgetError};
  }
  async function load(clean,plan){
    if(active>=3)throw error('PROVIDER_UNAVAILABLE',503);
    if(limit!==null&&used>=limit)throw error('QUOTA_EXCEEDED',429);
    // Bound concurrency before yielding; reserve durable allowance before dispatch.
    used++;active++;
    try{if(budget)await budget.reserve({cost:1,provider:'kakao-directions',api:plan.path==='/v1/waypoints/directions'?'waypoints':'directions'});}catch(e){used--;active--;throw error(e.code==='QUOTA_EXCEEDED'?'QUOTA_EXCEEDED':'CALL_POLICY_BLOCKED',429);}
    const timeout=Math.min(45000,Math.max(1000,Number(env.OPSMAP_ROAD_ROUTE_TIMEOUT_MS)||15000));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    const observation={failureStage:'FETCH',providerHttp:null,responseBytes:0};
    try{
      const url=new URL(plan.path,origin);if(plan.query)for(const[k,v]of Object.entries(plan.query))url.searchParams.set(k,String(v));
      const response=await fetchImpl(url.href,{method:plan.method,redirect:'error',signal:controller.signal,
        headers:{Authorization:'KakaoAK '+key(),Accept:'application/json',...(plan.method==='POST'?{'content-type':'application/json'}:{})},...(plan.body?{body:JSON.stringify(plan.body)}:{})});
      observation.providerHttp=Number.isInteger(response.status)?response.status:null;
      if(observation.providerHttp!==200){
        void response.body?.cancel().catch(()=>{});
        throw Error('PROVIDER_HTTP_REJECTED');
      }
      observation.failureStage='READ_BODY';
      const body=await readProviderBody(response,observation);
      observation.failureStage='JSON_PARSE';
      const provider=JSON.parse(body.toString('utf8'));
      observation.failureStage='VALIDATE_ROUTE';
      const validated=adapter.fromProvider(provider,clean);
      observation.failureStage='SERIALIZE';
      const data={...validated,calculatedAt:new Date(now()).toISOString()};
      const serializedBytes=Buffer.byteLength(JSON.stringify(data));
      return {data,serializedBytes,providerHttp:observation.providerHttp,responseBytes:observation.responseBytes};
    }catch(e){
      throw recordProviderFailure(classifyProviderFailure(e,observation,controller.signal.aborted),observation);
    }
    finally{clearTimeout(timer);active--;}
  }
  async function route(input){
    let clean,plan;try{clean=validRoadRouteRequest(input);plan=adapter.plan(clean);}catch(e){throw error(e.code||'INVALID_MANUAL_ROUTE',400);}
    if(plan.zeroDistance)return {ok:true,data:{...adapter.fromProvider(null,clean),calculatedAt:new Date(now()).toISOString()},meta:{cache:'NOT_NEEDED',providerHttp:null,...configuration()}};
    if(!configured())throw error('FEATURE_DISABLED',503);
    if(!configuration().keyConfigured)throw error('KEY_MISSING',503);
    // Preserve the deployed Stage call-authorization boundary. A process-only
    // counter cannot stand in for the caller's durable, approved API budget.
    if(requireDurableBudget&&(!budget||budget.durable!==true||typeof budget.reserve!=='function'))throw error('PERSISTENT_BUDGET_REQUIRED',503);
    const id=createHash('sha256').update(JSON.stringify({plan,stationaryLegs:adapter.routePlan(clean).stationaryLegs})).digest('hex');
    for(const[k,v]of cache)if(v.until<=now())remove(k);
    const saved=cache.get(id);
    if(saved)return {ok:true,data:{...structuredClone(saved.value),requestId:clean.requestId},meta:{cache:'HIT',providerHttp:null,...configuration()}};
    if(!pending.has(id)){
      const task=load(clean,plan).then(result=>{
        const {data:value,serializedBytes:size}=result;
        if(value.state==='success'&&size<=maxCacheBytes){while(cache.size>=32||bytes+size>maxCacheBytes)remove(cache.keys().next().value);cache.set(id,{value,until:now()+ttl,bytes:size});bytes+=size;}
        return result;
      }).finally(()=>pending.delete(id));pending.set(id,task);
    }
    const {data,providerHttp,responseBytes}=await pending.get(id);
    return {ok:true,data:{...structuredClone(data),requestId:clean.requestId},meta:{cache:'MISS_OR_SHARED',providerHttp,responseBytes,...configuration()}};
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
  const readRecorded=input=>{
    if(typeof readRecordedRoute!=='function')throw error('RECORDED_ORDER_REQUIRED',409);
    return readRecordedRoute(input);
  };
  const fail=(req,res,e)=>requireStaff(req,res,()=>res.status(e.status||502).json(failurePayload(e)));
  const respond=async(req,res,recorded)=>{
    res.set('Cache-Control','private, no-store');
    try{
      const verified=recorded?await readRecorded(req.body):null;
      if(verified?.data?.orderVerified===false)throw error('RECORDED_ORDER_REQUIRED',409);
      if(verified?.draft===null&&verified.data.stops.length)throw error(verified.data.missingCoordinates?'STOP_COORDINATES_MISSING':'ORIGIN_UNCONFIRMED',409);
      const result=verified?.draft===null?{ok:true,data:{state:'empty'}}:await service.route(verified?.draft??verified??req.body);
      if(recorded)result.data={...result.data,date:req.body.date,vehicle:req.body.vehicle};
      return requireStaff(req,res,async()=>{
        // The staff response gate can serialize after an asynchronous session check.
        try{return await res.json(result);}
        catch{
          const failure=recordProviderFailure(serializationFailure(),{
            failureStage:'SERIALIZE',
            providerHttp:result.meta?.providerHttp??null,
            responseBytes:result.meta?.responseBytes??0
          });
          if(res.headersSent)return res.destroy();
          try{return await res.status(failure.status).json(failurePayload(failure));}
          catch{return res.destroy();}
        }
      });
    }catch(e){return fail(req,res,e);}
  };
  app.get('/api/map-phase2b/private/road-route/config',requireStaff,async(_q,r)=>{
    const config=typeof service.readiness==='function'?await service.readiness():service.configuration();
    return requireStaff(_q,r,()=>r.set('Cache-Control','private, no-store').json({ok:true,data:{...config,recordedRouteConfigured:typeof readRecordedRoute==='function'}}));
  });
  app.get('/api/map-phase2b/private/road-route/recorded-stops',requireStaff,async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try{
      const {data}=await readRecorded(req.query);
      return requireStaff(req,res,()=>res.json({ok:true,data,meta:{source:'HUB_ROUTE_STOPS'}}));
    }catch(e){return fail(req,res,e);}
  });
  app.post('/api/map-phase2b/private/manual-road-route',requireStaff,sameOrigin,jsonBody,(q,r)=>respond(q,r,false));
  app.post('/api/map-phase2b/private/road-route',requireStaff,sameOrigin,jsonBody,(q,r)=>respond(q,r,true));
}
