import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {customerRegistryPage} from '../src/privateCustomerRegistry.js';
import {createStageStaffRegistryAsset, mountStageStaffRegistry, sealStageStaffRegistry,
  STAGE_STAFF_REGISTRY_PATH} from '../src/stageStaffRegistryAsset.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageScope.js';

const key = Buffer.alloc(32,7).toString('base64');
const ref = 'a'.repeat(40);
const env = {RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE,
  OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:key, OPSMAP_SNAPSHOT_STORE_TOKEN:'synthetic-reader'};
const makeDoc = () => {
  const centers = [{code:'012',centerGroup:'yeongnam',registered:7655,sourceSha256:'1'.repeat(64)},
    {code:'013',centerGroup:'honam',registered:3443,sourceSha256:'2'.repeat(64)}];
  const rows = [7601,3408].flatMap((count,index) => Array.from({length:count},(_,i) => ({
    customerCode:'S' + (index * 10000 + i + 100000),customerName:'Synthetic ' + i,
    basicAddress:'경기 예시시 예시로 ' + (i + 1),centerGroup:centers[index].centerGroup
  })));
  return {schema:1,observedOn:'2026-11-17',centers,rows};
};
const serial = value => Buffer.from(JSON.stringify(value));
const approved = await sealStageStaffRegistry(serial(makeDoc()),key);
const manifest = {ref,sha256:approved.sha256,bytes:approved.packed.length};

function reader(options = {}) {
  let requests = 0;
  const asset = createStageStaffRegistryAsset({env,manifest,...options,fetchImpl:async (input,request) => {
    requests++;
    const url = new URL(input);
    assert.equal(url.origin,'https://api.github.com');
    assert.equal(request.method,'GET');
    assert.equal(request.redirect,'error');
    assert.equal(request.headers.Authorization,'Bearer synthetic-reader');
    if (url.pathname === '/repos/mingu0702-droid/freshon-cache') return Response.json({private:options.private !== false});
    assert.equal(url.pathname,'/repos/mingu0702-droid/freshon-cache/contents/' + STAGE_STAFF_REGISTRY_PATH);
    assert.equal(url.search,'?ref=' + ref);
    assert.equal(request.headers.Accept,'application/vnd.github.raw+json');
    return options.pack ? options.pack() : new Response(approved.packed);
  }});
  return {asset,requests:()=>requests};
}

test('asset is disabled outside the exact Stage service and rejects unsafe source rows',async () => {
  for (const bad of [{manifest:null},{env:{...env,RENDER_SERVICE_ID:'production'}},
    {env:{...env,RENDER_EXTERNAL_URL:'https://production.example'}},
    {env:{...env,OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:'not a key'}}]) {
    assert.equal(reader(bad).asset,null);
  }
  const doc = makeDoc();
  doc.rows[0].basicAddress += ' 현관비밀번호 1234';
  await assert.rejects(sealStageStaffRegistry(serial(doc),key),/CUSTOMER_REGISTRY_ASSET_REJECTED/);
  doc.rows[0].basicAddress = '';
  doc.rows[0].lat = 37;
  await assert.rejects(sealStageStaffRegistry(serial(doc),key),/CUSTOMER_REGISTRY_ASSET_REJECTED/);
  delete doc.rows[0].lat;
  doc.rows[1].customerCode = doc.rows[0].customerCode;
  await assert.rejects(sealStageStaffRegistry(serial(doc),key),/CUSTOMER_REGISTRY_ASSET_REJECTED/);
});

test('one immutable private download serves all concurrent reads and Production page cap is preserved',async () => {
  const {asset,requests} = reader();
  assert.equal(requests(),0);
  const one = asset.read();
  assert.equal(asset.read(),one);
  const {snapshot,meta} = await one;
  assert.equal(await asset.read(),await one);
  assert.equal(requests(),2);
  assert.equal(meta.checkedAt,'2026-11-17');
  assert.equal(meta.source,'STAGE_FRESHON_CENTER_REGISTRY');
  assert.equal(snapshot.rows.length,11009);
  assert.equal(snapshot.rows.filter(row => row.centerGroup === 'yeongnam').length,7601);
  assert.equal(snapshot.rows.filter(row => row.centerGroup === 'honam').length,3408);
  assert.equal(customerRegistryPage(snapshot,{limit:1000,secret:asset.cursorKey}).rows.length,500);
  assert.equal(snapshot.rows.every(row => row.lifecycle === 'ACTIVE' && !Object.hasOwn(row,'lat')),true);
});

test('integrity and repository visibility fail closed while rate limits suppress repeated reads',async () => {
  const changed = Buffer.from(approved.packed);
  changed[12] ^= 1;
  const wrongTag = reader({manifest:{...manifest,sha256:createHash('sha256').update(changed).digest('hex')},pack:()=>new Response(changed)});
  for (let i = 0; i < 2; i++) await assert.rejects(wrongTag.asset.read(),/CUSTOMER_REGISTRY_ASSET_REJECTED/);
  assert.equal(wrongTag.requests(),2);
  const publicRepo = reader({private:false});
  await assert.rejects(publicRepo.asset.read(),/CUSTOMER_REGISTRY_ASSET_REJECTED/);
  assert.equal(publicRepo.requests(),1);
  let now = 1_800_000_000_000, throttled = true;
  const reset = now + 90_000;
  const limited = reader({now:()=>now,pack:()=>throttled ? new Response(null,{status:403,headers:{
    'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset/1000)
  }}) : new Response(approved.packed)});
  for (let i = 0; i < 2; i++) await assert.rejects(limited.asset.read(),error => error.retryAt === reset);
  assert.equal(limited.requests(),2);
  throttled = false;
  now = reset;
  assert.equal((await limited.asset.read()).snapshot.rows.length,11009);
  assert.equal(limited.requests(),3);
});

test('staff route pages all 11009 rows without modifying the verified registry and rechecks auth before sending',async t => {
  const app = express();
  const original = new Map(Array.from({length:6043},(_,i) => ['O'+i,{registered:true,lat:37,lng:127}]));
  let current = original, revoked = false, hold;
  const {asset,requests} = reader();
  const requireStaff = (req,res,next) => !revoked && req.get('Authorization') === 'Bearer staff'
    ? next() : res.set('Cache-Control','no-store').status(401).end();
  mountStageStaffRegistry({app,requireStaff,asset:{...asset,read:async () => {
    if (hold) await hold.promise;
    return asset.read();
  }},getVerifiedRegistry:()=>current});
  const server = app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();server.close();});
  await new Promise(resolve=>server.once('listening',resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/map-phase2b/private/customer-registry?';
  const request = (suffix,staff = true) => fetch(url + suffix, {headers:staff ? {Authorization:'Bearer staff'} : {}});
  assert.equal((await request('limit=1000',false)).status,401);
  assert.equal(requests(),0);
  assert.equal((await request('limit=1001')).status,400);
  current = null;
  const restoring = await request('limit=1000');
  assert.equal(restoring.status,503);
  assert.ok(Number(restoring.headers.get('retry-after')) > 0);
  assert.equal(requests(),0);
  current = original;
  let cursor, version, pages = 0;
  const seen = new Set();
  do {
    const response = await request('limit=1000' + (cursor ? '&cursor='+encodeURIComponent(cursor) : ''));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.match(response.headers.get('vary'),/Cookie/i);
    const {data,meta} = await response.json();
    assert.equal(data.contract,'customer-registry-v1');
    assert.equal(data.deletionPolicy,'EXPLICIT_ONLY');
    assert.equal(data.afterCursor,cursor ?? null);
    assert.equal(data.exclusions,89);
    assert.equal(meta.checkedAt,'2026-11-17');
    assert.equal(JSON.stringify(meta).includes('sourceSha256'),false);
    for (const row of data.rows) {
      assert.equal(seen.has(row.customerCode),false);
      seen.add(row.customerCode);
    }
    cursor = data.nextCursor;
    version = data.version;
    pages++;
  } while (cursor);
  assert.equal(pages,12);
  assert.equal(seen.size,11009);
  assert.equal(requests(),2);
  assert.equal((await (await request('since='+version)).json()).data.mode,'NOOP');
  assert.equal((await request('cursor=bad')).status,400);
  const overlap = new Map(original).set([...seen][0],{registered:true});
  current = overlap;
  const changedScope = await request('limit=1000');
  assert.equal(changedScope.status,503);
  assert.equal((await changedScope.json()).error,'CUSTOMER_REGISTRY_SCOPE_CHANGED');
  assert.equal(original.size,6043);
  assert.deepEqual(original.get('O0'),{registered:true,lat:37,lng:127});
  current = original;
  let started, release;
  const waiting = new Promise(resolve=>{started=resolve;});
  hold = {get promise() { started(); return new Promise(resolve=>{release=resolve;}); }};
  const inFlight = request('limit=1');
  await waiting;
  revoked = true;
  release();
  assert.equal((await inFlight).status,401);
});
