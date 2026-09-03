import test from "node:test";
import assert from "node:assert/strict";
import { calculateVehicleEta, parseAccessMemo } from "../src/phase2bOperations.js";

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
