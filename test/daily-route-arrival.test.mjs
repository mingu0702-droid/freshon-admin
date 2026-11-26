import assert from 'node:assert/strict';
import test from 'node:test';
import { orderedVisits, arrivalRouteDraft, arrivalSchedule, arrivalClock } from '../public/opsmap/daily-route-arrival.mjs';
import '../public/opsmap/kakao-directions-adapter.js';

const osan = { lat: 37.15, lng: 127.07 };
const point = order => ({ lat: 37.4 + order * 0.001, lng: 127.05, order });

test('retains the stored order and requires confirmation for missing or duplicate orders', () => {
  const a = point(1), b = point(2), unknown = { ...point(3), order: null };
  assert.deepEqual(orderedVisits([b, a]), { confirmed: true, visits: [a, b] });
  assert.deepEqual(orderedVisits([b, unknown, a]), { confirmed: false, visits: [b, unknown, a] });
  assert.equal(orderedVisits([a, { ...b, order: a.order }]).confirmed, false);
});

test('reuses the server adapter for at most 30 visits and rejects missing positions', () => {
  const visits = Array.from({ length: 30 }, (_, index) => point(index + 1));
  const maximum = arrivalRouteDraft(osan, visits);
  assert.equal(maximum.waypoints.length, 29);
  assert.equal(maximum.waypoints.at(-1).order, 29);
  assert.equal(maximum.destination.lat, visits[29].lat);
  assert.equal(KakaoDirectionsAdapter.plan(maximum).path, '/v1/waypoints/directions');
  assert.equal(KakaoDirectionsAdapter.plan(arrivalRouteDraft(osan, visits.slice(0, 6))).path, '/v1/directions');
  assert.throws(() => arrivalRouteDraft(osan, [...visits, point(31)]), /30곳/);
  assert.throws(() => arrivalRouteDraft(osan, [{ lat: null, lng: 127 }]), /위치가 미확인/);
});

test('accumulates the provider sections and stays across midnight, including visits at the same location', () => {
  const first = point(1);
  const draft = arrivalRouteDraft(osan, [first, first, point(2)]);
  const providerResponse = {
    routes: [{ result_code: 0, summary: { distance: 7500, duration: 1800 },
      sections: [
        { distance: 5000, duration: 600, roads: [{ vertexes: [osan.lng, osan.lat, first.lng, first.lat] }] },
        { distance: 2500, duration: 1200, roads: [{ vertexes: [first.lng, first.lat, first.lng, point(2).lat] }] },
      ] }],
  };
  const route = KakaoDirectionsAdapter.fromProvider(providerResponse, draft);
  const result = arrivalSchedule(route, '23:50', [15, 5, 8]);
  assert.deepEqual(result.stops.map(row => [row.distanceMeters, row.driveSeconds]), [[5000, 600], [0, 0], [2500, 1200]]);
  assert.deepEqual(result.stops.map(row => [arrivalClock(row.arrival), arrivalClock(row.departure)]), [
    ['익일 00:00', '익일 00:15'], ['익일 00:15', '익일 00:20'], ['익일 00:40', '익일 00:48'],
  ]);
  assert.equal(result.driveSeconds, 1800);
  assert.equal(result.workSeconds, 1680);
  assert.equal(result.elapsedSeconds, 3480);
  assert.equal(arrivalClock(result.finish), '익일 00:48');
  assert.equal(arrivalSchedule({ ...route, complete: false }, '23:50', [15, 5, 8]), null);
  assert.equal(arrivalSchedule({ ...route, legs: [route.legs[0], route.legs[0], route.legs[2]] }, '23:50', [15, 5, 8]), null);
  assert.equal(arrivalSchedule(route, '24:01', [15, 5, 8]), null);
  assert.equal(arrivalSchedule(route, '23:50', [15, -1, 8]), null);
});
