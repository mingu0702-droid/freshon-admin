import fs from "node:fs/promises";

const base = String(process.env.PHASE2B_PREVIEW_URL || "").replace(/\/$/, "");
if (!base) throw new Error("PHASE2B_PREVIEW_URL is required");
const output = new URL("../public/map-phase2b-snapshot.json", import.meta.url);

async function tileRows(tile, depth = 0) {
  const query = new URLSearchParams({ mode: "BASE_90D", south: tile.south, west: tile.west, north: tile.north, east: tile.east, limit: "2000" });
  const response = await fetch(`${base}/api/map-phase2b/preview/bounds?${query}`, { signal: AbortSignal.timeout(70000) });
  if (!response.ok) throw new Error(`bounds ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload.data) ? payload.data : [];
  if (rows.length < 2000 || depth >= 5 || Math.max(tile.north - tile.south, tile.east - tile.west) <= 0.25) return rows;
  const latSpan = tile.north - tile.south, lngSpan = tile.east - tile.west;
  const parts = latSpan >= lngSpan
    ? [{ ...tile, north: (tile.south + tile.north) / 2 }, { ...tile, south: (tile.south + tile.north) / 2 }]
    : [{ ...tile, east: (tile.west + tile.east) / 2 }, { ...tile, west: (tile.west + tile.east) / 2 }];
  return [...await tileRows(parts[0], depth + 1), ...await tileRows(parts[1], depth + 1)];
}

const roots = [
  { south: 33, west: 124, north: 36, east: 128 }, { south: 33, west: 128, north: 36, east: 132 },
  { south: 36, west: 124, north: 39, east: 128 }, { south: 36, west: 128, north: 39, east: 132 }
];
const rows = [];
for (const tile of roots) rows.push(...await tileRows(tile));
const baseLatest = rows.map((row) => String(row.lastDeliveryDate || row.deliveryDate || "").slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().pop();
const cursor = new Date(`${baseLatest}T00:00:00+09:00`), today = new Date();
const missingDates = [];
while (cursor < today && missingDates.length < 30) { cursor.setDate(cursor.getDate() + 1); missingDates.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(cursor)); }
for (const date of missingDates) {
  for (let index = 0; index < roots.length; index += 2) {
    const batch = await Promise.all(roots.slice(index, index + 2).map(async (tile) => {
      const query = new URLSearchParams({ mode: "DATE_ROUTE", date, south: tile.south, west: tile.west, north: tile.north, east: tile.east, limit: "2000" });
      const response = await fetch(`${base}/api/map-phase2b/preview/bounds?${query}`, { signal: AbortSignal.timeout(70000) });
      if (!response.ok) throw new Error(`date bounds ${date} ${response.status}`);
      const payload = await response.json();
      return Array.isArray(payload.data) ? payload.data : [];
    }));
    batch.forEach((items) => rows.push(...items));
  }
}
const todayText = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const todayResponse = await fetch(`${base}/api/map-phase2b/preview/today-status?date=${todayText}`, { signal: AbortSignal.timeout(70000) });
if (todayResponse.ok) {
  const todayPayload = await todayResponse.json();
  const knownByCode = new Map(rows.map((row) => [String(row.customerCode || row.code || "").trim(), row]));
  for (const vehicle of todayPayload.data?.vehicles || []) for (const stop of vehicle.stops || []) {
    const code = String(stop.customerCode || stop.code || "").trim(), known = knownByCode.get(code) || {};
    const lat = Number.isFinite(Number(stop.lat)) ? Number(stop.lat) : Number(known.lat), lng = Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : Number(known.lng);
    if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    rows.push({ ...known, ...stop, customerCode: code, vehicle: vehicle.vehicle, lat, lng, lastDeliveryDate: todayText });
  }
}
const unique = new Map();
for (const row of rows) {
  const code = String(row.customerCode || "").trim();
  if (!code) continue;
  const previous = unique.get(code);
  if (!previous || String(row.lastDeliveryDate || "") >= String(previous.lastDeliveryDate || "")) unique.set(code, row);
}
const all = [...unique.values()];
const latestDate = all.map((row) => String(row.lastDeliveryDate || row.deliveryDate || "").slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().pop();
if (!latestDate) throw new Error("snapshot latest date missing");
const start = new Date(`${latestDate}T00:00:00+09:00`); start.setDate(start.getDate() - 59);
const startDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
const filtered = all.filter((row) => !row.lastDeliveryDate || String(row.lastDeliveryDate).slice(0, 10) >= startDate);
const payload = { version: "phase2b-map-snapshot-v1", generatedAt: new Date().toISOString(), latestDate, startDate, rowCount: filtered.length, rows: filtered };
await fs.writeFile(output, JSON.stringify(payload));
console.log(JSON.stringify({ latestDate, startDate, rowCount: filtered.length }));
