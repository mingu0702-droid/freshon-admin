import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {createKakaoGeocodeLedger,KAKAO_EXPECTED_APP_ID} from '../src/opsmap-abc/kakaoCoordinateConnection.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {PRIMARY_ORIGIN,PRIMARY_SERVICE} from '../src/stageScope.js';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const password='fixture-only-primary-address';
const fixtureAddress='경기도 오산시 검증로 777';
const fixtureKey='1'.repeat(32);
const preservation=JSON.stringify({
  schema:1,destination:PRIMARY_ORIGIN,operationsArchive:'1'.repeat(40),wmsArchive:'2'.repeat(40),
  legacySnapshotArchive:'3'.repeat(40),legacyAuthArchive:'4'.repeat(40),legacyPinsArchive:'5'.repeat(40),
  stagePinsArchive:'6'.repeat(40),legacyRegistryChecked:1,legacyFixedChecked:1,legacyRegistryVerified:true,
  legacyRegistryUnconfirmed:0,legacyFixedUnconfirmed:0,stagePinsUnconfirmed:0
});

async function addressFixture(t,{approved,dailyLimit='1',durable=true}){
  const sessionData=new Map();
  const sessions={
    get:async key=>sessionData.get(key),
    set:async(key,value)=>sessionData.set(key,value),
    touch:async(key,value)=>Boolean(sessionData.has(key)&&sessionData.set(key,value)),
    delete:async key=>sessionData.delete(key)
  };
  const ledger={...createKakaoGeocodeLedger(),diagnosticUsed:true,diagnosticPassed:true};
  const counts={reads:0,writes:0,provider:0};
  const env={
    RENDER_SERVICE_ID:PRIMARY_SERVICE,RENDER_EXTERNAL_URL:PRIMARY_ORIGIN,
    OPSMAP_PRIMARY_CUTOVER_APPROVED:'1',OPSMAP_PRIMARY_ARCHIVE_READ_APPROVED:'1',
    OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN:'fixture-reader',OPSMAP_PRIMARY_PRESERVATION_JSON:preservation,
    OPSMAP_PRIMARY_PRESERVATION_SHA256:sha256(preservation),
    MAP_STAFF_ID:'fixture',MAP_STAFF_SESSION_SECRET:'a'.repeat(48),
    MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    KAKAO_MAP_JAVASCRIPT_KEY:'b'.repeat(32),KAKAO_REST_API_KEY:fixtureKey,KAKAO_MAP_APP_ID:KAKAO_EXPECTED_APP_ID,
    OPSMAP_KAKAO_REST_KEY_SHA256:sha256(fixtureKey),OPSMAP_KAKAO_FREE_QUOTA_VERIFIED:'1',
    OPSMAP_KAKAO_PAID_API_DISABLED:'1',OPSMAP_KAKAO_GEOCODING_ENABLED:'1',
    OPSMAP_KAKAO_GEOCODING_DAILY_LIMIT:dailyLimit,OPSMAP_PRIMARY_KAKAO_ADDRESS_BATCH_APPROVED:approved?'1':'0',
    OPSMAP_STAGE_KAKAO_ADDRESS_APPROVED:'1'
  };
  const geocodeBudget={
    durable,
    async transaction(work){
      counts.reads++;
      return work(structuredClone(ledger),state=>{
        counts.writes++;
        Object.assign(ledger,state);
      });
    }
  };
  const app=createStageVerificationApp({
    env,syncReaders:{},primaryServices:{sessions,geocodeBudget,roadRouteService:{}},
    async fetchImpl(input,options){
      const url=new URL(input);
      assert.equal(url.origin,'https://dapi.kakao.com');
      assert.equal(url.pathname,'/v2/local/search/address.json');
      assert.equal(url.searchParams.get('query'),fixtureAddress);
      assert.equal(options.method,'GET');
      counts.provider++;
      return Response.json({meta:{is_end:true},documents:[{x:'127.07',y:'37.15',address_name:fixtureAddress}]});
    }
  });
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();server.close();});
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/';
  const headers={origin:PRIMARY_ORIGIN,'content-type':'application/json'};
  const request=(suffix,options)=>fetch(base+suffix,{headers,...options});
  const login=await request('auth/login',{method:'POST',body:JSON.stringify({id:'fixture',password})});
  assert.equal(login.status,200);
  headers.cookie=login.headers.get('set-cookie').split(';')[0];
  const config=async(sdkOnly=false)=>{
    const response=await request('private/map-sdk-config'+(sdkOnly?'?sdkOnly=1':''));
    assert.equal(response.status,200);
    return response.json();
  };
  const directLookup=()=>request('private/address-lookup',{method:'POST',body:JSON.stringify({query:fixtureAddress,mode:'address'})});
  return {config,directLookup,counts,ledger,env};
}

test('Primary batch capability needs explicit Primary approval without disabling the existing direct lookup',async t=>{
  const {config,directLookup,counts}=await addressFixture(t,{approved:false});
  const status=await config();
  assert.equal(status.allowExternalAddressLookup,true);
  assert.equal(status.allowExternalBatchAddressLookup,false);
  assert.equal((await directLookup()).status,200);
  assert.equal(counts.writes,1);
  assert.equal(counts.provider,1);
});

test('Primary batch capability checks the existing proof and ledger without adding startup work or consumption',async t=>{
  const {config,directLookup,counts,ledger,env}=await addressFixture(t,{approved:true});
  assert.equal((await config(true)).allowExternalBatchAddressLookup,false);
  assert.deepEqual(counts,{reads:0,writes:0,provider:0});
  assert.equal((await config()).allowExternalBatchAddressLookup,true);
  assert.deepEqual(counts,{reads:1,writes:0,provider:0});
  ledger.diagnosticPassed=false;
  assert.equal((await config()).allowExternalBatchAddressLookup,false);
  ledger.diagnosticPassed=true;
  env.OPSMAP_KAKAO_FREE_QUOTA_VERIFIED='0';
  assert.equal((await config()).allowExternalBatchAddressLookup,false);
  env.OPSMAP_KAKAO_FREE_QUOTA_VERIFIED='1';
  assert.equal((await directLookup()).status,200);
  assert.equal((await config()).allowExternalBatchAddressLookup,false);
  const blocked=await directLookup();
  assert.equal(blocked.status,429);
  assert.equal((await blocked.json()).error,'GEOCODE_DAILY_LIMIT');
  assert.equal(counts.writes,1);
  assert.equal(counts.provider,1);
});

test('Primary batch stays disabled with an invalid limit or a non-durable ledger',async t=>{
  const invalid=await addressFixture(t,{approved:true,dailyLimit:'1001'});
  assert.equal((await invalid.config()).allowExternalBatchAddressLookup,false);
  const volatile=await addressFixture(t,{approved:true,durable:false});
  assert.equal((await volatile.config()).allowExternalBatchAddressLookup,false);
  assert.deepEqual(volatile.counts,{reads:0,writes:0,provider:0});
});
