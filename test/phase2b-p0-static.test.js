import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/map-phase2b-preview.html", import.meta.url), "utf8");
const runtime = await readFile(new URL("../public/map-phase2b-runtime.js", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

test("PC and mobile map controls exist", () => {
  for (const id of ["areaToggle", "mapReset", "mobileCenter", "mobileBaseVehicle", "mobileAreaToggle", "mobileMapReset"]) assert.match(html, new RegExp(`id=["']${id}["']`));
});

test("map interaction guard and explicit fit triggers exist", () => {
  assert.match(runtime, /userMovedMap/);
  assert.match(runtime, /requestMapFit/);
  assert.match(runtime, /dragstart/);
  assert.match(runtime, /zoom_start/);
  assert.match(runtime, /resetMapOverview/);
});

test("silent delivery and nearest fallbacks are removed", () => {
  assert.doesNotMatch(runtime, /function vehicleCenters/);
  assert.doesNotMatch(runtime, /function nearestVehiclesLocal/);
  assert.doesNotMatch(runtime, /candidates\.push\(\.\.\.allStores\)/);
});

test("search supports partial customer code and customerCode dedupe", () => {
  assert.match(runtime, /code\.includes\(target\)/);
  assert.match(runtime, /const key = row\.customerCode \|\|/);
});

test("center bounds use center contract without comma-separated vehicles", () => {
  assert.match(runtime, /center:\s*state\.centerFilter/);
  assert.match(runtime, /vehicle:\s*selected\.length === 1 \? selected\[0\] : ""/);
  assert.match(server, /center:\s*String\(req\.query\.center \|\| ""\)/);
});
