import test from "node:test";
import assert from "node:assert/strict";
import { createPhase2bReadCache } from "../src/phase2bReadCache.js";
import { normalizePhase2bDetail, phase2bCacheNamespace, phase2bSnapshotMeta } from "../src/phase2bOperations.js";

function cache(options = {}) {
  let time = 1000;
  const value = createPhase2bReadCache({ name: "test", ttlMs: 100, staleMs: 50, maxEntries: 4, maxBytes: 4096, now: () => time, ...options });
  return { value, advance: (ms) => { time += ms; } };
}

test("bounds cold miss loads and stores a valid response", async () => {
  const { value } = cache(); let calls = 0;
  const result = await value.load("bounds:all", async () => { calls += 1; return { ok: true, data: [1] }; });
  assert.equal(result.cache, "MISS"); assert.equal(calls, 1); assert.equal(value.stats().entries, 1);
});

test("bounds warm hit avoids the Hub loader", async () => {
  const { value } = cache(); let calls = 0; const loader = async () => ({ call: ++calls });
  await value.load("bounds:all", loader); const hit = await value.load("bounds:all", loader);
  assert.equal(hit.cache, "HIT"); assert.equal(hit.value.call, 1); assert.equal(calls, 1);
});

test("bounds concurrent same-key requests share one loader", async () => {
  const { value } = cache(); let calls = 0; let release;
  const loader = () => { calls += 1; return new Promise((resolve) => { release = resolve; }); };
  const first = value.load("bounds:101", loader); const second = value.load("bounds:101", loader);
  await new Promise((resolve) => setImmediate(resolve)); release({ ok: true });
  assert.deepEqual((await first).value, (await second).value); assert.equal(calls, 1);
});

test("bounds cache expiry serves stale and refreshes in background", async () => {
  const { value, advance } = cache(); let calls = 0; const loader = async () => ({ call: ++calls });
  await value.load("bounds:osan", loader); advance(101); const stale = await value.load("bounds:osan", loader);
  assert.equal(stale.cache, "STALE"); assert.equal(stale.value.call, 1); await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await value.load("bounds:osan", loader)).value.call, 2);
});

test("cache beyond stale window blocks for a fresh value", async () => {
  const { value, advance } = cache(); let calls = 0; const loader = async () => ({ call: ++calls });
  await value.load("detail:S1", loader); advance(151); const next = await value.load("detail:S1", loader);
  assert.equal(next.cache, "MISS"); assert.equal(next.value.call, 2);
});

test("Hub failure is never cached", async () => {
  const { value } = cache(); let calls = 0;
  await assert.rejects(value.load("detail:S2", async () => { calls += 1; throw new Error("Hub failed"); }));
  assert.equal(value.stats().entries, 0);
  await assert.rejects(value.load("detail:S2", async () => { calls += 1; throw new Error("Hub failed"); })); assert.equal(calls, 2);
});

test("failed stale refresh retains the last verified value", async () => {
  const { value, advance } = cache(); await value.load("detail:S3", async () => ({ ok: true })); advance(101);
  const stale = await value.load("detail:S3", async () => { throw new Error("refresh failed"); });
  assert.equal(stale.cache, "STALE"); assert.equal(stale.value.ok, true); await new Promise((resolve) => setImmediate(resolve)); assert.equal(value.stats().entries, 1);
});

test("SWR upstream 5xx keeps the stale user response successful", async () => {
  const { value, advance } = cache(); await value.load("bounds:all", async () => ({ ok: true, data: [1] })); advance(101);
  const stale = await value.load("bounds:all", async () => { throw Object.assign(new Error("HUB_503"), { upstreamStatus: 503 }); });
  assert.equal(stale.cache, "STALE"); assert.equal(stale.value.ok, true); await new Promise((resolve) => setImmediate(resolve)); assert.equal(value.stats().entries, 1);
});

test("SWR network failure keeps the stale user response successful", async () => {
  const { value, advance } = cache(); await value.load("detail:S4", async () => ({ ok: true, data: {} })); advance(101);
  const stale = await value.load("detail:S4", async () => { throw new TypeError("fetch failed"); });
  assert.equal(stale.cache, "STALE"); assert.equal(stale.value.ok, true); await new Promise((resolve) => setImmediate(resolve)); assert.equal(value.stats().inFlight, 0);
});

test("rejected single-flight promise is not reused", async () => {
  const { value } = cache(); let calls = 0;
  await assert.rejects(value.load("retry", async () => { calls += 1; throw new Error("first"); }));
  const recovered = await value.load("retry", async () => ({ call: ++calls }));
  assert.equal(recovered.value.call, 2); assert.equal(value.stats().inFlight, 0);
});

test("snapshot latest date changes the cache namespace", () => {
  assert.notEqual(phase2bCacheNamespace({ latestDate: "2026-09-03" }), phase2bCacheNamespace({ latestDate: "2026-09-04" }));
});

test("snapshot freshness requires recent generation and completed refresh", () => {
  const now = Date.parse("2026-09-05T00:00:00Z");
  assert.equal(phase2bSnapshotMeta({ generatedAt: "2026-09-04T23:00:00Z", latestDate: "2026-09-04", rowCount: 1, refreshComplete: true }, now).stale, false);
  assert.equal(phase2bSnapshotMeta({ generatedAt: "2026-09-04T23:00:00Z", latestDate: "2026-09-04", rowCount: 1, refreshComplete: false }, now).stale, true);
  assert.equal(phase2bSnapshotMeta({ generatedAt: "2026-09-03T00:00:00Z", latestDate: "2026-09-03", rowCount: 1, refreshComplete: true }, now).stale, true);
});

test("max entries uses least-recently-used eviction", async () => {
  const { value } = cache({ maxEntries: 2 }); let calls = 0; const loader = async () => ({ call: ++calls });
  await value.load("a", loader); await value.load("b", loader); await value.load("a", loader); await value.load("c", loader);
  assert.equal((await value.load("b", loader)).cache, "MISS");
});

test("max bytes prevents oversized cache growth", async () => {
  const { value } = cache({ maxBytes: 32 }); await value.load("large", async () => ({ text: "x".repeat(100) }));
  assert.equal(value.stats().entries, 0); assert.equal(value.stats().bytes, 0);
});

test("cleanup removes entries beyond stale window", async () => {
  const { value, advance } = cache(); await value.load("old", async () => ({ ok: true })); advance(151); value.cleanup();
  assert.equal(value.stats().entries, 0);
});

test("single-flight state clears after success", async () => {
  const { value } = cache(); await value.load("ok", async () => ({ ok: true })); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.stats().inFlight, 0);
});

test("single-flight state clears after failure", async () => {
  const { value } = cache(); await assert.rejects(value.load("bad", async () => { throw new Error("bad"); })); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.stats().inFlight, 0);
});

test("detail null memo remains safe and empty", () => {
  const result = normalizePhase2bDetail({ customerCode: "S1", accessMemo: null });
  assert.equal(result.accessInfo, null); assert.equal(result.password, null); assert.equal(result.specialRemark, null);
});

test("detail cache value excludes owner phone and Claim fields", () => {
  const result = normalizePhase2bDetail({ customerCode: "S2", ownerPhone: "010-1111-2222", claim: "private", accessMemo: "점주전화: 010-1111-2222\n후문 적재" });
  assert.equal(Object.hasOwn(result, "ownerPhone"), false); assert.equal(Object.hasOwn(result, "claim"), false); assert.doesNotMatch(JSON.stringify(result), /010-1111-2222|private/);
});

test("detail normalization preserves frontend operational fields", () => {
  const result = normalizePhase2bDetail({ customerCode: "S3", customerName: "매장", customerAddress: "주소", detailAddress: "2층", confirmedVehicle: "101", lat: "37.5", lng: "127.1", deliveryPattern: "월화", deliveryCount90d: 12, accessMemo: "공동현관 1234" });
  assert.deepEqual({ code: result.customerCode, name: result.customerName, address: result.address, vehicle: result.vehicle, lat: result.lat, lng: result.lng, pattern: result.deliveryPattern, count: result.deliveryCount90d }, { code: "S3", name: "매장", address: "주소", vehicle: "101", lat: 37.5, lng: 127.1, pattern: "월화", count: 12 });
});
