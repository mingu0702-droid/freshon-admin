(function (root) {
  "use strict";
  // Display only: callers must keep the original vehicle value for keys/requests.
  function normalizeVehicleLabel(value) {
    const label = String(value ?? "").replace(/\s+/g, "");
    if (!label || label === "-") return label;
    const number = label.replace(/(?:호(?:차)?)+$/, "");
    return /\d$/.test(number) ? number + "호" : label;
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
  function requestError(error, { stale = false, aborted = false, reason } = {}) {
    if (stale || (aborted && reason !== "timeout") || (error?.name === "AbortError" && reason !== "timeout")) {
      return Object.assign(new Error("REQUEST_CANCELLED"), { silent: true, code: "REQUEST_CANCELLED" });
    }
    if (reason === "timeout" || /This operation was aborted|AbortError/i.test(error?.message || "")) {
      return Object.assign(new Error("요청 시간이 초과되었습니다. 잠시 후 다시 시도해주세요."), { code: "REQUEST_TIMEOUT" });
    }
    return error;
  }
  root.Phase2bUi = Object.freeze({ normalizeVehicleLabel, addressVariants, addressMatches, distanceKm, nearbyVehicles, requestError });
})(typeof window === "undefined" ? globalThis : window);
