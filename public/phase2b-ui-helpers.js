(function (root) {
  "use strict";
  // Display only: callers must keep the original vehicle value for keys/requests.
  function normalizeVehicleLabel(value) {
    const label = String(value ?? "").replace(/\s+/g, "");
    if (!label || label === "-") return label;
    const number = label.replace(/(?:호(?:차)?)+$/, "");
    return /\d$/.test(number) ? number + "호" : label;
  }
  // Color identity is independent of list order, active filters and browser storage.
  // Do not strip letters or leading zeroes: 101, 0101, 용01 and 임시01 are different keys.
  function vehicleColorKey(value) {
    const key = String(value ?? "").trim().replace(/호(?:차)?$/, "");
    return /^(?:|[-?]|미확인|호차 미확인)$/.test(key) ? "" : key;
  }
  function compareVehicles(left, right) {
    const parse = value => {
      const key = vehicleColorKey(value).normalize('NFKC');
      const regular = key.match(/^(\d+(?:-\d+)*)$/);
      const charter = key.match(/^(?:용차|용)(\d+(?:-\d+)*)$/);
      return { key, rank: regular ? 0 : charter ? 1 : 2, parts: (regular || charter)?.[1].split('-').map(Number) || [] };
    };
    const a = parse(left), b = parse(right);
    if (a.rank !== b.rank) return a.rank - b.rank;
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
      if (a.parts[i] === undefined) return -1;
      if (b.parts[i] === undefined) return 1;
      if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
    }
    return a.key.localeCompare(b.key, 'ko', { numeric: true }) || a.key.localeCompare(b.key, 'ko');
  }
  function vehicleFacet(rows, vehicle, { dated = false } = {}) {
    const centers = { osan:'osan', yeongnam:'yeongnam', honam:'honam', '011':'osan', '012':'yeongnam', '013':'honam' };
    const valid = rows.filter(row => vehicleColorKey(dated ? row.vehicle : row.baseVehicle) === vehicleColorKey(vehicle) &&
      (dated || (row.baseVehicleState === 'VERIFIED_MASTER' && row.baseVehicleSource === 'FIXED_DISPATCH_PRIMARY' && /^[a-f0-9]{64}$/.test(row.baseVehicleVersion || ''))));
    const observed = new Set(valid.map(row => centers[dated ? (row.dispatchCenterCode || row.centerCode || row.vehicleGroup) : row.baseVehicleGroup] || ''));
    const versions = new Set(valid.map(row => row.baseVehicleVersion).filter(Boolean));
    const center = observed.size === 1 && versions.size <= 1 ? [...observed][0] : '';
    // Address regions and historic source labels are not dispatch-master territory evidence.
    const regions = new Set(valid.map(row => String(row.baseVehicleArea || '').trim()));
    const region = !dated && regions.size === 1 ? [...regions][0] : '';
    return { center, region, stale: valid.some(row => row.baseVehicleStale !== false),
      checkedAt: valid.map(row => String(row.baseVehicleCheckedAt || '').slice(0, 10)).filter(Boolean).sort()[0] || '',
      conflict: observed.size > 1 || versions.size > 1, verified: !!center };
  }
  function vehicleMatches(query, vehicle) {
    const key = vehicleColorKey(query).toLocaleLowerCase();
    return !key || vehicleColorKey(vehicle).toLocaleLowerCase().includes(key);
  }
  function vehicleColor(value) {
    const key = vehicleColorKey(value);
    if (!key) return "#64748b";
    let hash = 2166136261;
    for (const character of key) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
    // Golden-angle spacing keeps adjacent numeric vehicle numbers apart. Other
    // identifiers use all characters; no first-palette-color fallback is used.
    const seed = /^(?:0|[1-9]\d{0,8})$/.test(key) ? Number(key) : hash;
    const hue = ((seed * 137.50776405003785) % 360 + 360) % 360;
    const saturation = [0.78, 0.70, 0.86][seed % 3];
    const rgb = lightness => {
      const a = saturation * Math.min(lightness, 1 - lightness);
      return [0, 8, 4].map(n => {
        const k = (n + hue / 30) % 12;
        return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
      });
    };
    const luminance = channels => channels.map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    let lightness = [0.40, 0.34, 0.45][seed % 3], channels = rgb(lightness);
    while (1.05 / (luminance(channels) + .05) < 4.5 && lightness > .20) channels = rgb(lightness -= .01);
    return "#" + channels.map(v => v.toString(16).padStart(2, "0")).join("");
  }
  function addressVariants(input) {
    const original = String(input || "").replace(/\s+/g, " ").trim();
    const cleaned = original.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    const core = cleaned.match(/^.*?(?:[가-힣\d·.]+(?:대로|로|길)|[가-힣\d·.]+(?:동|리|읍|면|가))\s+(?:산\s*)?\d+(?:-\d+)?/);
    return [...new Set([original, cleaned, core?.[0]].filter(Boolean))];
  }
  function addressMatches(query, candidate) {
    const compact = (value) => String(value || "").replace(/\s/g, "");
    const street = query.match(/([가-힣\d·.]+(?:대로|로|길))\s+(\d+(?:-\d+)?)/);
    const lot = query.match(/([가-힣\d·.]+(?:동|리|가))\s+(?:산\s*)?(\d+(?:-\d+)?)/);
    const match = street || lot;
    if (!match) return false;
    const target = compact(candidate);
    const numberPattern = new RegExp(`${match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${match[2]}(?![\\d-])`);
    if (!numberPattern.test(target)) return false;
    const districts = query.split(/\s+/).filter((part) => /[시군구]$/.test(part));
    return districts.every((part) => target.includes(part));
  }
  function distanceKm(a, b) {
    if ([a.lat, a.lng, b.lat, b.lng].some((v) => v == null || v === "" || !Number.isFinite(Number(v)))) return Infinity;
    const rad = Math.PI / 180;
    const deltaLat = (b.lat - a.lat) * rad, deltaLng = (b.lng - a.lng) * rad;
    const n = Math.sin(deltaLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(deltaLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(n), Math.sqrt(1 - n));
  }
  function nearbyVehicles(point, stores, radius = 30) {
    const nearest = new Map();
    for (const store of stores) {
      const distance = distanceKm(point, store);
      if (!store.vehicle || distance > radius) continue;
      const old = nearest.get(store.vehicle);
      if (!old || distance < old.distance) nearest.set(store.vehicle, { ...store, distance });
    }
    return [...nearest.values()].sort((a, b) => a.distance - b.distance);
  }
  function deliveryBoundary(stores) {
    const unique = new Map(stores.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng)).map((row) => [`${row.lat}:${row.lng}`, { lat: row.lat, lng: row.lng }]));
    const points = [...unique.values()].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
    if (points.length < 3) return [];
    const cross = (a, b, c) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
    const half = (rows) => { const result = []; for (const row of rows) { while (result.length >= 2 && cross(result.at(-2), result.at(-1), row) <= 0) result.pop(); result.push(row); } return result.slice(0, -1); };
    const hull = [...half(points), ...half(points.slice().reverse())];
    return hull.length >= 3 ? hull : [];
  }
  function storeDetailMatches(detail, customerCode, requestedDate) {
    if (!detail || detail.customerCode !== customerCode) return false;
    if (detail.sourceBasis === 'CURRENT_CUSTOMER_LOOKUP') return detail.detailDate === null;
    if (detail.sourceBasis === 'STORED_DAY' && detail.sourceDate !== requestedDate) return false;
    return detail.detailDate === requestedDate;
  }
  function requestError(error, { stale = false, aborted = false, reason } = {}) {
    if (stale || (aborted && reason !== "timeout") || (error?.name === "AbortError" && reason !== "timeout")) {
      return Object.assign(new Error("REQUEST_CANCELLED"), { silent: true, code: "REQUEST_CANCELLED" });
    }
    if (reason === "timeout" || /This operation was aborted|AbortError/i.test(error?.message || "")) {
      return Object.assign(new Error("요청 시간이 초과되었습니다. 잠시 후 다시 시도해주세요."), { code: "REQUEST_TIMEOUT" });
    }
    return error;
  }
  root.Phase2bUi = Object.freeze({ storeDetailMatches, normalizeVehicleLabel, vehicleColorKey, compareVehicles, vehicleFacet, vehicleMatches, vehicleColor, addressVariants, addressMatches, distanceKm, nearbyVehicles, deliveryBoundary, requestError });
})(typeof window === "undefined" ? globalThis : window);

