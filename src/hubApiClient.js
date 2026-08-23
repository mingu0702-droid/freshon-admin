import crypto from "node:crypto";

const VERSION = "map-phase2-v1";
const cache = new Map();
const state = { circuits: new Map(), metrics: { requests: 0, success: 0, timeout: 0, error: 0, match: 0, mismatch: 0, latencyMs: [] } };

function circuitFor(action) {
  const key = String(action || "unknown");
  if (!state.circuits.has(key)) state.circuits.set(key, { state: "CLOSED", failures: 0, openUntil: 0, probeInFlight: false, lastFailure: null });
  return state.circuits.get(key);
}

function circuitConfig() {
  return {
    threshold: Math.max(1, Number(process.env.HUB_CIRCUIT_FAILURE_THRESHOLD || 10)),
    resetMs: Math.max(1000, Number(process.env.HUB_CIRCUIT_RESET_MS || 300000))
  };
}

function circuitLog(action, circuit, timeout, event) {
  console.info(JSON.stringify({ component: "hub-circuit", action, state: circuit.state, failures: circuit.failures, timeout: Boolean(timeout), event }));
}

function circuitEnter(action) {
  const circuit = circuitFor(action);
  const now = Date.now();
  if (circuit.state === "OPEN" && now < circuit.openUntil) { circuitLog(action, circuit, false, "REJECT_OPEN"); throw new Error("HUB_CIRCUIT_OPEN"); }
  if (circuit.state === "OPEN") {
    if (circuit.probeInFlight) { circuitLog(action, circuit, false, "REJECT_PROBE_IN_FLIGHT"); throw new Error("HUB_CIRCUIT_HALF_OPEN"); }
    circuit.state = "HALF_OPEN";
    circuit.probeInFlight = true;
    circuitLog(action, circuit, false, "HALF_OPEN_PROBE");
    return { circuit, probe: true };
  }
  if (circuit.state === "HALF_OPEN") { circuitLog(action, circuit, false, "REJECT_HALF_OPEN"); throw new Error("HUB_CIRCUIT_HALF_OPEN"); }
  return { circuit, probe: false };
}

function circuitSuccess(action, circuit) {
  const recovered = circuit.state !== "CLOSED" || circuit.failures > 0;
  circuit.state = "CLOSED";
  circuit.failures = 0;
  circuit.openUntil = 0;
  circuit.probeInFlight = false;
  circuit.lastFailure = null;
  if (recovered) circuitLog(action, circuit, false, "CLOSED");
}

function circuitFailure(action, circuit, timeout, probe) {
  const config = circuitConfig();
  circuit.lastFailure = { at: new Date().toISOString(), timeout: Boolean(timeout) };
  circuit.probeInFlight = false;
  if (probe) {
    circuit.state = "OPEN";
    circuit.openUntil = Date.now() + config.resetMs;
  } else {
    circuit.failures += 1;
    if (circuit.failures >= config.threshold) {
      circuit.state = "OPEN";
      circuit.openUntil = Date.now() + config.resetMs;
    }
  }
  circuitLog(action, circuit, timeout, circuit.state === "OPEN" ? "OPEN" : "FAILURE");
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function requestBody(action, params) {
  const secret = String(process.env.HUB_API_SECRET || "");
  if (secret.length < 32) throw new Error("HUB_API_SECRET_NOT_CONFIGURED");
  const requestId = crypto.randomUUID();
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString("base64url");
  const canonical = [VERSION, action, requestId, timestamp, nonce, stable(params || {})].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("base64url");
  return { version: VERSION, action, requestId, params: params || {}, auth: { timestamp, nonce, signature } };
}

export function hubEnabled() { return process.env.HUB_SHADOW_ENABLED === "true" && Boolean(process.env.HUB_API_URL); }
export function previewEnabled() {
  const environment = String(process.env.MAP_PHASE2B_PREVIEW_ENV || "").toLowerCase();
  return process.env.MAP_PHASE2B_PREVIEW_ENABLED === "true"
    && (environment === "stage" || environment === "production")
    && Boolean(process.env.HUB_API_URL)
    && String(process.env.HUB_API_SECRET || "").length >= 32;
}

export async function callHub(action, params, { useCache = true } = {}) {
  if (!process.env.HUB_API_URL) throw new Error("HUB_API_URL_NOT_CONFIGURED");
  const key = `${action}:${stable(params || {})}`;
  const entered = circuitEnter(action);
  const saved = cache.get(key);
  if (!entered.probe && useCache && saved && saved.expiresAt > Date.now()) return saved.value;
  const started = Date.now();
  state.metrics.requests += 1;
  const actionTimeoutMs = {
    unifiedSearch: Number(process.env.HUB_SEARCH_TIMEOUT_MS || 30000),
    customerDetail: Number(process.env.HUB_DETAIL_TIMEOUT_MS || 30000),
    nearestVehicles: Number(process.env.HUB_NEAREST_TIMEOUT_MS || 30000),
    mapBounds: Number(process.env.HUB_BOUNDS_TIMEOUT_MS || 30000),
    routePlan: Number(process.env.HUB_ROUTE_TIMEOUT_MS || 25000)
  };
  const timeoutMs = actionTimeoutMs[action] || Number(process.env.HUB_API_TIMEOUT_MS || 2000);
  let lastError;
  const attempts = entered.probe ? 1 : 2;
  let timedOut = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(process.env.HUB_API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(action, params)), signal: controller.signal });
      const json = await response.json();
      if (!json || typeof json.ok !== "boolean" || !json.meta) throw new Error("HUB_INVALID_CONTRACT");
      if (!response.ok || !json.ok) throw new Error(`HUB_${json?.error?.code || response.status}`);
      circuitSuccess(action, entered.circuit); state.metrics.success += 1; state.metrics.latencyMs.push(Date.now() - started);
      cache.set(key, { expiresAt: Date.now() + 60000, value: json });
      return json;
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") { state.metrics.timeout += 1; timedOut = true; } else state.metrics.error += 1;
    } finally { clearTimeout(timer); }
  }
  circuitFailure(action, entered.circuit, timedOut, entered.probe);
  throw lastError;
}

export function shadowHub(action, params, existing) {
  if (!hubEnabled()) return;
  callHub(action, params).then((hub) => {
    const localRows = Array.isArray(existing?.results) ? existing.results : Array.isArray(existing?.stops) ? existing.stops : Array.isArray(existing) ? existing : [];
    const hubRows = Array.isArray(hub.data) ? hub.data : Array.isArray(hub.data?.stops) ? hub.data.stops : [];
    const localCodes = new Set(localRows.map((x) => String(x.customerCode || x.code || "")).filter(Boolean));
    const hubCodes = new Set(hubRows.map((x) => String(x.customerCode || "")).filter(Boolean));
    const match = localRows.length === hubRows.length && [...localCodes].every((code) => hubCodes.has(code));
    state.metrics[match ? "match" : "mismatch"] += 1;
    console.info(JSON.stringify({ requestId: hub.meta.requestId, action, duration: hub.meta.durationMs, result: match ? "MATCH" : "MISMATCH" }));
  }).catch((error) => console.info(JSON.stringify({ requestId: crypto.randomUUID(), action, duration: null, result: error.name === "AbortError" ? "HUB_TIMEOUT" : "HUB_ERROR" })));
}

export function hubMetrics() {
  const m = state.metrics, sorted = m.latencyMs.slice().sort((a, b) => a - b);
  const circuits = {};
  state.circuits.forEach((value, action) => { circuits[action] = { state: value.state, failures: value.failures, openUntil: value.openUntil || null, probeInFlight: value.probeInFlight, lastFailure: value.lastFailure }; });
  return { ...m, latencyMs: undefined, p50: sorted[Math.floor(sorted.length * 0.5)] || 0, p95: sorted[Math.floor(sorted.length * 0.95)] || 0, circuitOpen: Object.values(circuits).some((x) => x.state === "OPEN"), circuits };
}
