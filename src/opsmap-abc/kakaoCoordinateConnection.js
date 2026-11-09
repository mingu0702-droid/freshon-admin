// One staff-only REST path; only request hashes/counts are durable, never API coordinates.
import {createHash} from 'node:crypto';
import {coordinateAddressHash,externalCoordinateAddress} from './opsmapAutoCoordinates.js';
import {classifyCoordinateLookup,prepareRecoveryCoordinateAddress} from '../coordinateLookupOutcome.js';
export const KAKAO_GEOCODE_EPOCH='R10_USER_CONFIRMED_20261103';
export const KAKAO_DIAGNOSTIC_ADDRESS='경기도 오산시 원동 380-38';
export const KAKAO_EXPECTED_APP_ID='1464792';
export const createKakaoGeocodeLedger=()=>({schema:1,epoch:KAKAO_GEOCODE_EPOCH,historicalConsumed:250,used:0,days:{},queries:{},diagnosticUsed:false,diagnosticPassed:false,blocked:false});
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status});};
const day=stamp=>new Date(stamp+32400000).toISOString().slice(0,10);
const safePlaceQuery=value=>{
 const text=value.normalize('NFKC').trim().replace(/ +/g,' ');
 return text.length>=2&&text.length<=100&&/^[가-힣a-z0-9 ()·.,&'-]+$/i.test(text)&&
  /[가-힣a-z]/i.test(text)&&!/^[a-z]\d+$/i.test(text)&&
  !/비밀|비번|암호|출입|현관|도어|잠금|연락|전화|password|passcode|access\s*code|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(text)?text:null;
};
function interactiveDocuments(body,mode){
 const label=value=>typeof value==='string'?value.trim().slice(0,200):'';
 const found=new Map();
 for(const row of body.documents){
  const x=Number(row?.x),y=Number(row?.y);
  if(x<124||x>132||y<33||y>39.5||!Number.isFinite(x)||!Number.isFinite(y))continue;
  const road=label(mode==='place'?row.road_address_name:row.road_address?.address_name);
  const lot=label(mode==='place'?row.address_name:row.address?.address_name||row.address_name);
  const place=mode==='place'?label(row.place_name):'';
  if(!(road||lot)||(mode==='place'&&!place))continue;
  const result={x:String(x),y:String(y),address_name:road||lot};
  if(road)result.road_address={address_name:road};
  if(lot)result.address={address_name:lot};
  if(place)result.place_name=place;
  found.set(JSON.stringify([road,lot,place,x,y]),result);
 }
 return [...found.values()];
}

export function createKakaoCoordinateConnection({env=process.env,store,independentAddressLookup=()=>null,stageAddressApproved=false,now=Date.now,fetchImpl=globalThis.fetch}={}) {
 const externalDisabled=env.OPSMAP_STAGE_VERIFY_ONLY==='1'&&!stageAddressApproved;
 const configuredLimit=Number(env.OPSMAP_KAKAO_GEOCODING_DAILY_LIMIT||100);
 const dailyLimit=Number.isSafeInteger(configuredLimit)&&configuredLimit>=1&&configuredLimit<=1000?configuredLimit:100;
 let blocked=false,cooldownUntil=0,lastProviderAt=0,providerQueue=Promise.resolve();const pending=new Map();
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const providerRequest=work=>{const task=providerQueue.catch(()=>{}).then(async()=>{const delay=250-(Date.now()-lastProviderAt);if(delay>0)await wait(delay);lastProviderAt=Date.now();return work();});providerQueue=task;return task;};
 const proof=()=>{
  const key=String(env.KAKAO_REST_API_KEY||'').trim();
  return /^[a-f0-9]{32}$/i.test(key)&&env.OPSMAP_KAKAO_FREE_QUOTA_VERIFIED==='1'&&env.OPSMAP_KAKAO_PAID_API_DISABLED==='1'&&
   env.KAKAO_MAP_APP_ID===KAKAO_EXPECTED_APP_ID&&hash(key)===env.OPSMAP_KAKAO_REST_KEY_SHA256;
 };
 const validate=state=>{
  if(state?.schema!==1||state.epoch!==KAKAO_GEOCODE_EPOCH||state.historicalConsumed!==250||!Number.isSafeInteger(state.used)||state.used<0||
   !state.days||!state.queries||typeof state.diagnosticUsed!=='boolean'||typeof state.diagnosticPassed!=='boolean'||typeof state.blocked!=='boolean')fail('GEOCODE_LEDGER_INVALID');
  return state;
 };
 const transaction=work=>{if(!store?.durable||typeof store.transaction!=='function')fail('GEOCODE_DURABLE_LEDGER_REQUIRED');return store.transaction((state,commit)=>work(validate(state),commit));};
 const keywordProof=()=>env.OPSMAP_KAKAO_KEYWORD_FREE_QUOTA_VERIFIED==='1';
 const status=async()=>{
  const independentEnabled=Boolean(independentAddressLookup());
  if(externalDisabled)return {enabled:false,independentEnabled,reason:'GEOCODING_DISABLED',retention:'REQUEST_ONLY'};
  if(!proof())return {enabled:false,independentEnabled,reason:'TARGET_APP_FREE_QUOTA_UNVERIFIED',retention:'REQUEST_ONLY'};
  try{return await transaction(async state=>{
   const enabled=env.OPSMAP_KAKAO_GEOCODING_ENABLED==='1'&&state.diagnosticPassed&&!state.blocked&&!blocked;
   return {enabled,independentEnabled,keywordEnabled:enabled&&keywordProof(),
   diagnosticAvailable:env.OPSMAP_KAKAO_DIAGNOSTIC_ENABLED==='1'&&!state.diagnosticUsed&&!state.blocked&&!blocked,
   reason:state.blocked||blocked?'GEOCODE_AUTOMATICALLY_BLOCKED':enabled?'READY':state.diagnosticPassed?'GEOCODING_DISABLED':'DIAGNOSTIC_REQUIRED',
   dailyLimit,dailyUsed:Number(state.days[day(now())]||0),epoch:state.epoch,retention:'REQUEST_ONLY',lastAttempt:state.lastAttempt||null};});}
  catch{return {enabled:false,independentEnabled,reason:'GEOCODE_DURABLE_LEDGER_REQUIRED',retention:'REQUEST_ONLY'};}
 };
 const lookup=async(query,{diagnostic=false,mode='exact',assertCurrent=async()=>{}}={})=>{
  if(typeof query!=='string'||query.normalize('NFKC').trim().length>200||
     !['exact','address','place','official'].includes(mode)||(diagnostic&&mode!=='exact'))fail('GEOCODE_QUERY_INVALID',400);
  if(mode==='official'){
   const index=independentAddressLookup();
   if(!index)fail('OFFICIAL_ADDRESS_LOOKUP_DISABLED');
   await assertCurrent();
   const point=index.lookup(query);
   await assertCurrent();
   if(point?.kind){
    const {kind,road,lot,points}=point;
    const documents=points.map(([lat,lng],i)=>({x:String(lng),y:String(lat),address_name:road,
     ...(kind==='CHOOSE'?{place_name:'공식 위치 후보 '+(i+1)}:{})}));
    return {ok:true,data:{documents,status:documents.length?'OK':'ZERO_RESULT',resolution:{kind,road,lot},
     source:'OFFICIAL_PUBLIC_BUILDING',retention:'REQUEST_ONLY',coordinatePersistence:false}};
   }
   const documents=point?[{x:String(point.lng),y:String(point.lat)}]:[];
   return {ok:true,data:{documents,status:point?'OK':'ZERO_RESULT',
    resolution:{kind:point?'EXACT':'ZERO_RESULT'},source:'OFFICIAL_PUBLIC_BUILDING',retention:'REQUEST_ONLY',coordinatePersistence:false}};
  }
  if(externalDisabled)fail('GEOCODING_DISABLED');
  const place=mode==='place';
  const safe=place?null:externalCoordinateAddress(query.normalize('NFKC').replace(/ +/g,' ').trim().replace(/(동|읍|면|리|대로|로|길)(\d+(?:-\d+)?)$/,'$1 $2'));
  const address=place?safePlaceQuery(query):safe?prepareRecoveryCoordinateAddress(safe).query:null;
  if(!address)fail('GEOCODE_QUERY_INVALID',400);
  if(!proof())fail('TARGET_APP_FREE_QUOTA_UNVERIFIED');
  if(place&&!keywordProof())fail('TARGET_APP_KEYWORD_FREE_QUOTA_UNVERIFIED');
  if(blocked)fail('GEOCODE_AUTOMATICALLY_BLOCKED');
  if(now()<cooldownUntil)fail('GEOCODE_RETRY_COOLDOWN',503);
  if(diagnostic&&address!==KAKAO_DIAGNOSTIC_ADDRESS)fail('DIAGNOSTIC_ADDRESS_REJECTED',400);
  const queryHash=coordinateAddressHash(address),key=(diagnostic?'diagnostic':mode)+':'+queryHash;
  const shared=pending.get(key);
  if(shared){await assertCurrent();const result=await shared;await assertCurrent();return result;}
  const task=(async()=>{
   await assertCurrent();
   await transaction(async(state,commit)=>{
    if(state.blocked||blocked)fail('GEOCODE_AUTOMATICALLY_BLOCKED');
    if(diagnostic){if(env.OPSMAP_KAKAO_DIAGNOSTIC_ENABLED!=='1'||state.diagnosticUsed)fail('DIAGNOSTIC_ALREADY_USED',429);}
    else if(env.OPSMAP_KAKAO_GEOCODING_ENABLED!=='1'||!state.diagnosticPassed)fail('GEOCODING_DISABLED');
    const today=day(now()),count=Number(state.days[today]||0);
    if(!Number.isSafeInteger(count)||count<0||count>=dailyLimit)fail('GEOCODE_DAILY_LIMIT',429);
    await assertCurrent();
    state.used++;state.days[today]=count+1;state.queries[today+':'+queryHash]=Number(state.queries[today+':'+queryHash]||0)+1;
    if(diagnostic)state.diagnosticUsed=true;
    await commit(state);
   });
   let stage='PROVIDER_REQUEST',providerHttp=null;const started=now();
   try{
    await assertCurrent();
    const url=new URL(place?'https://dapi.kakao.com/v2/local/search/keyword.json':'https://dapi.kakao.com/v2/local/search/address.json');
    url.searchParams.set('query',address);
    if(!place)url.searchParams.set('analyze_type',mode==='address'?'similar':'exact');
    url.searchParams.set('size',place?'15':'30');
    const response=await providerRequest(async()=>{
     await assertCurrent();
     if(blocked)fail('GEOCODE_AUTOMATICALLY_BLOCKED');
     if(now()<cooldownUntil)fail('GEOCODE_RETRY_COOLDOWN');
     return fetchImpl(url,{method:'GET',headers:{Authorization:'KakaoAK '+String(env.KAKAO_REST_API_KEY).trim()},signal:AbortSignal.timeout(6000),redirect:'error',cache:'no-store'});
    });
    providerHttp=response.status;stage='PROVIDER_HEADERS';
    if(!response.ok)fail('KAKAO_HTTP_REJECTED',502);
    const appHeader=['x-kakao-app-id','x-kakao-appid'].map(name=>response.headers?.get?.(name)).find(value=>value!=null);
    if(appHeader!==undefined&&appHeader!==KAKAO_EXPECTED_APP_ID)fail('KAKAO_RESPONSE_APP_MISMATCH',502);
    stage='PROVIDER_BODY';let body;try{body=await response.json();}catch{fail('KAKAO_JSON_INVALID',502);}
    stage='CONTRACT';if(!Array.isArray(body?.documents)||typeof body.meta?.is_end!=='boolean')fail('KAKAO_RESPONSE_INVALID',502);
    const {point,resolution}=place?{point:null,resolution:{kind:body.meta.is_end?'KEYWORD':'TRUNCATED',candidateCount:body.documents.length}}:classifyCoordinateLookup(body,address);
    const documents=mode==='exact'?(point?[{address_name:address,x:String(point.lng),y:String(point.lat)}]:[]):interactiveDocuments(body,mode);
    if(mode!=='exact'&&body.documents.length&&!documents.length)fail('KAKAO_RESPONSE_INVALID',502);
    if(diagnostic&&!point)fail('KAKAO_DIAGNOSTIC_NOT_EXACT',409);
    stage='LEDGER_COMPLETION';if(diagnostic)await transaction(async(state,commit)=>{state.diagnosticPassed=true;await commit(state);});
    stage='SESSION_RECHECK';
    await assertCurrent();
    return {ok:true,data:{documents,status:documents.length?'OK':'ZERO_RESULT',exact:!!point,
     diagnostic,providerHttp:200,responseAppId:appHeader||null,resolution,retention:'REQUEST_ONLY',coordinatePersistence:false}};
   }catch(error){
    if(['GEOCODE_SESSION_EXPIRED','GEOCODE_RETRY_COOLDOWN','GEOCODE_AUTOMATICALLY_BLOCKED'].includes(error?.code))throw error;
    const transportCode=['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNREFUSED','ECONNRESET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.cause?.code)?error.cause.code:null;
    const code=/^KAKAO_[A-Z_]+$/.test(error?.code||'')?error.code:stage==='LEDGER_COMPLETION'?'KAKAO_LEDGER_COMPLETION_FAILED':['TimeoutError','AbortError'].includes(error?.name)?'KAKAO_TIMEOUT':stage==='PROVIDER_REQUEST'?'KAKAO_NETWORK_FAILED':'KAKAO_LOOKUP_FAILED';
    const lastAttempt={stage,code,providerHttp:Number.isInteger(providerHttp)?providerHttp:null,transportCode,elapsedMs:Math.max(0,now()-started)};
    // Authentication/quota/unsafe contracts stop shared calls. A transport outage
    // only backs off: one network error must not disable the rest of the day.
    const transient=['KAKAO_TIMEOUT','KAKAO_NETWORK_FAILED'].includes(code)||Number.isInteger(providerHttp)&&providerHttp>=500;
    if(transient)cooldownUntil=now()+30000;else blocked=true;
    try{await transaction(async(state,commit)=>{if(!transient)state.blocked=true;state.lastAttempt=lastAttempt;await commit(state);});}catch{blocked=true;}
    throw Object.assign(Error(code),{code,status:502,providerHttp:lastAttempt.providerHttp});
   }
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 };
 const configuration=async({javascriptKey=env.KAKAO_MAP_JAVASCRIPT_KEY}={})=>{
  const key=String(env.KAKAO_REST_API_KEY||'').trim(),js=String(javascriptKey||'').trim();
  const missing=[];
  if(!/^[a-f0-9]{32}$/i.test(key))missing.push('KAKAO_REST_API_KEY');
  if(env.KAKAO_MAP_APP_ID!==KAKAO_EXPECTED_APP_ID)missing.push('KAKAO_MAP_APP_ID');
  if(!key||hash(key)!==env.OPSMAP_KAKAO_REST_KEY_SHA256)missing.push('OPSMAP_KAKAO_REST_KEY_SHA256');
  if(env.OPSMAP_KAKAO_FREE_QUOTA_VERIFIED!=='1')missing.push('OPSMAP_KAKAO_FREE_QUOTA_VERIFIED');
  if(env.OPSMAP_KAKAO_PAID_API_DISABLED!=='1')missing.push('OPSMAP_KAKAO_PAID_API_DISABLED');
  if(env.OPSMAP_KAKAO_DIAGNOSTIC_ENABLED!=='1')missing.push('OPSMAP_KAKAO_DIAGNOSTIC_ENABLED');
  return {restKeySettingName:'KAKAO_REST_API_KEY',restKeyPresent:!!key,restKeySha256:key?hash(key):null,javascriptKeySha256:js?hash(js):null,
   expectedAppId:KAKAO_EXPECTED_APP_ID,configuredAppId:env.KAKAO_MAP_APP_ID||null,sameAppVerification:'USER_CONFIRMED_CONSOLE_AND_PRODUCTION_KEY_SOURCE_HASH_PIN',
   evidence:{source:'USER_DEVELOPER_CONSOLE_20261103',appId:KAKAO_EXPECTED_APP_ID,addressDailyUsed:0,addressDailyQuota:100000,mapSdkUsed:14,mapSdkQuota:300000,paidApiEnabled:false},
   missingGateSettings:missing,...await status()};
 };
 return {status,lookup,configuration};
}
export function mountKakaoCoordinateConnection({app,requireStaff,isSessionCurrent,service,jsonBody,origin}){
 const respond=diagnostic=>async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  try{
   if(!origin||req.get('origin')!==new URL(origin).origin||req.get('sec-fetch-site')&&!['same-origin','none'].includes(req.get('sec-fetch-site')))fail('GEOCODE_ORIGIN_REJECTED',403);
   const fields=Object.keys(req.body||{});
   if(!req.is('application/json')||!fields.includes('query')||fields.some(key=>key!=='query'&&(key!=='mode'||diagnostic))||
      fields.includes('mode')&&!['address','place','official'].includes(req.body.mode))fail('GEOCODE_QUERY_INVALID',400);
   const sessionKey=res.locals.staffSession?.key;
   const assertCurrent=async()=>{if(isSessionCurrent&&!await isSessionCurrent(req,sessionKey))fail('GEOCODE_SESSION_EXPIRED',401);};
   const value=await service.lookup(req.body.query,{diagnostic,mode:req.body.mode,assertCurrent});return requireStaff(req,res,()=>res.json(value));
  }catch(error){return requireStaff(req,res,()=>res.status(error.status||503).json({ok:false,error:/^[A-Z_]+$/.test(error.code||'')?error.code:'GEOCODE_FAILED',providerHttp:Number.isInteger(error.providerHttp)?error.providerHttp:null}));}
 };
 app.post('/api/map-phase2b/private/address-lookup',requireStaff,jsonBody,respond(false));
 app.post('/api/map-phase2b/private/address-lookup-diagnostic',requireStaff,jsonBody,respond(true));
}
