import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {STAGE_ORIGIN,STAGE_SERVICE,mountStageAbValidation,STAGE_ADDRESS_BATCH_ROUTE} from '../src/stageAbValidation.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {createTemporaryOfficialAddressLookup,officialAddressKey} from '../src/opsmapOfficialAddressLookup.js';
import {createKakaoGeocodeLedger,KAKAO_EXPECTED_APP_ID} from '../src/opsmap-abc/kakaoCoordinateConnection.js';
import {createStageGeocodeBudgetStore} from '../src/manualPinGithubStore.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const address = '경기도 오산시 검증로 777';
const point = {lat:37.15,lng:127.07};
const bytes = Buffer.from(JSON.stringify({schema:'opsmap-official-address-index-v1',
  source:'https://www.data.go.kr/data/15083033/fileData.do',date:'2026-09-30',datasetSha256:'a'.repeat(64),
  rows:[{addressSha256:hash(officialAddressKey(address)),buildingSha256:'b'.repeat(64),...point}]}));

test('approved official index expires and a bad replacement leaves the last good temporary index intact',()=>{
  let now = 0;
  const temporary = createTemporaryOfficialAddressLookup({sha256:hash(bytes),now:()=>now});
  assert.equal(temporary.active(),null);
  assert.equal(temporary.activate(bytes).expiresAt,'1970-01-01T02:00:00.000Z');
  assert.deepEqual(temporary.active().lookup('경기 오산시 검증로 777, 2층'),point);
  assert.equal(temporary.active().lookup('경기도 오산시 검증로 777-1'),null);
  assert.throws(()=>temporary.activate(Buffer.from('changed')),/OFFICIAL_ADDRESS_INDEX_DIGEST/);
  assert.deepEqual(temporary.active().lookup(address),point);
  now = 2 * 60 * 60 * 1000;
  assert.equal(temporary.active(),null);
});

test('signed-in Stage can use a pinned official point independently of disabled external geocoding',async t=>{
  let sessions;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin,'https://api.github.com');
    if (url.pathname.endsWith('/freshon-cache')) return Response.json({private:true,permissions:{push:true}});
    assert.match(url.pathname,/\/staff-sessions-v1\.json$/);
    if (options.method === 'PUT') {
      sessions = Buffer.from(JSON.parse(options.body).content,'base64');
      return Response.json({ok:true});
    }
    return sessions ? Response.json({size:sessions.length,sha:'c'.repeat(40),encoding:'base64',content:sessions.toString('base64')}) : new Response(null,{status:404});
  };
  const password = 'only-for-local-stage-address-test';
  const app = createStageVerificationApp({env:{RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:'test-only',OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',
    MAP_STAFF_ID:'fixture',MAP_STAFF_SESSION_SECRET:'d'.repeat(48),MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    KAKAO_MAP_JAVASCRIPT_KEY:'e'.repeat(32),OPSMAP_STAGE_OFFICIAL_ADDRESS_INDEX_SHA256:hash(bytes),OPSMAP_KAKAO_GEOCODING_ENABLED:'1'},fetchImpl});
  const server = app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();server.close();});
  await new Promise(resolve=>server.once('listening',resolve));
  const request = (suffix,options)=>fetch(`http://127.0.0.1:${server.address().port}/api/map-phase2b/`+suffix,options);
  const headers = {origin:STAGE_ORIGIN,'content-type':'application/json'};
  const index = 'private/stage-official-address-index';
  const activate = (body,extra={})=>request(index,{method:'POST',headers:{...headers,...extra},body});
  assert.equal((await activate(bytes)).status,401);
  const login = await request('auth/login',{method:'POST',headers,body:JSON.stringify({id:'fixture',password})});
  assert.equal(login.status,200);
  headers.cookie = login.headers.get('set-cookie').split(';')[0];
  const config = ()=>request('private/map-sdk-config',{headers}).then(response=>response.json());
  assert.equal((await config()).allowIndependentAddressLookup,false);
  assert.equal((await activate(bytes)).status,403);
  const operator = {'x-opsmap-stage-verification':'1'};
  assert.equal((await activate(Buffer.from('changed'),operator)).status,400);
  assert.equal((await activate(bytes,operator)).status,200);
  const capability = await config();
  assert.equal(capability.allowIndependentAddressLookup,true);
  assert.equal(capability.allowExternalAddressLookup,false);
  assert.equal(capability.addressLookupReason,'GEOCODING_DISABLED');
  const lookup = async (query,mode)=>{
    const response = await request('private/address-lookup',{method:'POST',headers,body:JSON.stringify({query,mode})});
    return {status:response.status,payload:await response.json()};
  };
  const found = await lookup(address,'official');
  assert.equal(found.status,200);
  assert.deepEqual(found.payload.data.documents,[{x:'127.07',y:'37.15'}]);
  assert.equal(found.payload.data.coordinatePersistence,false);
  assert.equal((await lookup(address+'-1','official')).payload.data.status,'ZERO_RESULT');
  assert.equal((await lookup(address,'address')).payload.error,'GEOCODING_DISABLED');
});

test('approved Stage address queries use only the separate hash-only budget and stop at its limit',async t=>{
  let session, providerCalls = 0;
  const key = '1'.repeat(32), password = 'fixture-stage-provider-read';
  let budget = Buffer.from(JSON.stringify({...createKakaoGeocodeLedger(),diagnosticUsed:true,diagnosticPassed:true}));
  const encoded = value => value ? Response.json({size:value.length,sha:'c'.repeat(40),encoding:'base64',content:value.toString('base64')})
    : new Response(null,{status:404});
  const app = createStageVerificationApp({env:{RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:'fixture',OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',
    MAP_STAFF_ID:'fixture',MAP_STAFF_SESSION_SECRET:'d'.repeat(48),MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    KAKAO_REST_API_KEY:key,KAKAO_MAP_APP_ID:KAKAO_EXPECTED_APP_ID,OPSMAP_KAKAO_REST_KEY_SHA256:hash(key),
    OPSMAP_KAKAO_FREE_QUOTA_VERIFIED:'1',OPSMAP_KAKAO_PAID_API_DISABLED:'1',OPSMAP_STAGE_KAKAO_ADDRESS_APPROVED:'1',
    OPSMAP_KAKAO_GEOCODING_ENABLED:'1',OPSMAP_KAKAO_GEOCODING_DAILY_LIMIT:'1'},fetchImpl:async(input,options={})=>{
    const url = new URL(input);
    if (url.origin === 'https://dapi.kakao.com') {
      providerCalls++;
      assert.equal(url.pathname,'/v2/local/search/address.json');
      assert.equal(options.method,'GET');
      return Response.json({meta:{is_end:true},documents:[{x:'127.07',y:'37.15',address_name:address}]});
    }
    assert.equal(url.origin,'https://api.github.com');
    if (url.pathname.endsWith('/freshon-cache')) return Response.json({private:true,permissions:{push:true}});
    const file = url.pathname.split('/').at(-1);
    assert(['staff-sessions-v1.json','geocode-budget-v1.json'].includes(file));
    assert(url.pathname.includes('/opsmap-stage/'));
    if (options.method !== 'PUT') return encoded(file==='geocode-budget-v1.json' ? budget : session);
    const body = JSON.parse(options.body);
    assert.equal(body.branch,'stage/opsmap-manual-pins');
    if (file==='geocode-budget-v1.json') budget = Buffer.from(body.content,'base64');
    else session = Buffer.from(body.content,'base64');
    return Response.json({});
  }});
  const server = app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();server.close();});
  await new Promise(resolve=>server.once('listening',resolve));
  const root = `http://127.0.0.1:${server.address().port}/api/map-phase2b/`;
  const headers = {origin:STAGE_ORIGIN,'content-type':'application/json'};
  const login = await fetch(root+'auth/login',{method:'POST',headers,body:JSON.stringify({id:'fixture',password})});
  assert.equal(login.status,200);
  headers.cookie = login.headers.get('set-cookie').split(';')[0];
  const lookup = ()=>fetch(root+'private/address-lookup',{method:'POST',headers,body:JSON.stringify({query:address,mode:'address'})});
  const found = await lookup();
  assert.equal(found.status,200);
  assert.equal((await found.json()).data.coordinatePersistence,false);
  const limited = await lookup();
  assert.equal(limited.status,429);
  assert.equal((await limited.json()).error,'GEOCODE_DAILY_LIMIT');
  assert.equal(providerCalls,1);
  assert.equal(JSON.parse(budget).used,1);
  assert(!budget.toString().includes(address));
  assert(!budget.toString().includes('127.07'));
});

test('single Stage evidence resolves only an approved unmatched address and leaves batch reads untouched',async t=>{
  const app=express(), generation='a'.repeat(64);
  const stored='경기도 오산시 저장로 124';
  const snapshot={sourceGeneration:generation,rows:[{customerCode:'T12345',address:stored,...point}]};
  let prepared={generation};
  let prechecks=0, providerCalls=0, invalidateProvider=false;
  const requireStaff=(req,res,next)=>{
    if(req.get('X-Test-Staff')!=='ok')return res.status(401).json({error:'STAFF_LOGIN_REQUIRED'});
    res.locals.staffSession={key:'local-test-only'};
    return next();
  };
  mountStageAbValidation(app,{requireStaff,isSessionCurrent:(_req,key)=>key==='local-test-only',
    validation:{active:()=>prepared,addressGenerationError:(value,current)=>value===current?.generation?null:'STAGE_BATCH_GENERATION_CHANGED'},
    readReadySnapshot:()=>snapshot,readSnapshot:async()=>snapshot,
    readOfficialIndex:()=>({lookup:q=>q===address?point:null}),
    externalAddressLookup:{
      async prepareReservation(){prechecks++;},
      async lookup(query,{assertCurrent}){
        assert.equal(query,address+'-2');
        assertCurrent();
        providerCalls++;
        if(invalidateProvider)prepared={generation:'b'.repeat(64)};
        assertCurrent();
        return {ledgerReservationMs:5,providerDurationMs:20,githubRequests:{reads:0,writes:1},
          data:{documents:[{x:'127.07',y:'37.15'}],resolution:{kind:'EXACT'}}};
      }
    }});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();server.close();});
  await new Promise(resolve=>server.once('listening',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}${STAGE_ADDRESS_BATCH_ROUTE}`;
  const request=(rows,external,headers={})=>fetch(endpoint,{method:'POST',
    headers:{origin:STAGE_ORIGIN,'content-type':'application/json','x-test-staff':'ok',...headers},
    body:JSON.stringify({generation,rows,includeCustomers:true,external})});
  const denied=await request([[address+'-2']],'resolve',{'x-test-staff':''});
  assert.equal(denied.status,401);
  assert.equal((await request([[address+'-2']],'resolve',{origin:'https://example.test'})).status,403);
  assert.equal((await request([[address+'-2',address]],'resolve')).status,400);
  assert.equal((await request([['1234567890100010000']],'resolve')).status,400);
  assert.equal((await (await request([[stored]],'resolve')).json()).data[0].status,'STORED');
  assert.equal((await (await request([[address]],'resolve')).json()).data[0].status,'OFFICIAL');
  assert.equal((await (await request([[address+'-2']])).json()).data[0].status,'ADDRESS_NOT_MATCHED');
  assert.equal((await (await request([[address+'-2']],'prepare')).json()).data[0].status,'ADDRESS_NOT_MATCHED');
  assert.equal(prechecks,1);
  assert.equal(providerCalls,0);
  const exact=await request([[address+'-2']],'resolve');
  assert.equal(exact.status,200);
  assert.equal(exact.headers.get('x-opsmap-geocode-github'),'0,1');
  assert.match(exact.headers.get('server-timing'),/opsmap-address-customer;dur=/);
  assert.match(exact.headers.get('server-timing'),/opsmap-address-official;dur=/);
  assert.equal((await exact.json()).data[0].external.resolution.kind,'EXACT');
  assert.equal(providerCalls,1);
  invalidateProvider=true;
  const expired=await request([[address+'-2']],'resolve');
  assert.equal(expired.status,409);
  assert.equal((await expired.json()).error,'STAGE_BATCH_GENERATION_CHANGED');
});

test('Stage geocode reservations verify GitHub receipts and fail closed on a stale blob', async () => {
  const path='opsmap-stage/geocode-budget-v1.json';
  const branch='stage/opsmap-manual-pins';
  const blob=value=>createHash('sha1').update('blob '+value.length+'\0').update(value).digest('hex');
  let persisted=Buffer.from(JSON.stringify(createKakaoGeocodeLedger()));
  let privateRepo=true, proofReturned=true, clock=0;
  const calls=[];
  const store=createStageGeocodeBudgetStore({
    repo:'mingu0702-droid/freshon-cache',token:'fixture',branch,clock:()=>clock,
    fetchImpl:async(input, options={})=>{
      const url=new URL(input);
      if(url.pathname.endsWith('/freshon-cache')){
        calls.push('access');
        return Response.json({private:privateRepo,permissions:{push:true}});
      }
      assert(url.pathname.endsWith('/contents/'+path));
      if(options.method!=='PUT'){
        calls.push('read');
        assert.equal(url.searchParams.get('ref'),branch);
        return Response.json({sha:blob(persisted),encoding:'base64',content:persisted.toString('base64')});
      }
      calls.push('write');
      const body=JSON.parse(options.body);
      assert.equal(body.branch,branch);
      if(body.sha!==blob(persisted))return new Response(null,{status:409});
      persisted=Buffer.from(body.content,'base64');
      return Response.json(proofReturned ? {
        content:{type:'file',path,sha:blob(persisted)},commit:{sha:'a'.repeat(40)}
      } : {});
    }
  });
  const reserve=()=>store.transaction(async(state,commit)=>{
    state.used++;
    await commit(state);
    return state.used;
  },{reservation:true});

  assert.equal(await reserve(),1);
  assert.equal(calls.filter(call=>call==='read').length,1);
  calls.length=0;
  assert.equal(await store.transaction(state=>state.used,{status:true}),1);
  assert.deepEqual(calls,[]);
  assert.equal(await reserve(),2);
  assert.deepEqual(calls,['write']);

  persisted=Buffer.from(JSON.stringify({...JSON.parse(persisted),used:3}));
  await assert.rejects(reserve(),{code:'MANUAL_PIN_GITHUB_CONFLICT'});
  assert.equal(JSON.parse(persisted).used,3);
  assert.equal(await reserve(),4);

  calls.length=0;
  proofReturned=false;
  assert.equal(await reserve(),5);
  assert.deepEqual(calls,['write','read']);

  calls.length=0;
  clock+=5000;
  privateRepo=false;
  await assert.rejects(reserve(),{code:'MANUAL_PIN_GITHUB_PRIVATE_WRITE_REQUIRED'});
  assert.deepEqual(calls,['access']);
});
