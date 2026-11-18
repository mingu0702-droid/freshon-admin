import assert from 'node:assert/strict';
import test from 'node:test';
import { readRecentOperations, recentCoverage, recentDetail, recentOperationStatus, recentRecord } from '../public/opsmap/recent-operations.mjs';

const startDate = '2026-08-20';
const endDate = '2026-11-17';
const date = '2026-10-01';
const days = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.parse(startDate) + i * 86_400_000).toISOString().slice(0, 10));
const response = fields => ({ ok: true, startDate, endDate, centers: {}, rows: [], ...fields });

test('verified records match their own center and choose the latest valid evidence', () => {
  const base = { customerCode: 'S900001', centerKey: 'osan', date, evidence: 'order_confirmed' };
  const report = readRecentOperations(response({ rows: [
    base,
    { ...base, date: '2026-02-30' },
    { ...base, date: '2026-08-19' },
    { ...base, date: '2026-11-18' },
    { ...base, date: endDate, evidence: 'dispatch_confirmed' },
    { ...base, date: endDate, customerCode: 'S900002', evidence: 'dispatch_pending' },
  ] }));
  assert.deepEqual(recentRecord(report, 'osan', base.customerCode), { date: endDate, evidence: 'dispatch_confirmed' });
  assert.equal(recentRecord(report, 'yeongnam', base.customerCode), null);
  assert.equal(recentRecord(report, 'osan', 'S900002'), null);
  assert.deepEqual(recentDetail(report, 'osan', base.customerCode), { date: '2026.11.17', evidence: '운영 확인 · 배차확정' });
});

test('observations never count as complete coverage for any missing center or date', () => {
  const report = readRecentOperations(response({ centers: {
    osan: { confirmedDays: [startDate], observedDates: [startDate, date], sourceObservedDates: { delivery_admin: days } },
    yeongnam: { confirmedDays: [date] },
    honam: { sourceUnavailable: true },
  } }));
  assert.deepEqual(recentCoverage(report, 'osan'), { state: 'partial', confirmedDays: 1, observedDates: 90 });
  assert.deepEqual(recentCoverage(report), { state: 'partial', confirmedDays: 0, observedDates: 90 });
  assert.equal(recentCoverage(report, 'honam').state, 'unknown');
  assert.equal(recentDetail(report, 'honam', 'S900001').evidence, '이력 미확인');
  assert.equal(recentDetail(null, 'osan', 'S900001', true).date, '확인 중');
});

test('record absence is known only in the matching fully verified scope', () => {
  const centers = { osan: { confirmedDays: days }, yeongnam: { confirmedDays: days }, honam: { confirmedDays: days } };
  const report = readRecentOperations(response({ centers }));
  assert.equal(recentCoverage(report).state, 'complete');
  assert.deepEqual(recentDetail(report, 'osan', 'S900001'), { date: '90일 전수 확인', evidence: '운영 없음 확인' });
  assert.equal(recentDetail(report, '', 'S900001').date, '미확인');
  const offline = readRecentOperations(response({ centers, sourceUnavailable: true }));
  assert.equal(recentCoverage(offline).state, 'partial');
  assert.equal(recentDetail(offline, 'osan', 'S900001').date, '미확인');
  assert.throws(() => readRecentOperations(response({ endDate: '2026-11-16' })), /UNAVAILABLE/);
});

test('the conservative filter excludes only fully verified absence within the same scope', () => {
  const centers={osan:{confirmedDays:days,observedDates:days},yeongnam:{observedDates:days.slice(0,75)},honam:{}};
  const rows=[{customerCode:'S900001',centerKey:'osan',date,evidence:'order_confirmed'},
    {customerCode:'S900002',centerKey:'yeongnam',date,evidence:'dispatch_confirmed'}];
  const report=readRecentOperations(response({centers,rows,expectedEndDate:endDate}));
  assert.deepEqual([...report.absenceEligibleCenters],['osan']);
  assert.equal(recentOperationStatus(report,'osan','S900001'),'operated');
  assert.equal(recentOperationStatus(report,'osan','S900002'),'unknown');
  assert.equal(recentOperationStatus(report,'osan','S900003'),'no-operation');
  assert.equal(recentOperationStatus(report,'osan','S900003',false),'unknown');
  assert.equal(recentOperationStatus(report,'yeongnam','S900003'),'unknown');
  assert.equal(recentOperationStatus(report,'honam','S900003'),'unknown');
  assert.equal(recentOperationStatus(report,'unknown','S900003'),'unknown');
  const retained=readRecentOperations(response({centers,rows,expectedEndDate:'2026-11-18'}));
  assert.equal(recentOperationStatus(retained,'osan','S900003'),'unknown');
  assert.equal(recentOperationStatus(retained,'osan','S900001'),'operated');
});
