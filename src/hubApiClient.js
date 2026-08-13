import crypto from "node:crypto";

const VERSION = "map-phase2-v1";
const cache = new Map();
const state = { failures: 0, openUntil: 0, metrics: { requests: 0, success: 0, timeout: 0, error: 0, match: 0, mismatch: 0, latencyMs: [] } };

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
  return process.env.MAP_PHASE2B_PREVIEW_ENABLED === "true"
    && String(process.env.MAP_PHASE2B_PREVIEW_ENV || "").toLowerCase() === "stage"
    && Boolean(process.env.HUB_API_URL)
    && String(process.env.HUB_API_SECRET || "").length >= 32;
}

export async function callHub(action, params, { useCache = true } = {}) {
  if (!process.env.HUB_API_URL) throw new Error("HUB_API_URL_NOT_CONFIGURED");
  if (Date.now() < state.openUntil) throw new Error("HUB_CIRCUIT_OPEN");
  const key = `${action}:${stable(params || {})}`;
  const saved = cache.get(key);
  if (useCache && saved && saved.expiresAt > Date.now()) return saved.value;
  const started = Date.now();
  state.metrics.requests += 1;
  const timeoutMs = action === "unifiedSearch"
    ? Number(process.env.HUB_SEARCH_TIMEOUT_MS || 10000)
    : Number(process.env.HUB_API_TIMEOUT_MS || 2000);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(process.env.HUB_API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(action, params)), signal: controller.signal });
      const json = await response.json();
      if (!json || typeof json.ok !== "boolean" || !json.meta) throw new Error("HUB_INVALID_CONTRACT");
      if (!response.ok || !json.ok) throw new Error(`HUB_${json?.error?.code || response.status}`);
      state.failures = 0; state.metrics.success += 1; state.metrics.latencyMs.push(Date.now() - started);
      cache.set(key, { expiresAt: Date.now() + 60000, value: json });
      return json;
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") state.metrics.timeout += 1; else state.metrics.error += 1;
    } finally { clearTimeout(timer); }
  }
  state.failures += 1;
  if (state.failures >= 10) { state.openUntil = Date.now() + 300000; state.failures = 0; }
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
  return { ...m, latencyMs: undefined, p50: sorted[Math.floor(sorted.length * 0.5)] || 0, p95: sorted[Math.floor(sorted.length * 0.95)] || 0, circuitOpen: Date.now() < state.openUntil };
}
