import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash, webcrypto} from 'node:crypto';

const source = fs.readFileSync(new URL('../public/opsmap/customer-registry.js', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
const active = (customerCode, overrides = {}) => ({customerCode, customerName: `합성 ${customerCode}`, basicAddress: '합성시 합성로 10', addressHash: sha('합성시 합성로 10'), lifecycle: 'ACTIVE', sourceUpdatedAt: '2026-11-04T00:00:00Z', ...overrides});
const page = (rows, overrides = {}) => ({contract: 'customer-registry-v1', version: 'v1', sourceVersion: 'source-v1', rows, mode: 'FULL', afterCursor: null, nextCursor: 'checkpoint-1', complete: true, deletionPolicy: 'EXPLICIT_ONLY', ...overrides});
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
function load(options = {}) {
  const context = {window: {crypto: webcrypto}, TextEncoder, AbortController};
  vm.runInNewContext(source, context);
  return {module: context.window.MapCustomerRegistry, api: context.window.MapCustomerRegistry.create(options)};
}
const copy = value => JSON.parse(JSON.stringify(value));

test('4843 synthetic Delivery rows merge by customerCode and Customer-only rows gain no visits', async () => {
  const observed = Array.from({length: 4843}, (_, index) => ({customerCode: `S${100000 + index}`, customerName: '합성 관측점', address: '합성시 이전로 1', lastDeliveryDate: '2026-10-01', history: [{date: '2026-10-01', vehicle: '101'}], deliveryCount90d: 3, periodAggregate: {verified: true, count: 3}}));
  const before = JSON.stringify(observed);
  const {api} = load({readPage: async () => ({ok: true, data: page([active('S100000'), active('S990001')])})});
  await api.sync();
  const rows = api.merge(observed), old = rows.find(row => row.customerCode === 'S100000'), added = rows.find(row => row.customerCode === 'S990001');
  assert.equal(rows.length, 4844); assert.equal(old.customerName, '합성 S100000'); assert.equal(old.address, '합성시 합성로 10');
  assert.deepEqual(old.history, observed[0].history); assert.deepEqual(old.periodAggregate, observed[0].periodAggregate); assert.equal(old.lastDeliveryDate, observed[0].lastDeliveryDate);
  assert.equal(added.customerOnly, true); assert.equal(added.deliveryObserved, false); assert.equal(added.deliveryCount90d, null); assert.equal(added.lastDeliveryDate, '');
  assert.equal(added.history.length, 0); assert.equal(added.relations.length, 0); assert.equal(added.vehicle, ''); assert.equal(added.baseVehicle, ''); assert.equal(JSON.stringify(observed), before);
});

test('same-address shop-in-shop codes remain independently searchable identities', async () => {
  const {api} = load({readPage: async () => page([active('S990001'), active('S990002', {customerName: '합성 다른매장'})])});
  await api.sync(); const rows = api.merge([]);
  assert.equal(rows.length, 2); assert.equal(rows[0].address, rows[1].address); assert.notEqual(rows[0].customerCode, rows[1].customerCode);
  assert.equal(api.priorityRows(rows, {query: '다른매장'}, {limit: 1})[0].customerCode, 'S990002');
});

test('updated names, addresses and hashes reach row and cloned raw without changing Delivery evidence', async () => {
  const observed = {customerCode: 'S990001', customerName: '합성 구명칭', address: '합성시 구주소 1', originalAddressHash: sha('합성시 구주소 1'), raw: {address: '합성시 구주소 1', lastDeliveryDate: '2026-10-01'}, history: [{date: '2026-10-01'}]};
  const frozen = JSON.stringify(observed), {api} = load({readPage: async () => page([active('S990001')])});
  await api.sync(); const row = api.merge([observed])[0];
  assert.equal(row.raw.address, row.address); assert.equal(row.raw.currentAddressHash, row.currentAddressHash); assert.equal(row.raw.customerName, row.customerName);
  assert.equal(row.originalAddressHash, observed.originalAddressHash); assert.equal(row.raw.lastDeliveryDate, '2026-10-01'); assert.equal(JSON.stringify(observed), frozen);
});

test('changed-address GPS, manual and verified points are held while their original evidence remains intact', async () => {
  const {api} = load({readPage: async () => page([active('S990001')])}); await api.sync();
  for (const coordinateSource of ['MANUAL_PIN', 'RAW_GPS', 'DELIVERY_RECORDED', 'HISTORICAL_GPS_SAME_BUILDING', 'KAKAO_VERIFIED_BUILDING']) {
    const raw = {lat: 37.5, lng: 127, coordinateSource, originalAddressHash: sha('합성시 구주소 1')};
    const observed = {customerCode: 'S990001', address: '합성시 구주소 1', currentAddressHash: sha('합성시 구주소 1'), originalAddressHash: sha('합성시 구주소 1'), lat: 37.5, lng: 127, coordinateSource, coordinateStatus: 'CONFIRMED', resolutionStatus: 'MANUAL_CONFIRMED', raw};
    const before = JSON.stringify(observed);
    const row = api.merge([observed])[0];
    assert.equal(row.lat, null); assert.equal(row.lng, null); assert.equal(row.coordinateStatus, 'CONFLICT'); assert.equal(row.resolutionStatus, 'ADDRESS_CHANGED_REVIEW_REQUIRED');
    assert.equal(row.coordinateEvidence.lat, 37.5); assert.equal(row.coordinateEvidence.lng, 127); assert.equal(row.coordinateEvidence.coordinateSource, coordinateSource); assert.equal(row.coordinateEvidence.originalAddressHash, observed.originalAddressHash);
    assert.equal(row.raw.lat, 37.5); assert.equal(row.raw.lng, 127); assert.equal(row.raw.originalAddressHash, observed.originalAddressHash); assert.equal(JSON.stringify(observed), before);
  }
});

test('a changed display address can retain GPS or manual evidence bound to the verified current hash', async () => {
  const {api} = load({readPage: async () => page([active('S990001')])}); await api.sync();
  for (const coordinateSource of ['MANUAL_PIN', 'RAW_GPS']) {
    const row = api.merge([{customerCode: 'S990001', address: '합성시 구주소 1', currentAddressHash: sha('합성시 구주소 1'), originalAddressHash: sha('합성시 합성로 10'), lat: 37.5, lng: 127, coordinateSource, coordinateStatus: 'CONFIRMED'}])[0];
    assert.equal(row.lat, 37.5); assert.equal(row.lng, 127); assert.equal(row.coordinateStatus, 'CONFIRMED');
  }
});

test('4738 synthetic unchanged-address GPS and manual points preserve every displayed coordinate', async () => {
  const observed = Array.from({length: 4738}, (_, index) => ({customerCode: `S${100000 + index}`, address: '합성시 합성로 10', originalAddressHash: sha('합성시 합성로 10'), lat: 37.5 + index / 1000000, lng: 127, coordinateSource: index % 2 ? 'MANUAL_PIN' : 'RAW_GPS', coordinateStatus: 'CONFIRMED', resolutionStatus: index % 2 ? 'MANUAL_CONFIRMED' : 'GPS_CONFIRMED'}));
  let index = 0;
  const {api} = load({maxPages: 10, readPage: async ({cursor}) => {
    const begin = index++ * 1000, end = Math.min(begin + 1000, observed.length);
    return page(observed.slice(begin, end).map(row => active(row.customerCode)), {afterCursor: cursor, nextCursor: `page-${index}`, complete: end === observed.length});
  }});
  await api.sync(); const rows = api.merge(observed); assert.equal(rows.length, 4738);
  rows.forEach((row, index) => {for (const field of ['lat', 'lng', 'coordinateSource', 'coordinateStatus', 'resolutionStatus', 'originalAddressHash']) assert.equal(row[field], observed[index][field]);});
});

test('current address changes invalidate automatic address points but whitespace-only changes do not', async () => {
  const {api} = load({readPage: async () => page([active('S990001')])}); await api.sync();
  const base = {customerCode: 'S990001', address: '합성시 구주소 1', lat: 37.5, lng: 127, coordinateSource: 'KAKAO_ADDRESS_LIVE', coordinateStatus: 'CONFIRMED', addressLocationKey: 'old'};
  const changed = api.merge([base])[0]; assert.equal(changed.lat, null); assert.equal(changed.lng, null); assert.equal(changed.addressLocationKey, ''); assert.equal(changed.resolutionStatus, 'ADDRESS_CHANGED_REVIEW_REQUIRED');
  const same = api.merge([{...base, address: '  합성시   합성로 10  '}])[0]; assert.equal(same.lat, 37.5);
  const hashChanged = api.merge([{...base, address: '합성시 합성로 10', currentAddressHash: 'a'.repeat(64)}])[0]; assert.equal(hashChanged.lat, null);
});

test('missing source rows never imply deletion; only explicit lifecycle tombstones change status', async () => {
  const pages = [page([active('S990001'), active('S990002')]), page([active('S990003')], {version: 'v2', afterCursor: 'checkpoint-1', nextCursor: 'checkpoint-2'}), page([{customerCode: 'S990001', lifecycle: 'DELETED'}], {mode: 'DELTA', version: 'v3', afterCursor: 'checkpoint-2', nextCursor: 'checkpoint-3'})];
  const {api} = load({readPage: async () => pages.shift()}); await api.sync(); await api.sync();
  assert.equal(api.merge([]).length, 3); await api.sync();
  const rows = api.merge([{customerCode: 'S990001', history: [{date: '2026-10-01'}], lat: 37.5, lng: 127, coordinateSource: 'RAW_GPS'}]);
  assert.equal(rows.find(row => row.customerCode === 'S990001').customerRegistryStatus, 'DELETED');
  assert.equal(rows.find(row => row.customerCode === 'S990001').history.length, 1); assert.equal(rows.find(row => row.customerCode === 'S990001').lat, 37.5);
  assert(rows.some(row => row.customerCode === 'S990002')); assert.equal(api.merge([]).length, 2);
});

test('a later explicit ACTIVE record can revive a deleted Customer', async () => {
  const pages = [page([{customerCode: 'S990001', lifecycle: 'DELETED'}]), page([active('S990001')], {version: 'v2', mode: 'DELTA', afterCursor: 'checkpoint-1'})];
  const {api} = load({readPage: async () => pages.shift()}); await api.sync(); assert.equal(api.merge([]).length, 0); await api.sync(); assert.equal(api.merge([])[0].customerRegistryStatus, 'ACTIVE');
});

test('bounded pages stage atomically and resume their cursor before exposing a complete generation', async () => {
  const requests = [], pages = [page([active('S990001')], {complete: false, nextCursor: 'page-2'}), page([active('S990002')], {afterCursor: 'page-2'})];
  const {api} = load({maxPages: 1, readPage: async request => {requests.push(request); return pages.shift();}});
  await api.sync({selection: {customerCode: 'S990002', center: '합성센터', vehicles: ['101']}});
  assert.equal(api.summary().status, 'partial'); assert.equal(api.summary().pendingPages, 1); assert.equal(api.merge([]).length, 0);
  await api.sync(); assert.equal(api.merge([]).length, 2); assert.equal(requests[0].cursor, null); assert.equal(requests[1].cursor, 'page-2'); assert.equal(requests[0].selection.customerCode, 'S990002'); assert.equal(requests[0].limit, 250);
});

test('failed partial generation preserves the last complete values and retries its committed cursor', async () => {
  const requests = [], responses = [page([active('S990001')]), page([active('S990001', {customerName: '합성 미완료명칭'})], {version: 'v2', mode: 'DELTA', afterCursor: 'checkpoint-1', complete: false, nextCursor: 'page-v2-2'}), Error('SYNTHETIC_NETWORK'), page([active('S990002')], {version: 'v3', afterCursor: 'checkpoint-1'})];
  const {api} = load({readPage: async request => {requests.push(request.cursor); const value = responses.shift(); if (value instanceof Error) throw value; return value;}});
  await api.sync(); await assert.rejects(api.sync(), /CUSTOMER_REGISTRY_SOURCE_UNAVAILABLE/);
  assert.equal(api.merge([])[0].customerName, '합성 S990001'); assert.equal(api.summary().version, 'v1'); assert.equal(api.summary().pendingPages, 0);
  await api.sync(); assert.deepEqual(requests, [null, 'checkpoint-1', 'page-v2-2', 'checkpoint-1']); assert.equal(api.merge([]).length, 2);
});

test('simultaneous refresh requests share one in-flight read', async () => {
  const wait = deferred(); let calls = 0; const {api} = load({readPage: async () => {calls++; return wait.promise;}});
  const first = api.sync(), second = api.sync(); assert.equal(first, second); wait.resolve(page([active('S990001')])); await first; assert.equal(calls, 1);
});

test('duplicate committed versions cannot reapply rows; NOOP retains rows and checkpoint', async () => {
  const responses = [page([active('S990001')]), page([active('S990001', {customerName: '합성 중복변경'})], {afterCursor: 'checkpoint-1'}), page([], {mode: 'NOOP', afterCursor: 'checkpoint-1'})];
  const {api} = load({readPage: async () => responses.shift()}); await api.sync(); await api.sync(); await api.sync();
  assert.equal(api.merge([])[0].customerName, '합성 S990001'); assert.equal(api.summary().version, 'v1'); assert.equal(api.summary().cursor, 'checkpoint-1');
});

test('repeated cursors, mismatched page versions and invalid rows never enter the committed registry', async () => {
  for (const next of [
    page([active('S990002')], {version: 'v2', afterCursor: 'page-2'}),
    page([active('S990002')], {afterCursor: 'wrong'}),
    page([active('S990002')], {afterCursor: 'page-2', nextCursor: 'page-2', complete: false}),
    page([active('S990002'), active('S990002')], {afterCursor: 'page-2'})
  ]) {
    const responses = [page([active('S990001')], {complete: false, nextCursor: 'page-2'}), next];
    const {api} = load({readPage: async () => responses.shift()}); await assert.rejects(api.sync(), /CUSTOMER_REGISTRY_/); assert.equal(api.summary().count, 0);
  }
});

test('logout purges all private metadata and rejects an otherwise valid late response', async () => {
  const wait = deferred(); let calls = 0; const {api} = load({readPage: async () => ++calls === 1 ? page([active('S990001')]) : wait.promise});
  await api.sync(); const late = api.sync(); api.purge(); assert.equal(api.summary().count, 0); assert.equal(api.merge([{customerCode: 'S990001'}]).length, 0);
  wait.resolve(page([active('S990002')], {version: 'v2', afterCursor: 'checkpoint-1'})); await assert.rejects(late, {name: 'AbortError'}); assert.equal(api.summary().count, 0); assert.equal(api.summary().status, 'logged-out');
});

test('authentication loss also purges retained rows without requiring a renderer callback', async () => {
  let authenticated = true; const {api} = load({authenticated: () => authenticated, readPage: async () => page([active('S990001')])});
  await api.sync(); authenticated = false; assert.equal(api.merge([]).length, 0); assert.equal(api.summary().count, 0); assert.equal(api.summary().status, 'logged-out');
});

test('authentication loss during a read purges rows before rejecting the response', async () => {
  let authenticated = true, calls = 0; const wait = deferred();
  const {api} = load({authenticated: () => authenticated, readPage: async () => ++calls === 1 ? page([active('S990001')]) : wait.promise});
  await api.sync(); const pending = api.sync(); authenticated = false; wait.resolve(page([active('S990002')], {version: 'v2', afterCursor: 'checkpoint-1'}));
  await assert.rejects(pending, {name: 'AbortError'}); assert.equal(api.summary().count, 0);
});

test('reconnect refetches from the source origin and old-session responses cannot repopulate it', async () => {
  const old = deferred(), requests = []; let calls = 0;
  const {api} = load({readPage: async request => {requests.push(request.cursor); calls++; return calls === 1 ? page([active('S990001')]) : calls === 2 ? old.promise : page([active('S990002')], {version: 'v2'});}});
  await api.sync(); const late = api.sync(); await api.reconnect(); old.resolve(page([active('S990003')], {version: 'v3', afterCursor: 'checkpoint-1'}));
  await assert.rejects(late, {name: 'AbortError'}); assert.deepEqual(requests, [null, 'checkpoint-1', null]); assert.equal(api.merge([]).length, 2); assert(!api.merge([]).some(row => row.customerCode === 'S990003'));
});

test('bulk projection excludes details, notes, contacts, provider points and invented Delivery rows', async () => {
  const {api} = load({readPage: async () => page([active('S990001', {phone: 'SYNTHETIC_PROTECTED_PHONE', detailAddress: 'SYNTHETIC_PROTECTED_DETAIL', memo: 'SYNTHETIC_PROTECTED_MEMO', lat: 37.5, lng: 127, history: [{date: '2099-01-01'}], password: 'SYNTHETIC_PROTECTED_PASSWORD'})])});
  await api.sync(); const row = api.merge([])[0], text = JSON.stringify(row);
  assert(!text.includes('SYNTHETIC_PROTECTED')); assert.equal(row.lat, null); assert.equal(row.history.length, 0); assert.equal(row.lastDeliveryDate, '');
  assert(!/localStorage|indexedDB|sessionStorage|fetch\(|geocode|lookup\(/.test(source.replace(/ADDRESS_GEOCODE|GEOCODE_AUTO/g, '')));
});

test('selection, search, vehicle and center priorities are bounded before background candidates', () => {
  const {module} = load(); const rows = [
    {customerCode: 'S1'}, {customerCode: 'S2', center: '합성센터'}, {customerCode: 'S3', baseVehicle: '101'},
    {customerCode: 'S4', center: '합성센터', vehicle: '101'}, {customerCode: 'S5', customerName: '합성 검색점'}, {customerCode: 'S6'},
    {customerCode: 'S7', customerRegistryStatus: 'DELETED'}
  ];
  assert.deepEqual(copy(module.priorityRows(rows, {customerCode: 'S6', query: '검색점', center: '합성센터', vehicles: ['101호차']}, {limit: 5})).map(row => row.customerCode), ['S6', 'S5', 'S4', 'S3', 'S2']);
  assert.equal(module.priorityRows(rows, {}, {limit: 2}).length, 2);
});

test('canonical fallback hashes match the existing NFKC lowercase whitespace SHA256 contract', async () => {
  const {module, api} = load({readPage: async () => page([active('S990001', {basicAddress: '  합성시   Ａ로 10 ', addressHash: undefined})])});
  assert.equal(await module.addressHash('  합성시   Ａ로 10 '), sha('  합성시   Ａ로 10 ')); await api.sync(); assert.equal(api.merge([])[0].currentAddressHash, sha('  합성시   Ａ로 10 '));
});

const search = (customerCode = 'S990001', overrides = {}) => ({customerCode, originalAddressHash: sha('합성시 합성로 10'), query: '합성시 확인된 건물', queryHash: sha('합성시 확인된 건물'), accuracy: 'BUILDING', storeInteriorVerified: false, ruleVersion: 'USER_CONFIRMED_SEARCH_ADDRESS_20261104', ...overrides});

test('validated coordinateSearch is copied through an explicit allowlist to row and cloned raw', async () => {
  for (const accuracy of ['BUILDING', 'CAMPUS']) {
    const {api} = load({readPage: async () => page([active('S990001', {coordinateSearch: search('S990001', {accuracy, password: 'SYNTHETIC_PROTECTED_PASSWORD', lat: 37.5, memo: 'SYNTHETIC_PROTECTED_NOTE'})})])});
    await api.sync(); const row = api.merge([])[0];
    assert.equal(row.coordinateSearch.accuracy, accuracy); assert.deepEqual(row.coordinateSearch, row.raw.coordinateSearch);
    assert.equal(Object.keys(row.coordinateSearch).length, 7); assert(!JSON.stringify(row).includes('SYNTHETIC_PROTECTED')); assert.equal(row.lat, null);
  }
});

test('coordinateSearch may arrive through raw but never retains other private raw fields', async () => {
  const {api} = load({readPage: async () => page([active('S990001', {raw: {coordinateSearch: search(), memo: 'SYNTHETIC_PROTECTED_NOTE'}})])});
  await api.sync(); const row = api.merge([])[0]; assert.equal(row.coordinateSearch.query, search().query); assert(!JSON.stringify(row).includes('SYNTHETIC_PROTECTED'));
});

test('tampered Customer, original-address and search-query hashes cannot replace the last verified generation', async () => {
  const invalid = [
    {addressHash: 'a'.repeat(64)},
    {coordinateSearch: search('S990002')},
    {coordinateSearch: search('S990001', {originalAddressHash: 'a'.repeat(64)})},
    {coordinateSearch: search('S990001', {queryHash: 'b'.repeat(64)})},
    {coordinateSearch: search('S990001', {query: '합성 변조주소'})},
    {coordinateSearch: search('S990001', {accuracy: 'STORE_INTERIOR'})},
    {coordinateSearch: search('S990001', {storeInteriorVerified: true})},
    {coordinateSearch: search('S990001', {ruleVersion: 'UNVERIFIED'})}
  ];
  for (const overrides of invalid) {
    const responses = [page([active('S990001')]), page([active('S990001', overrides)], {version: 'v2', afterCursor: 'checkpoint-1'})];
    const {api} = load({readPage: async () => responses.shift()}); await api.sync(); await assert.rejects(api.sync(), /CUSTOMER_REGISTRY_(?:COORDINATE_SEARCH|ADDRESS_HASH)_INVALID/);
    assert.equal(api.summary().version, 'v1'); assert.equal(api.merge([])[0].coordinateSearch, undefined);
  }
});

test('location scope fixes its first 40 eligible codes and never refills after successful points disappear', () => {
  const {api} = load(), rows = Array.from({length: 6004}, (_, index) => ({customerCode: `S${100000 + index}`}));
  const first = api.locationRows(rows); assert.equal(first.length, 40);
  const successful = new Set(first.map(row => row.customerCode));
  for (let index = 0; index < 10; index++) assert.equal(api.locationRows(rows.filter(row => !successful.has(row.customerCode))).length, 0);
  assert.equal(api.summary().locationScopes, 1);
});

test('selection scopes stay fixed when returning to an old center or vehicle', () => {
  const {api} = load(), rows = Array.from({length: 100}, (_, index) => ({customerCode: `S${100000 + index}`, center: index < 50 ? '합성A센터' : '합성B센터', baseVehicle: index < 50 ? '101' : '102'}));
  const first = api.locationRows(rows, {center: '합성A센터', vehicles: ['101']}, {limit: 2}); assert.equal(first.length, 2);
  const rest = rows.filter(row => !first.some(prior => prior.customerCode === row.customerCode));
  assert.equal(api.locationRows(rest, {center: '합성A센터', vehicles: ['101']}, {limit: 2}).length, 0);
  const second = api.locationRows(rest, {center: '합성B센터', vehicles: ['102']}, {limit: 2}); assert(second.every(row => row.center === '합성B센터'));
  assert.equal(api.locationRows(rest, {center: '합성A센터', vehicles: ['101']}, {limit: 2}).length, 0);
});

test('selected customers and validated approved searches remain eligible beyond the initial import batch', async () => {
  const rows = Array.from({length: 6004}, (_, index) => ({customerCode: `S${100000 + index}`})), selected = rows.at(-1).customerCode, approved = rows.at(-2).customerCode;
  const {api} = load({readPage: async () => page([active(approved, {coordinateSearch: search(approved)})])});
  const initial = api.locationRows(rows, {}, {limit: 2}); const rest = rows.filter(row => !initial.some(prior => prior.customerCode === row.customerCode));
  await api.sync(); assert.equal(api.locationRows(rest, {}, {limit: 2})[0].customerCode, approved);
  const explicit = api.locationRows(rest, {customerCode: selected}, {limit: 2}); assert.equal(explicit[0].customerCode, selected); assert.equal(explicit[1].customerCode, approved);
});

test('initial historical imports never refill a scope; genuinely new codes in later generations can be added once', async () => {
  const initial = [{customerCode: 'S100001'}, {customerCode: 'S100002'}], historical = [{customerCode: 'S100003'}, {customerCode: 'S100004'}], live = {customerCode: 'S100005'};
  const responses = [page(historical.map(row => active(row.customerCode))), page([active(live.customerCode)], {version: 'v2', afterCursor: 'checkpoint-1', nextCursor: 'checkpoint-2'}), page([active('S100004', {customerName: '합성 이름수정'})], {version: 'v3', afterCursor: 'checkpoint-2', nextCursor: 'checkpoint-3'})];
  const {api} = load({readPage: async () => responses.shift()}); assert.equal(api.locationRows(initial, {}, {limit: 2}).length, 2);
  await api.sync(); assert.equal(api.locationRows(historical, {}, {limit: 2}).length, 0);
  await api.sync(); assert.deepEqual(copy(api.locationRows([...historical, live], {}, {limit: 2})).map(row => row.customerCode), [live.customerCode]);
  assert.equal(api.locationRows(historical, {}, {limit: 2}).length, 0);
  await api.sync(); assert.equal(api.locationRows(historical, {}, {limit: 2}).length, 0);
});

test('reconnect keeps location eligibility fixed; logout purges scopes and blocks candidate access', async () => {
  let authenticated = true; const rows = [{customerCode: 'S100001'}, {customerCode: 'S100002'}];
  const {api} = load({authenticated: () => authenticated, readPage: async () => page([])});
  assert.equal(api.locationRows(rows, {}, {limit: 1})[0].customerCode, 'S100001'); await api.reconnect();
  assert.equal(api.locationRows(rows.slice(1), {}, {limit: 1}).length, 0);
  authenticated = false; assert.equal(api.locationRows(rows).length, 0); assert.equal(api.summary().locationScopes, 0);
});
