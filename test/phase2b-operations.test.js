import test from "node:test";
import assert from "node:assert/strict";
import { calculateVehicleEta, mergeHubBoundsPayloads, parseAccessMemo, splitHubBounds } from "../src/phase2bOperations.js";

test("ETA uses recent and overall valid completion intervals", () => {
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  const events = [0, 12, 27, 41, 59].map((minutes) => ({ time: base + minutes * 60000 }));
  const eta = calculateVehicleEta(events, 3, base + 60 * 60000);
  assert.equal(eta.estimateConfidence, "보통");
  assert.ok(eta.avgMinutesPerStop >= 12 && eta.avgMinutesPerStop <= 18);
  assert.ok(eta.remainingMinutes >= 36 && eta.remainingMinutes <= 54);
  assert.ok(eta.estimatedEndAt);
});

test("ETA is withheld when completion evidence is insufficient", () => {
  const eta = calculateVehicleEta([{ time: 1 }, { time: 601000 }], 7, 700000);
  assert.equal(eta.estimatedEndAt, null);
  assert.equal(eta.remainingMinutes, null);
  assert.equal(eta.estimateConfidence, "산출 중");
});

[
  ["출입방법: 경비실 호출\n비밀번호: 103891#/", "경비실 호출", "103891#/", ""],
  ["도어락 비밀번호: 3488*", "", "3488*", ""],
  ["번호키 7788#\n특이사항: 후문 이용", "", "7788#", "후문 이용"],
  ["공동현관: A1200/\n비고: 새벽배송", "", "A1200/", "새벽배송"],
  ["출입정보: 정문 경비실\n보안키 K-22#\n점주 연락처 010-1234-5678", "정문 경비실", "K-22#", ""]
].forEach(([memo, accessInfo, password, specialRemark], index) => {
  test(`access memo sample ${index + 1} preserves safe credentials`, () => {
    assert.deepEqual(parseAccessMemo(memo), { accessInfo, password, specialRemark });
  });
});

[
  ["*출입방법: 1004", "1004"],
  ["도어락 비밀번호 : 2740*", "2740*"],
  ["출입문 도어락 : *8822*", "*8822*"],
  ["*출입비밀번호 : 5188*/ 도어락 뚜껑 닫은 뒤 잠금 확인", "5188*"],
  ["*출입방법: 건물 우측 전기단자함 보안키 확인 (사용후 제자리) / *특이사항: 4시까지 영업", ""]
].forEach(([memo, password], index) => {
  test(`live Customer access memo pattern ${index + 1}`, () => {
    const parsed = parseAccessMemo(memo);
    assert.equal(parsed.password, password);
    assert.doesNotMatch(`${parsed.accessInfo} ${parsed.specialRemark}`, /010[-\s]?\d{3,4}[-\s]?\d{4}/);
  });
});

test("whole-country bounds are split within the Hub five-degree contract", () => {
  const tiles = splitHubBounds({ south: 33, west: 124, north: 39, east: 132 });
  assert.equal(tiles.length, 4);
  tiles.forEach((tile) => {
    assert.ok(tile.north - tile.south <= 5);
    assert.ok(tile.east - tile.west <= 5);
  });
});

test("Osan bounds remain a single Hub request", () => {
  assert.equal(splitHubBounds({ south: 36.8, west: 126.6, north: 37.8, east: 127.3 }).length, 1);
});

test("vehicle 101 bounds remain a single Hub request", () => {
  assert.equal(splitHubBounds({ south: 37.45, west: 127.0, north: 37.55, east: 127.1 }).length, 1);
});

test("tiled bounds merge removes overlap duplicates and respects limit", () => {
  const payload = mergeHubBoundsPayloads([
    { data: [{ customerCode: "S1", vehicle: "101", lat: 37, lng: 127 }] },
    { data: [{ customerCode: "S1", vehicle: "101", lat: 37, lng: 127 }, { customerCode: "S2", vehicle: "102", lat: 36, lng: 128 }] }
  ], 2);
  assert.equal(payload.meta.tileCount, 2);
  assert.deepEqual(payload.data.map((row) => row.customerCode), ["S1", "S2"]);
});

test("null access memo produces an empty safe detail", () => {
  assert.deepEqual(parseAccessMemo(null), { accessInfo: "", password: "", specialRemark: "" });
});
