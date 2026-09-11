import test from "node:test";
import assert from "node:assert/strict";
import { readDatedAssignments, uniqueAssignments } from "../src/phase2bAssignments.js";
const date = "2026-08-11";
const bounds = { south: 33, north: 38, west: 124, east: 129 };

test("capped tiles subdivide and deduplicate shared edges without truncation", async () => {
  let calls = 0;
  const rows = await readDatedAssignments(date, bounds, async (params) => {
    assert.equal(params.date, date); assert.equal(params.mode, "DATE_ROUTE");
    calls++;
    if (calls === 1) return { data: Array(2000).fill({ customerCode: "CAP", vehicle: "101" }) };
    return { data: [{ customerCode: "EDGE", vehicle: "101", deliveryDate: date }, { customerCode: `SIDE${calls}`, vehicle: "109" }] };
  });
  assert.equal(calls, 3); assert.equal(rows.length, 3);
});

test("partial, wrong-date, and perpetually capped sources fail closed", async () => {
  await assert.rejects(readDatedAssignments(date, bounds, async () => ({ ok: false, data: [] })), /UNAVAILABLE/);
  await assert.rejects(readDatedAssignments(date, bounds, async () => ({ data: [], meta: { sourceCount: 2000 } })), /SOURCE_TRUNCATED/);
  assert.throws(() => uniqueAssignments([{ customerCode: "A", vehicle: "101", deliveryDate: "2026-09-05" }], date), /MISMATCH/);
  await assert.rejects(readDatedAssignments(date, bounds, async () => ({ data: Array(2000).fill({}) }), 8), /TRUNCATED/);
});

test("rolling relation is never promoted to dated assignment", () => {
  assert.deepEqual(uniqueAssignments([{ customerCode: "A", primaryVehicle90d: "101" }], date), []);
});
