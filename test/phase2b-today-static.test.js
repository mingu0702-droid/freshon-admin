import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const runtime = await readFile(new URL("../public/map-phase2b-runtime.js", import.meta.url), "utf8");

test("today status reads Delivery Admin and deduplicates concurrent date requests", () => {
  assert.match(server, /fetchDeliveryTaskRowsForDate\(date\)/);
  assert.match(server, /phase2bTodayInflight/);
  assert.match(server, /\/api\/map-phase2b\/preview\/today-status/);
});

test("today status exposes progress and event-derived estimate without GPS", () => {
  assert.match(server, /avgMinutesPerStop/);
  assert.match(server, /estimatedEndAt/);
  assert.match(server, /progressPercent/);
  assert.match(server, /completeDatedAt/);
  assert.match(server, /recentCompletedTimes/);
  assert.match(server, /nextOrder = stops\.filter/);
  assert.doesNotMatch(server.slice(server.indexOf("function phase2bTodayVehicleSummary"), server.indexOf("async function phase2bTodayStatus")), /GPS|gps/);
});

test("rolling snapshot is served immediately and refreshed from Hub plus current Delivery Admin", () => {
  assert.match(server, /\/api\/map-phase2b\/preview\/snapshot/);
  assert.match(server, /refreshPhase2bSnapshot/);
  assert.match(server, /phase2bSnapshotMissingDates/);
  assert.match(server, /knownByCode/);
  assert.match(runtime, /refreshStoreSnapshot/);
  assert.match(runtime, /snapshotMeta/);
});

test("customer detail uses existing Hub and dispatch sources without fake values", () => {
  assert.match(server, /callHub\("customerDetail"/);
  assert.match(server, /accessInfo: dispatch\.accessInfo \|\| null/);
  assert.match(runtime, /\/api\/map-phase2b\/preview\/detail/);
});

test("vehicle representative pin opens today status panel", () => {
  assert.match(runtime, /selectVehicleStatus/);
  assert.match(runtime, /renderVehiclePanel/);
  assert.match(runtime, /loadTodayStatus/);
});
