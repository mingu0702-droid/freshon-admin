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

test("concurrent identical Route requests share one Hub call and reuse cache", async () => {
  const client = await freshClient();
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return ok(JSON.parse(options.body).action);
  };
  const params = { date: "2026-08-11", vehicle: "101" };
  const [first, second] = await Promise.all([client.callHub("routePlan", params), client.callHub("routePlan", params)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
  assert.equal((await client.callHub("routePlan", params)).ok, true);
  assert.equal(calls, 1);
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

test("customer detail uses one long-running request instead of duplicate retries", async () => {
  const client = await freshClient();
  let calls = 0;
  global.fetch = async (_url, options) => { calls += 1; return ok(JSON.parse(options.body).action); };
  assert.equal((await client.callHub("customerDetail", { customerCode: "S222538" }, { useCache: false })).ok, true);
  assert.equal(calls, 1);
});

test("malformed Hub JSON is classified without exposing response content", async () => {
  const client = await freshClient();
  global.fetch = async () => ({ status: 200, json: async () => { throw new SyntaxError("bad json"); } });
  await assert.rejects(client.callHub("customerDetail", { customerCode: "S222538" }, { useCache: false }), /HUB_INVALID_JSON/);
});

test("customer detail timeout aborts once without duplicate upstream work", async () => {
  const client = await freshClient();
  process.env.HUB_DETAIL_TIMEOUT_MS = "10";
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  };
  await assert.rejects(client.callHub("customerDetail", { customerCode: "S222538" }, { useCache: false }), /aborted/);
  assert.equal(calls, 1);
});

test("map bounds timeout is deterministic and is not retried", async () => {
  const client = await freshClient(); let calls = 0;
  global.fetch = async () => { calls += 1; throw Object.assign(new Error("timeout"), { name: "AbortError" }); };
  await assert.rejects(client.callHub("mapBounds", { bounds: {} }, { useCache: false }));
  assert.equal(calls, 1);
});

test("Hub 4xx contract error is not retried", async () => {
  const client = await freshClient(); let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 400, text: async () => JSON.stringify({ ok: false, data: null, meta: { httpStatus: 400 }, error: { code: "INVALID_PARAMS" } }) }; };
  await assert.rejects(client.callHub("mapBounds", { bounds: {} }, { useCache: false }), /HUB_INVALID_PARAMS/);
  assert.equal(calls, 1);
});

test("transient Hub 503 is retried once with bounded backoff", async () => {
  const client = await freshClient(); let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, text: async () => JSON.stringify({ ok: false, data: null, meta: { httpStatus: 503 }, error: { code: "TEMPORARY" } }) };
    return ok(JSON.parse(options.body).action);
  };
  assert.equal((await client.callHub("mapBounds", { bounds: {} }, { useCache: false })).ok, true);
  assert.equal(calls, 2);
});

test("cache miss with persistent Hub 503 fails after one retry", async () => {
  const client = await freshClient(); let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 503, text: async () => JSON.stringify({ ok: false, data: null, meta: { httpStatus: 503 }, error: { code: "TEMPORARY" } }) };
  };
  await assert.rejects(client.callHub("mapBounds", { bounds: {} }, { useCache: false }), /HUB_TEMPORARY/);
  assert.equal(calls, 2);
});

test("cache miss with network failure retries once and remains uncached", async () => {
  const client = await freshClient(); let calls = 0;
  global.fetch = async () => { calls += 1; throw new TypeError("fetch failed"); };
  await assert.rejects(client.callHub("mapBounds", { bounds: {} }), /fetch failed/);
  await assert.rejects(client.callHub("mapBounds", { bounds: {} }), /fetch failed/);
  assert.equal(calls, 4);
});
