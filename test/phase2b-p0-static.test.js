import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/map-phase2b-preview.html", import.meta.url), "utf8");
const runtime = await readFile(new URL("../public/map-phase2b-runtime.js", import.meta.url), "utf8");

test("PC and mobile map controls exist", () => {
  for (const id of ["areaToggle", "mapReset", "mobileCenter", "mobileBaseVehicle", "mobileAreaToggle", "mobileMapReset"]) assert.match(html, new RegExp(`id=["']${id}["']`));
});

test("map interaction guard and explicit fit triggers exist", () => {
  assert.match(runtime, /userMovedMap/);
  assert.match(runtime, /requestMapFit/);
  assert.match(runtime, /dragstart/);
  assert.match(runtime, /zoom_start/);
  assert.match(runtime, /resetMapOverview/);
});

test("silent delivery and nearest fallbacks are removed", () => {
  assert.doesNotMatch(runtime, /function vehicleCenters/);
  assert.doesNotMatch(runtime, /function nearestVehiclesLocal/);
  assert.doesNotMatch(runtime, /candidates\.push\(\.\.\.allStores\)/);
});

test("search supports partial customer code and customerCode dedupe", () => {
  assert.match(runtime, /code\.includes\(target\)/);
  assert.match(runtime, /const key = row\.customerCode \|\|/);
});

test("base, center and vehicle views use the verified snapshot cache", () => {
  assert.match(runtime, /allStores\.filter\(\(row\) => row\.vehicleGroup === state\.centerFilter\)/);
  assert.match(runtime, /selected\.length \? stores : representativeRows\(stores\)/);
  assert.match(runtime, /60일 스냅샷/);
  assert.match(runtime, /changeSelectedDate/);
  assert.match(runtime, /ttl:\s*300000/);
});

test("abort, stale response and timeout handling are explicit", () => {
  assert.match(runtime, /previous\.controller\.abort\("superseded"\)/);
  assert.match(runtime, /STALE_RESPONSE/);
  assert.match(runtime, /요청 시간이 초과되었습니다/);
  assert.match(runtime, /isSilentRequestError/);
});

test("single address judging validates input before geocoding", () => {
  assert.match(runtime, /주소 또는 고객정보를 정확히 입력하세요/);
  assert.match(runtime, /validNewAreaInput/);
  assert.doesNotMatch(runtime, /newAreaSingleInput/);
});
