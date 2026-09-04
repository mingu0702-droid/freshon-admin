function round1(value) {
  return Math.round(value * 10) / 10;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function calculateVehicleEta(completedEvents, remainingStops, now = Date.now()) {
  const times = completedEvents.map((event) => Number(event.time)).filter(Number.isFinite).sort((a, b) => a - b);
  const allIntervals = times.slice(1).map((time, index) => (time - times[index]) / 60000).filter((minutes) => minutes >= 2 && minutes <= 240);
  const recentIntervals = allIntervals.slice(-4);
  const overallMedian = median(allIntervals);
  const recentAverage = recentIntervals.length ? recentIntervals.reduce((sum, value) => sum + value, 0) / recentIntervals.length : null;
  const enoughData = times.length >= 3 && allIntervals.length >= 2;
  if (!enoughData || !remainingStops) {
    return {
      avgMinutesPerStop: null,
      recentAvgMinutesPerStop: recentAverage == null ? null : round1(recentAverage),
      overallAvgMinutesPerStop: overallMedian == null ? null : round1(overallMedian),
      remainingMinutes: remainingStops === 0 ? 0 : null,
      estimatedEndAt: null,
      estimateConfidence: remainingStops === 0 ? "완료" : "산출 중"
    };
  }
  const weighted = recentAverage * 0.65 + overallMedian * 0.35;
  const minutesPerStop = Math.min(overallMedian * 1.8, Math.max(overallMedian * 0.5, weighted));
  const remainingMinutes = Math.round(minutesPerStop * remainingStops);
  const baseTime = Math.max(now, times[times.length - 1]);
  return {
    avgMinutesPerStop: round1(minutesPerStop),
    recentAvgMinutesPerStop: round1(recentAverage),
    overallAvgMinutesPerStop: round1(overallMedian),
    remainingMinutes,
    estimatedEndAt: new Date(baseTime + remainingMinutes * 60000).toISOString(),
    estimateConfidence: allIntervals.length >= 4 ? "보통" : "낮음"
  };
}

function isPhoneLike(value) {
  const text = String(value || "").trim();
  const digits = text.replace(/\D/g, "");
  return /^(?:01[016789]|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}$/.test(text) || (digits.length >= 9 && digits.length <= 11 && /^0/.test(digits));
}

function stripPhone(value) {
  return String(value || "").replace(/(?:01[016789]|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}/g, "").replace(/\s{2,}/g, " ").trim();
}

export function parseAccessMemo(value) {
  const raw = String(value || "").replace(/\r/g, "").trim();
  if (!raw) return { accessInfo: "", password: "", specialRemark: "" };
  const passwordPattern = /(?:(?:출입문\s*)?도어락(?:\s*비밀번호)?|출입비밀번호|비밀번호|출입비번|비번|번호키|보안키|공동현관)\s*(?:[:：=\-]\s*)?([A-Za-z0-9#*\/_-]{2,})/iu;
  const passwordMatch = raw.replace(/\/[ \t]+(?=[가-힣*(])/gu, "\n").match(passwordPattern);
  let password = passwordMatch && !isPhoneLike(passwordMatch[1]) ? passwordMatch[1] : "";
  const access = [];
  const notes = [];
  raw.split(/\n|[;；]+|[ \t]+\/[ \t]+|\/[ \t]+(?=[가-힣*(])/u).map((line) => stripPhone(line).replace(/^[*•\-\s]+/u, "").trim()).filter(Boolean).forEach((line) => {
    if (isPhoneLike(line) || /^(?:점주|대표|고객)\s*(?:전화|연락처|번호)/u.test(line)) return;
    const cleaned = line.replace(passwordPattern, "").replace(/^[\s,:：=\-]+|[\s,:：=\-]+$/g, "").trim();
    if (/^(?:가게)?출입방법|^출입정보/u.test(line)) {
      const entry = line.replace(/^(?:(?:가게)?출입방법|출입정보)\s*[:：]?\s*/u, "").replace(passwordPattern, "").trim();
      const credential = entry.match(/^['"]?([A-Za-z0-9#*\/_-]{2,})(?=['"\s(]|$)/u)?.[1] || "";
      if (credential && !isPhoneLike(credential)) {
        if (!password) password = credential;
        const remainder = entry.slice(entry.indexOf(credential) + credential.length).replace(/^['"\s]+/, "").trim();
        if (remainder) access.push(remainder);
      } else if (entry && !isPhoneLike(entry)) access.push(entry);
    } else if (/^(?:특이사항|메모|비고)\s*[:：]?/u.test(line)) {
      const note = line.replace(/^(?:특이사항|메모|비고)\s*[:：]?\s*/u, "").trim();
      if (note && !isPhoneLike(note)) notes.push(note);
    } else if (/(?:공동현관|도어락|번호키|보안키|경비실|후문|정문)/u.test(line)) {
      if (cleaned && !isPhoneLike(cleaned)) access.push(cleaned);
    } else if (cleaned && cleaned !== password && !isPhoneLike(cleaned)) {
      notes.push(cleaned);
    }
  });
  if (!access.length && !notes.length && !password && !isPhoneLike(raw)) notes.push(raw);
  return {
    accessInfo: [...new Set(access)].join(" · "),
    password,
    specialRemark: [...new Set(notes)].join(" · ")
  };
}

export function splitHubBounds(bounds, maxLatSpan = 5, maxLngSpan = 5) {
  const south = Number(bounds?.south), west = Number(bounds?.west), north = Number(bounds?.north), east = Number(bounds?.east);
  if (![south, west, north, east].every(Number.isFinite) || north <= south || east <= west) throw new Error("INVALID_BOUNDS");
  const latParts = Math.max(1, Math.ceil((north - south) / maxLatSpan));
  const lngParts = Math.max(1, Math.ceil((east - west) / maxLngSpan));
  const tiles = [];
  for (let y = 0; y < latParts; y += 1) {
    for (let x = 0; x < lngParts; x += 1) {
      tiles.push({
        south: south + (north - south) * y / latParts,
        west: west + (east - west) * x / lngParts,
        north: south + (north - south) * (y + 1) / latParts,
        east: west + (east - west) * (x + 1) / lngParts
      });
    }
  }
  return tiles;
}

export function mergeHubBoundsPayloads(payloads, limit = 2000) {
  const unique = new Map();
  for (const payload of payloads) {
    for (const row of Array.isArray(payload?.data) ? payload.data : []) {
      const key = [row.customerCode || row.code || "", row.vehicle || row.confirmedVehicle || "", row.lat ?? row.latitude ?? "", row.lng ?? row.longitude ?? ""].join("|");
      if (!unique.has(key)) unique.set(key, row);
    }
  }
  const data = [...unique.values()].slice(0, limit);
  return { ok: true, data, meta: { source: "hub-tiled", tileCount: payloads.length, rowCount: data.length, returnedCount: data.length }, error: null };
}

export function normalizePhase2bDetail(data, dispatch = {}) {
  const parsedMemo = parseAccessMemo([
    data?.accessMemo,
    dispatch.accessInfo,
    dispatch.password ? `비밀번호: ${dispatch.password}` : "",
    dispatch.specialRemark
  ].filter(Boolean).join("\n"));
  return {
    customerCode: String(data?.customerCode || dispatch.customerCode || "").trim().toUpperCase(),
    customerName: data?.customerName || dispatch.name || null,
    address: data?.customerAddress || data?.address || dispatch.address || null,
    detailAddress: data?.detailAddress || data?.addressDetail || null,
    vehicle: data?.confirmedVehicle || data?.vehicle || dispatch.vehicle || null,
    lat: Number.isFinite(Number(data?.lat ?? data?.latitude)) ? Number(data.lat ?? data.latitude) : null,
    lng: Number.isFinite(Number(data?.lng ?? data?.longitude)) ? Number(data.lng ?? data.longitude) : null,
    accessInfo: parsedMemo.accessInfo || null,
    password: parsedMemo.password || null,
    specialRemark: parsedMemo.specialRemark || null,
    driverName: data?.driverName || null,
    driverPhone: data?.driverPhone || null,
    area: data?.area || null,
    areaLabel: data?.areaLabel || null,
    region: data?.region || null,
    center: data?.center || dispatch.center || null,
    lastDeliveryDate: dispatch.deliveryDate || data?.lastDeliveryDate || data?.deliveryDate || null,
    deliveryPattern: data?.deliveryPattern || null,
    deliveryPatternText: data?.deliveryPatternText || null,
    deliveryCount90d: data?.deliveryCount90d ?? null,
    deliveryCount: data?.deliveryCount ?? null
  };
}
