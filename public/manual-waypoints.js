(function (root) {
  'use strict';
  function createDraft() {
    let stops = [], sequence = 0;
    const copy = () => stops.map(stop => ({ ...stop }));
    return {
      stops: copy,
      add(point) {
        if (stops.length >= 32) throw new Error('출발·도착 포함 최대 32개 지점입니다.');
        const lat = point.lat, lng = point.lng;
        if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)
          || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('확인된 위도·경도가 필요합니다.');
        // Visits are identities, not coordinates. Two shops in one building and
        // returning to the origin must retain their own position in the route.
        stops.push({ id: 'manual-' + ++sequence, customerCode: String(point.customerCode || ''), label: String(point.label || point.customerName || point.address || '선택 위치'), lat, lng });
        return copy();
      },
      remove(id) { stops = stops.filter(stop => stop.id !== id); return copy(); },
      move(id, offset) {
        const index = stops.findIndex(stop => stop.id === id), target = index + offset;
        if (index < 0 || ![-1, 1].includes(offset) || target < 0 || target >= stops.length) return copy();
        [stops[index], stops[target]] = [stops[target], stops[index]]; return copy();
      },
      clear() { stops = []; },
      validate() {
        if (stops.length < 2) throw new Error('출발지와 도착지를 추가해 주세요.');
        return { mode: 'MANUAL_WAYPOINTS', origin: { ...stops[0] },
          waypoints: stops.slice(1, -1).map((stop, i) => ({ ...stop, order: i + 1 })), destination: { ...stops.at(-1) } };
      }
    };
  }
  root.ManualWaypoints = { createDraft };
})(typeof window === 'object' ? window : globalThis);

