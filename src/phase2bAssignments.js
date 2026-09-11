// A dated assignment must never fall back to a rolling vehicle relationship.
export async function readDatedAssignments(date, bounds, loadTile, depth = 0) {
  const payload = await loadTile({ mode: "DATE_ROUTE", date, vehicle: "", bounds, limit: 2000 });
  if (payload?.ok === false || !Array.isArray(payload?.data)) throw new Error("DATED_ASSIGNMENTS_UNAVAILABLE");
  // Hub applies its source limit before the geographic filter. Splitting a tile
  // cannot recover that missing source page, so never report it as complete.
  if (Number(payload.meta?.sourceCount) >= 2000) throw new Error("DATED_ASSIGNMENTS_SOURCE_TRUNCATED");
  if (payload.data.length >= 2000) {
    if (depth >= 8) throw new Error("DATED_ASSIGNMENTS_TRUNCATED");
    const axis = bounds.north - bounds.south >= bounds.east - bounds.west ? "lat" : "lng";
    const mid = axis === "lat" ? (bounds.north + bounds.south) / 2 : (bounds.east + bounds.west) / 2;
    const halves = axis === "lat" ? [{ ...bounds, north: mid }, { ...bounds, south: mid }] : [{ ...bounds, east: mid }, { ...bounds, west: mid }];
    // Sequential subdivisions bound Hub concurrency and avoid dropping capped tiles.
    const rows = [];
    for (const half of halves) rows.push(...await readDatedAssignments(date, half, loadTile, depth + 1));
    return uniqueAssignments(rows, date);
  }
  return uniqueAssignments(payload.data, date);
}

export function uniqueAssignments(rows, date) {
  const unique = new Map();
  for (const row of rows) {
    const actual = String(row.deliveryDate || row.lastDeliveryDate || "").slice(0, 10);
    if (actual && actual !== date) throw new Error("DATED_ASSIGNMENTS_DATE_MISMATCH");
    const code = String(row.customerCode || row.code || "").trim();
    const vehicle = String(row.vehicle || row.confirmedVehicle || "").replace(/호(?:차)?$/, "");
    if (code && vehicle) unique.set(`${vehicle}|${code}`, { ...row, customerCode: code, vehicle, deliveryDate: date, lastDeliveryDate: date });
  }
  return [...unique.values()];
}
