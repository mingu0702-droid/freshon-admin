import test from "node:test";
import assert from "node:assert/strict";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
let importId = 0;

function ok(action) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data: action === "routePlan" ? { stops: [] } : [], meta: { requestId: "test", durationMs: 1 } }) };
}

async function freshClient() {
  process.env.HUB_API_URL = "https://hub.test/exec";
  process.env.HUB_API_SECRET = "x".repeat(32);
  process.env.HUB_CIRCUIT_FAILURE_THRESHOLD = "2";
  process.env.HUB_CIRCUIT_RESET_MS = "1000";
  return import(`../src/hubApiClient.js?test=${Date.now()}-${importId++}`);
}

test.afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test("Search OPEN does not block Route", async () => {
  const client = await freshClient();
  global.fetch = async (_url, options) => {
    const action = JSON.parse(options.body).action;
    if (action === "unifiedSearch") throw Object.assign(new Error("timeout"), { name: "AbortError" });
    return ok(action);
  };
  await assert.rejects(client.callHub("unifiedSearch", { q: "a" }, { useCache: false }));
  await assert.rejects(client.callHub("unifiedSearch", { q: "b" }, { useCache: false }));
  await assert.rejects(client.callHub("unifiedSearch", { q: "c" }, { useCache: false }), /HUB_CIRCUIT_OPEN/);
  const route = await client.callHub("routePlan", { date: "2026-08-11", vehicle: "101" }, { useCache: false });
  assert.equal(route.ok, true);
  assert.equal(client.hubMetrics().circuits.unifiedSearch.state, "OPEN");
  assert.equal(client.hubMetrics().circuits.routePlan.state, "CLOSED");
});

test("Route timeout opens only Route", async () => {
  const client = await freshClient();
  global.fetch = async (_url, options) => {
    const action = JSON.parse(options.body).action;
    if (action === "routePlan") throw Object.assign(new Error("timeout"), { name: "AbortError" });
    return ok(action);
  };
  await assert.rejects(client.callHub("routePlan", { n: 1 }, { useCache: false }));
  await assert.rejects(client.callHub("routePlan", { n: 2 }, { useCache: false }));
  assert.equal(client.hubMetrics().circuits.routePlan.state, "OPEN");
  assert.equal((await client.callHub("mapBounds", { n: 1 }, { useCache: false })).ok, true);
});

test("HALF_OPEN allows one probe and closes on success", async () => {
  const client = await freshClient();
  process.env.HUB_CIRCUIT_FAILURE_THRESHOLD = "1";
  global.fetch = async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); };
  await assert.rejects(client.callHub("unifiedSearch", { q: "open" }, { useCache: false }));
  await new Promise((resolve) => setTimeout(resolve, 1050));
  let release;
  global.fetch = async (_url, options) => new Promise((resolve) => { release = () => resolve(ok(JSON.parse(options.body).action)); });
  const probe = client.callHub("unifiedSearch", { q: "probe" }, { useCache: false });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(client.callHub("unifiedSearch", { q: "second" }, { useCache: false }), /HUB_CIRCUIT_HALF_OPEN/);
  release();
  assert.equal((await probe).ok, true);
  assert.equal(client.hubMetrics().circuits.unifiedSearch.state, "CLOSED");
  assert.equal(client.hubMetrics().circuits.unifiedSearch.failures, 0);
});

test("failed HALF_OPEN probe reopens its circuit", async () => {
  const client = await freshClient();
  process.env.HUB_CIRCUIT_FAILURE_THRESHOLD = "1";
  global.fetch = async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); };
  await assert.rejects(client.callHub("mapBounds", { n: 1 }, { useCache: false }));
  await new Promise((resolve) => setTimeout(resolve, 1050));
  await assert.rejects(client.callHub("mapBounds", { n: 2 }, { useCache: false }));
  assert.equal(client.hubMetrics().circuits.mapBounds.state, "OPEN");
  await assert.rejects(client.callHub("mapBounds", { n: 3 }, { useCache: false }), /HUB_CIRCUIT_OPEN/);
});
