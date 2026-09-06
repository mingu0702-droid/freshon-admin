import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import "../public/phase2b-ui-helpers.js";

const helpers = globalThis.Phase2bUi;
const runtime = await readFile(new URL("../public/map-phase2b-runtime.js", import.meta.url), "utf8");
function fixture() {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", value: "", style: {}, disabled: false, options: [], classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, add() {} });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ window: { VEHICLE_AREA_DATA: { vehicles: [] } }, document: { querySelector: node, querySelectorAll: () => [] }, console, Intl, Date, Number, URL, URLSearchParams, Map, Set, AbortController, setTimeout, clearTimeout, performance, innerWidth: 1440, innerHeight: 900, requestAnimationFrame: () => {}, Phase2bUi: helpers });
  vm.runInContext(runtime.slice(0, runtime.lastIndexOf("  initVehicles();")) + `
    window.test = { state, nodes: $, judgeNewAreaPoint, toggleBoundaries, normalizeRouteStop, normalizeApiStore, setStores: (rows) => { allStores = rows; }, setSelected: (values) => { selectedVehicles = () => values; }, ready: () => { dateReady = true; }, loadOperationStatus, changeSelectedDate, setSnapshot: (rows) => { latestSnapshotRows = rows; }, stubUi: () => { loadBaseMap = async () => {}; ensureDateVehicles = () => {}; refreshDriverMaster = () => {}; }, getStores: () => allStores, localDate, setFetch: (fn) => { fetchJson = fn; }, noDraw: () => { drawSelectedBoundaries = () => {}; } };
  })();`, ctx);
  return ctx.window.test;
}

test("geocode removes building/unit suffixes and never accepts a different road number", () => {
  assert.deepEqual(helpers.addressVariants("서울 강남구 테헤란로 152 (강남파이낸스센터) 3층"), ["서울 강남구 테헤란로 152 (강남파이낸스센터) 3층", "서울 강남구 테헤란로 152 3층", "서울 강남구 테헤란로 152"]);
  assert.equal(helpers.addressMatches("서울 강남구 테헤란로 152", "서울 강남구 테헤란로 152"), true);
  assert.equal(helpers.addressMatches("서울 강남구 테헤란로 152", "서울 강남구 테헤란로 1520"), false);
  assert.equal(helpers.addressMatches("서울 강남구 테헤란로 152", "경기 수원시 테헤란로 152"), false);
});

test("30km references use nearest delivery point per vehicle and exclude distant/invalid points", () => {
  const rows = helpers.nearbyVehicles({ lat: 37, lng: 127 }, [{ vehicle: "101", lat: 37.01, lng: 127 }, { vehicle: "101", lat: 37.02, lng: 127 }, { vehicle: "109", lat: 37.5, lng: 127 }, { vehicle: "110", lat: null, lng: 127 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, 37.01);
});

test("selected-date boundary encloses only supplied assignments, excludes missing coordinates", () => {
  const stores = [{lat:37,lng:127},{lat:37,lng:128},{lat:38,lng:127},{lat:37.1,lng:127.1},{lat:null,lng:129}];
  const hull = helpers.deliveryBoundary(stores);
  assert.equal(hull.length, 3);
  assert.equal(hull.some((point) => point.lat === 37.1), false);
  assert.equal(helpers.deliveryBoundary(stores.slice(0,2)).length, 0);
});

test("500m auto decision does not recommend stores 600m or 30km away", () => {
  const f = fixture();
  f.setStores([{ vehicle: "101", lat: 37.006, lng: 127 }]);
  const outside = f.judgeNewAreaPoint({ address: "경기 오산시 테스트로 1" }, { lat: 37, lng: 127 });
  assert.equal(outside.reason, "배송동선 맞지 않음");
  assert.equal(outside.vehicle, "-");
  f.setStores([{ vehicle: "109", lat: 37.003, lng: 127 }]);
  assert.equal(f.judgeNewAreaPoint({ address: "경기 오산시 테스트로 1" }, { lat: 37, lng: 127 }).decision, "O");
});

test("boundary toggle hides only polygons and representatives, never refits or clears stores/routes", () => {
  const f = fixture();
  f.noDraw();
  let storeCalls = 0, lineCalls = 0, polygonCalls = 0, representativeMap = "map";
  f.state.map = { setBounds() { assert.fail("unexpected fit"); } };
  f.state.overlays = [{ setMap() { storeCalls++; } }];
  f.state.lines = [{ setMap() { lineCalls++; } }];
  f.state.polygons = [{ setMap(value) { assert.equal(value, null); polygonCalls++; } }];
  f.state.representativeOverlays = [{ setMap(value) { representativeMap = value; } }];
  f.state.fitRequested = false;
  f.state.selectedDate = "2026-08-11";
  f.setSelected(["101"]);
  f.toggleBoundaries();
  assert.equal(storeCalls + lineCalls, 0);
  assert.equal(polygonCalls, 1);
  assert.equal(representativeMap, null);
  assert.equal(f.state.fitRequested, false);
  assert.equal(f.state.selectedDate, "2026-08-11");
  f.toggleBoundaries();
  assert.equal(representativeMap, f.state.map);
});

test("historical status calls only the requested route date, preserves 27/10/17 and suppresses ETA", async () => {
  const f = fixture(); f.ready(); f.state.selectedDate = "2026-08-11";
  const calls = [];
  f.setFetch(async (url) => { calls.push(url); return { data: { totalStops: 27, completedStops: 10, remainingStops: 17, estimatedEndAt: new Date().toISOString() } }; });
  await f.loadOperationStatus("101");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /route-plan\?date=2026-08-11&vehicle=101$/);
  assert.equal(f.nodes("#opTotal").textContent, 27);
  assert.equal(f.nodes("#opCompleted").textContent, 10);
  assert.equal(f.nodes("#opRemaining").textContent, 17);
  assert.equal(f.nodes("#opEta").textContent, "과거 —");
});

test("live date uses current Delivery assignment over old snapshot vehicle", async () => {
  const f = fixture(); f.stubUi();
  const today = f.localDate(); f.state.latestDate = today;
  f.setSnapshot([{ customerCode: "S222538", vehicle: "101", lat: 37, lng: 127 }]);
  f.setFetch(async () => ({ data: { vehicles: [{ vehicle: "109", stops: [{ customerCode: "S222538" }] }] } }));
  await f.changeSelectedDate(today);
  assert.equal(f.getStores()[0].vehicle, "109");
  assert.equal(f.getStores()[0].lat, 37);
});

test("historical date obtains dated assignments and does not read current Delivery", async () => {
  const f = fixture(); f.stubUi(); f.state.latestDate = "2026-09-05";
  f.setSnapshot([{ customerCode: "S222538", vehicle: "109", lat: 37, lng: 127 }]);
  const urls = [];
  f.setFetch(async (url) => { urls.push(url); return { data: [{ customerCode: "S222538", vehicle: "101", lat: 37, lng: 127 }] }; });
  await f.changeSelectedDate("2026-08-11");
  assert.equal(f.getStores()[0].vehicle, "101");
  assert.match(urls[0], /mode=DATE_ROUTE&date=2026-08-11/);
  assert.equal(urls.some((url) => url.includes("today-status")), false);
});
