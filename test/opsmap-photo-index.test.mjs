import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOpsmapPhotoIndex, createPhotoIndexCollector } from '../src/opsmapPhotoIndex.js';
import { createOperationalPhotoExtension } from '../src/opsmapOperationalPhotos.js';
import { DeliveryPhotoError, createDeliveryPhotoService } from '../src/opsmapDeliveryPhotos.js';
import { chromium } from 'playwright';
import express from 'express';

const today = '2026-11-13', oldDay = '2025-10-01', proof = 'a'.repeat(64);
const now = () => Date.parse(today + 'T03:00:00Z');
const code = 'S100', alias = 'S200';
const front = 'FRONT_DOOR_DELIVERY', inside = 'INSIDE_DELIVERY';
const plan = (extra = {}) => ({customerCode:code, from:today, through:today, aliases:[],
  retentionProof:proof, identityProof:proof, verifiedRanges:[{from:today, through:today, evidenceSha256:proof}], ...extra});
const stub = (customerCode, date, deliveryId) => ({customerCode, deliveryDate:date, deliveryId});
const photo = (kind, asset = 1) => ({kind, recordId:'901', url:'https://example.invalid/temporary',
  ref:{kind, fingerprint:asset.toString(16).padStart(64,'0'), recordFingerprint:proof, attachmentIndex:0, imageIndex:0}});
const result = (task, photos) => ({...task, status:photos.length ? 'READY' : 'EMPTY', photos});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opsmap-photo-index-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return {directory, index:createOpsmapPhotoIndex({directory, now})};
}

test('today empty still retains historical photos of each category and verified historical alias', async t => {
  const {index, directory} = await fixture(t);
  const archivePlan = plan({from:oldDay, currentFrom:today, retentionProof:null, identityProof:null,
    aliases:[{customerCode:alias, from:oldDay, through:oldDay, evidenceSha256:proof}]});
  let configuredPhotos = [photo(front), photo(inside, 2)];
  const collect = createPhotoIndexCollector({index,
    async readHubCandidates({customerCode, startDate}) {
      if (startDate === today) return [stub(code, today, '20')];
      assert.equal(customerCode, alias, 'current code cannot be queried before its verified start');
      return customerCode === alias ? [stub(alias, oldDay, '10')] : [];
    },
    async readTask(task) { return result(task, task.date === today ? [] : configuredPhotos); }
  });
  await collect({plan:archivePlan, from:today, through:today, mode:'initial'});
  for (const [photos, expected] of [[[photo(front)], [1,0]], [[photo(inside)], [0,1]], [[photo(front),photo(inside,2)], [1,1]]]) {
    configuredPhotos = photos;
    await collect({plan:archivePlan, from:oldDay, through:oldDay, mode:'incremental'});
    const page = await index.read({customerCode:code});
    assert.equal(page.state, 'COLLECTING');
    assert.deepEqual([page.counts[front],page.counts[inside]], expected);
    assert.ok(page.items.every(row => row.date === oldDay && row.customerCode === alias));
    assert.ok(page.scope.missingDays > 365);
  }
  const [name] = await readdir(directory);
  assert.doesNotMatch(await readFile(path.join(directory, name), 'utf8'), /https?:|temporary|thumbnailUrl/);
  const revoked = {...archivePlan, aliases:[]};
  await collect({plan:revoked, from:today, through:today, mode:'incremental'});
  assert.equal((await index.read({customerCode:code})).items.length, 0);
  await assert.rejects(collect({plan:{...archivePlan, aliases:[{customerCode:alias, from:oldDay, through:oldDay}]},
    from:today, through:today, mode:'initial'}), {code:'PHOTO_HISTORY_INVALID_PLAN'});
});

test('zero requires certified, paginated scope and verified attachments; failed reads preserve positives', async t => {
  const {index} = await fixture(t);
  let hubFail = false, response = 'empty';
  const collect = createPhotoIndexCollector({index,
    async readHubCandidates() { if (hubFail) throw Error('PERIOD_PAGE_INCOMPLETE'); return [stub(code, today, '99')]; },
    async readTask(task) {
      if (response === 'auth') throw new DeliveryPhotoError('UPSTREAM_AUTH_REQUIRED', 502);
      if (response === 'unknown') return {...result(task, []), status:'UNVERIFIED'};
      return result(task, response === 'empty' ? [] : [photo(front)]);
    }
  });
  const refresh = (scope = plan(), mode = 'incremental') => collect({plan:scope, from:today, through:today, mode});
  assert.equal((await index.read({customerCode:code})).state, 'COLLECTING');
  await refresh(plan({verifiedRanges:[]}));
  assert.equal((await index.read({customerCode:code})).state, 'COLLECTING');
  await refresh();
  assert.equal((await index.read({customerCode:code})).state, 'COMPLETE');
  assert.equal((await index.read({customerCode:code})).items.length, 0);
  response = 'positive';
  await refresh();
  assert.equal((await refresh(plan(), 'initial')).tasksRead, 0);
  response = 'auth';
  await refresh();
  assert.equal((await index.read({customerCode:code})).state, 'AUTH_REQUIRED');
  assert.equal((await index.read({customerCode:code})).items.length, 1);
  hubFail = true;
  await refresh();
  assert.equal((await index.read({customerCode:code})).items.length, 1);
  hubFail = false;
  response = 'unknown';
  await refresh();
  assert.equal((await index.read({customerCode:code})).state, 'COLLECTING');
  assert.equal((await index.read({customerCode:code})).items.length, 1);
});

test('paginates more than 48 indexed photos and rejects a stale generation cursor', async t => {
  const {index} = await fixture(t);
  let totalTasks = 10;
  const collect = createPhotoIndexCollector({index,
    async readHubCandidates() { return Array.from({length:totalTasks}, (_, i) => stub(code, today, String(10 + i))); },
    async readTask(task) { return result(task, Array.from({length:6}, (_, i) => photo(front, i + 1))); }
  });
  const refresh = () => collect({plan:plan(), from:today, through:today, mode:'initial'});
  await refresh();
  const first = await index.read({customerCode:code}), all = [...first.items];
  for (let cursor = first.nextCursor; cursor;) {
    const page = await index.read({customerCode:code, cursor});
    all.push(...page.items);
    cursor = page.nextCursor;
  }
  assert.equal(all.length, 60);
  assert.equal(new Set(all.map(row => `${row.deliveryId}:${row.photo.ref.fingerprint}`)).size, 60);
  totalTasks++;
  await refresh();
  await assert.rejects(index.read({customerCode:code, cursor:first.nextCursor}), {code:'PHOTO_HISTORY_CHANGED'});
});

test('a source timeout stops the collection batch and retains previously confirmed photos', async t => {
  const {index} = await fixture(t);
  let timeout = false;
  const collect = createPhotoIndexCollector({index,
    async readHubCandidates() { return [stub(code, today, '99'), stub(code, today, '98')]; },
    async readTask(task) {
      if (timeout) throw new DeliveryPhotoError('PHOTO_TIMEOUT', 504);
      return result(task, [photo(front, Number(task.deliveryId))]);
    }
  });
  const collectWindow = mode => collect({plan:plan(), from:today, through:today, mode});
  assert.equal((await collectWindow('initial')).tasksRead, 2);
  timeout = true;
  const attempt = await collectWindow('incremental');
  assert.deepEqual([attempt.tasksRead, attempt.failures, attempt.authFailures], [1,1,0]);
  const page = await index.read({customerCode:code});
  assert.equal(page.state, 'FAILED');
  assert.equal(page.counts[front], 2);
});

test('Render-safe index filename keeps the same photos and seeds the next collection', async t => {
  const {index, directory} = await fixture(t);
  const identity = {customerCode:code, date:today, deliveryId:'99'};
  const collect = createPhotoIndexCollector({index,
    readHubCandidates:async () => [stub(code, today, '99')],
    readTask:async () => result(identity, [photo(front)])
  });
  await collect({plan:plan(), from:today, through:today, mode:'initial'});
  const [original] = await readdir(directory);
  await rename(path.join(directory, original), path.join(directory, 'opsmap_photo_s100.json'));
  assert.equal((await index.read({customerCode:code})).counts[front], 1);
  const next = await collect({plan:plan(), from:today, through:today, mode:'initial'});
  assert.equal(next.tasksRead, 0);
  assert.equal((await index.read({customerCode:code})).counts[front], 1);
});

test('a mounted legacy index preserves delivery photos and keeps inspection-only history unconfirmed', async t => {
  const {index, directory} = await fixture(t);
  const mount = path.join(directory, 'mounted');
  await mkdir(mount);
  const legacy = await index.update(plan(), async () => ({
    schema:1, plan:plan(), discovery:{[today]:'CHECKED'},
    tasks:[{customerCode:code, date:today, deliveryId:'99', state:'CHECKED', photos:[photo(front), photo('REFRIGERATOR_DOOR', 2)]}]
  }));
  const [original] = (await readdir(directory)).filter(name => name.endsWith('.json'));
  const mounted = path.join(mount, 'snapshot.json');
  await rename(path.join(directory, original), mounted);
  const named = path.join(directory, 'opsmap_photo_s100.json');
  // Simulate Render's mounted filename without requiring Windows symlink privileges.
  const {lstat, realpath} = fs;
  t.mock.method(fs, 'lstat', file => file === named
    ? Promise.resolve({isSymbolicLink:() => true, isFile:() => false}) : lstat(file));
  t.mock.method(fs, 'realpath', file => file === named ? Promise.resolve(mounted) : realpath(file));
  await assert.rejects(index.read({customerCode:code}), {code:'PHOTO_HISTORY_INDEX_INVALID'});
  const reader = createOpsmapPhotoIndex({directory, now, allowMountedLinks:true});
  const page = await reader.read({customerCode:code});
  assert.deepEqual(page.counts, {[front]:1,[inside]:0});
  assert.equal(page.state, 'COLLECTING');
  assert.equal((await readFile(mounted)).length, legacy);
  const data = JSON.parse(await readFile(mounted, 'utf8'));
  data.tasks[0].photos.shift();
  await writeFile(mounted, JSON.stringify(data));
  const inspections = await reader.read({customerCode:code});
  assert.equal(inspections.items.length, 0);
  assert.equal(inspections.state, 'COLLECTING');
});

test('actual parser shape keeps types distinct, list never hits upstream, and alias media rechecks old identity', async t => {
  const {index} = await fixture(t);
  const calls = [];
  let session = true, upstreamCode = alias;
  const extension = createOperationalPhotoExtension({enabled:true, hasMemorySession:() => session,
    async rawRequest(request) {
      calls.push(request);
      if (!session) return new Response(null, {status:401});
      if (!request.endsWith('/status-record')) return Response.json({id:10, customer:{erpCode:upstreamCode},
        carrier:{enteringDatedAt:today + 'T00:00:00+09:00'}});
      return Response.json([{id:700, status:'COMPLETED', completeType:'FRONT_DOOR', completeTypeText:'매장문앞', taskAttachments:[
        {typeText:'상품을 잘 적치하셨나요? - 매장 문 앞',images:[{url:'https://static.chabyulhwa.com/d?token=temp'}]},
        {type:'INSIDE_PRODUCT',typeText:'냉장고 문은 잘 닫았나요?',images:[{url:'https://static.chabyulhwa.com/c?token=temp'}]},
        {typeText:'매장 출입문은 잘 잠궜나요?',images:[{url:'https://static.chabyulhwa.com/l?token=temp'}]}
      ]}, {id:701, status:'COMPLETED', completeType:'BASIC', completeTypeText:'매장안', taskAttachments:[
        {type:'INSIDE_PRODUCT',typeText:'상품을 잘 적치하셨나요? - 매장 안',images:[{url:'https://static.chabyulhwa.com/i'}]}
      ]}]);
    }
  });
  const collect = createPhotoIndexCollector({index, readTask:extension.readIndexTask,
    async readHubCandidates({customerCode}) { return customerCode === alias ? [stub(alias, today, '10')] : []; }
  });
  const input = {plan:plan({currentFrom:today, aliases:[{customerCode:alias, from:today, through:today, evidenceSha256:proof}]}),
    from:today, through:today, mode:'incremental'};
  await collect(input);
  assert.deepEqual(calls, ['/api/bali/task/10','/api/bali/task/10/status-record']);
  let mediaChecks = 0;
  const service = createDeliveryPhotoService({enabled:true, source:{list:()=>[], readIndexedHistory:index.read,
    openMedia(identity, ref) { mediaChecks++; assert.deepEqual(identity, {customerCode:alias,date:today,deliveryId:'10'});
      assert.equal(ref.kind, inside); return extension.readIndexTask(identity); }
  }});
  const before = calls.length;
  const list = await service.listHistory({customerCode:code}, 'staff');
  assert.equal(list.state, 'COMPLETE');
  assert.deepEqual(list.counts, {[front]:1,[inside]:1});
  assert.doesNotMatch(JSON.stringify(list), /static\.chabyulhwa|token=temp|fingerprint|S200/);
  assert.equal(calls.length, before);
  const id = list.items.find(item => item.photo.kind === inside).photo.id;
  await assert.rejects(service.openMedia(id, 'different-staff'), {code:'PHOTO_NOT_FOUND'});
  await service.openMedia(id, 'staff');
  assert.equal(mediaChecks, 1);
  upstreamCode = code;
  await assert.rejects(service.openMedia(id, 'staff'), {code:'DELIVERY_IDENTITY_MISMATCH'});
  session = false;
  await collect(input);
  const saved = await service.listHistory({customerCode:code}, 'staff');
  assert.equal(saved.state, 'AUTH_REQUIRED');
  assert.deepEqual(saved.counts, list.counts);
});

test('staff HTTP index and existing media route share authorization and proxy only on demand', async t => {
  const {index} = await fixture(t);
  const calls = [];
  const extension = createOperationalPhotoExtension({enabled:true, hasMemorySession:() => true, readIndexedHistory:index.read,
    async rawRequest(request) {
      calls.push(request.endsWith('/status-record') ? 'record' : 'task');
      return request.endsWith('/status-record') ? Response.json([{id:700, status:'COMPLETED', completeType:'BASIC', completeTypeText:'매장안', taskAttachments:[
        {type:'INSIDE_PRODUCT',typeText:'상품을 잘 적치하셨나요? - 매장 안', images:[{url:'https://static.chabyulhwa.com/c?signature=temporary'}]}
      ]}]) : Response.json({id:10, customer:{erpCode:code}, carrier:{enteringDatedAt:today + 'T00:00:00+09:00'}});
    },
    async imageFetch(_url, options) {
      calls.push('image');
      assert.equal(options.credentials, 'omit');
      return new Response(new Uint8Array([1,2,3]), {headers:{'Content-Type':'image/jpeg'}});
    }
  });
  const collect = createPhotoIndexCollector({index, readTask:extension.readIndexTask,
    async readHubCandidates() { return [stub(code, today, '10')]; }
  });
  await collect({plan:plan(), from:today, through:today, mode:'initial'});
  const app = express();
  extension.mount({app, previewEnabled:() => true, requireStaff(req,res,next) {
    if (!req.headers['x-fixture-staff']) return res.sendStatus(401);
    res.locals.staffSession = {key:req.headers['x-fixture-staff'], expiresAt:Date.now()+60000, idleExpiresAt:Date.now()+60000};
    return next();
  }, isSessionCurrent:() => true});
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = origin + '/api/map-phase2b/private/delivery-photos/history?customerCode=' + code;
  assert.equal((await fetch(url)).status, 401);
  const headers = {'x-fixture-staff':'first'};
  const list = await fetch(url, {headers});
  assert.equal(list.status, 200);
  assert.match(list.headers.get('cache-control'), /no-store/);
  const {data} = await list.json();
  assert.equal(data.counts[inside], 1);
  assert.deepEqual(calls, ['task','record']);
  const media = origin + data.items[0].photo.url;
  assert.equal((await fetch(media,{headers:{'x-fixture-staff':'second'}})).status, 404);
  const loaded = await fetch(media, {headers});
  assert.equal(loaded.status, 200);
  assert.deepEqual(new Uint8Array(await loaded.arrayBuffer()), new Uint8Array([1,2,3]));
  assert.deepEqual(calls, ['task','record','task','record','image']);
});

test('browser lists both indexed types without loading media and keeps list on upstream auth failure', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.route('https://fixture.example/**', route => route.fulfill({contentType:'text/html', body:'<section id="photos"></section>'}));
    await page.goto('https://fixture.example/');
    await page.addScriptTag({path:fileURLToPath(new URL('../public/opsmap/opsmap-delivery-photos.js', import.meta.url))});
    await page.evaluate(async ({code, front, inside, today}) => {
      window.mediaCalls = 0;
      window.historyFailure = null;
      const photo = (kind, id) => ({id,kind,recordId:'9',url:`/api/map-phase2b/private/delivery-photos/media/${id}`});
      const data = {mode:'INDEXED', customerCode:code, state:'AUTH_REQUIRED', scope:{from:today,through:today,missingDays:1},
        counts:{[front]:1,[inside]:1}, nextCursor:null, items:[{date:today,deliveryId:'10',photo:photo(front,'fakeFront1')},
          {date:today,deliveryId:'10',photo:photo(inside,'fakeCold12')}]};
      window.controller = MapDeliveryPhotos.createController({host:document.querySelector('#photos'), async fetcher(route) {
        if (route.endsWith('/auth/session')) return Response.json({authenticated:true, expiresAt:Date.now()+60000, idleExpiresAt:Date.now()+60000});
        if (route.includes('/history?')) return window.historyFailure
          ? Response.json({ok:false,error:{code:'PHOTO_TIMEOUT'}}, {status:window.historyFailure}) : Response.json({ok:true,data});
        window.mediaCalls++;
        return Response.json({ok:false,error:{code:'UPSTREAM_AUTH_REQUIRED'}}, {status:502});
      }});
      await window.controller.open({customerCode:code, history:true});
    }, {code,front,inside,today});
    assert.equal(await page.evaluate(() => window.mediaCalls), 0);
    await page.getByRole('button',{name:`${today} · 사진 확대`}).last().click();
    await page.getByText('사진 파일 인증이 필요합니다.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.mediaCalls), 1);
    assert.equal(await page.getByRole('heading',{name:'매장 문 앞 납품 사진 · 1장'}).count(), 1);
    assert.equal(await page.getByRole('heading',{name:'매장 안 납품 사진 · 1장'}).count(), 1);
    await page.getByRole('button',{name:'확대 사진 닫기'}).click();
    await page.evaluate(() => { window.historyFailure = 504; });
    await page.getByRole('button',{name:'다시 조회',exact:true}).click();
    await page.getByText('과거 이력 갱신 실패 · 마지막 확인 목록입니다.').waitFor();
    assert.equal(await page.getByRole('button',{name:`${today} · 사진 확대`}).count(), 2);
    await page.evaluate(() => { window.historyFailure = 401; });
    await page.getByRole('button',{name:'다시 조회',exact:true}).click();
    await page.getByText('직원 인증이 만료되었습니다.',{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:`${today} · 사진 확대`}).count(), 0);
  } finally { await browser.close(); }
});
