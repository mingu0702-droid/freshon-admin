import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/opsmap/map-data-sync.js';

const staffStatus = globalThis.MapFreshnessSummary.staffStatus;

test('staff see the cutoff of the applied map and a short notice during a refresh', () => {
  assert.equal(staffStatus('2026-11-07'), '매장정보 2026.11.07까지 반영');
  assert.equal(staffStatus('2026-11-07', true), '매장정보 2026.11.07까지 반영 · 새 정보 확인 중');
  assert.equal(staffStatus('2026-11-16', false, true), '오산센터 배송정보 2026.11.16까지 반영');
});

test('an unknown cutoff is shown as such without falling back to a timestamp or today', () => {
  assert.equal(staffStatus(null, true), '매장정보 확인 중');
  assert.equal(staffStatus(null), '매장정보 반영일을 확인할 수 없습니다');
  assert.equal(staffStatus('2026-11-07T12:00:00Z'), '매장정보 반영일을 확인할 수 없습니다');
  assert.equal(staffStatus('2026-02-30'), '매장정보 반영일을 확인할 수 없습니다');
});
