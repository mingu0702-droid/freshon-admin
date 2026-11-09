import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageAbValidation.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {createTemporaryOfficialAddressLookup,officialAddressKey} from '../src/opsmapOfficialAddressLookup.js';

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
