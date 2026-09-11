import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { phase2bSnapshotFailure, phase2bSnapshotProgress, phase2bSnapshotWatchdogNeeded } from "../src/phase2bSnapshotRecovery.js";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

test("snapshot progress follows checkpoint dates and completes at target", () => {
  assert.equal(phase2bSnapshotProgress("2026-09-01", "2026-09-05", "2026-09-09"), 50);
  assert.equal(phase2bSnapshotProgress("2026-09-01", "2026-09-09", "2026-09-09"), 100);
});

test("three identical snapshot errors stop automatic continuation", () => {
  const first = phase2bSnapshotFailure({}, "AUTH", 1);
  const second = phase2bSnapshotFailure(first, "AUTH", 2);
  const third = phase2bSnapshotFailure(second, "AUTH", 3);
  assert.equal(first.phase, "WAITING");
  assert.equal(second.phase, "WAITING");
  assert.equal(third.phase, "ERROR");
  assert.equal(third.consecutiveErrors, 3);
});

test("watchdog restores only stalled work without a runner or continuation", () => {
  const state = { phase: "WAITING", updatedAt: "2026-09-01T00:00:00.000Z" };
  assert.equal(phase2bSnapshotWatchdogNeeded(state, { now: Date.parse("2026-09-01T00:08:00.000Z"), stallMs: 420000 }), true);
  assert.equal(phase2bSnapshotWatchdogNeeded(state, { now: Date.parse("2026-09-01T00:08:00.000Z"), stallMs: 420000, hasContinuation: true }), false);
  assert.equal(phase2bSnapshotWatchdogNeeded(state, { now: Date.parse("2026-09-01T00:08:00.000Z"), stallMs: 420000, running: true }), false);
});

test("stage status exposes auth, snapshot progress and continuation state", () => {
  assert.match(server, /hubAuth: snapshot\.hubAuth/);
  assert.match(server, /phase2bSnapshotAutomationStatus/);
  assert.match(server, /continuation:/);
  assert.match(server, /startPhase2bSnapshotWatchdog/);
  assert.match(server, /schedulePhase2bSnapshotAuthProbe/);
  assert.match(server, /MAP_PHASE2B_SNAPSHOT_RUN_BUDGET_MS/);
});
