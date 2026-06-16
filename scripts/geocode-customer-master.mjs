import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const customerMasterPath = path.join(projectRoot, "public", "customer-master-20260604.json");
const restApiKey = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_KEY || "";
const saveEvery = Number(process.env.GEOCODE_SAVE_EVERY || 100);
const delayMs = Number(process.env.GEOCODE_DELAY_MS || 120);
const timeoutMs = Number(process.env.GEOCODE_TIMEOUT_MS || 8000);
const retryFailed = process.env.GEOCODE_RETRY_FAILED === "1";

if (!restApiKey) {
  console.error("KAKAO_REST_API_KEY is required. Set the Kakao REST API key before running this script.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasCoords(customer) {
  const lat = Number(customer?.lat);
  const lng = Number(customer?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function normalizeAddress(address) {
  return String(address || "").replace(/\s+/g, " ").trim();
}

function geocodeQueries(address) {
  const normalized = normalizeAddress(address);
  const withoutParen = normalizeAddress(normalized.replace(/\([^)]*\)/g, " "));
  const roadOnly = normalizeAddress(withoutParen.replace(/\s+\d+\s*층.*$/i, "").replace(/\s+\d+호.*$/i, ""));
  return [...new Set([normalized, withoutParen, roadOnly].filter(Boolean))];
}

async function writeCustomerMaster(data) {
  await fs.writeFile(customerMasterPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function geocodeOne(query, endpoint = "address") {
  const url = new URL("https://dapi.kakao.com/v2/local/search/address.json");
  if (endpoint === "keyword") url.pathname = "/v2/local/search/keyword.json";
  url.searchParams.set("query", query);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `KakaoAK ${restApiKey}`
    }
  });
  if (!response.ok) {
    throw new Error(`Kakao Local API HTTP ${response.status}`);
  }
  const payload = await response.json();
  const first = payload.documents?.[0];
  if (!first) return { lat: null, lng: null, coordSource: "failed" };
  return {
    lat: Number(first.y || first.address?.y || first.road_address?.y),
    lng: Number(first.x || first.address?.x || first.road_address?.x),
    coordSource: endpoint === "keyword" ? "kakao_keyword" : "kakao_address"
  };
}

async function geocodeAddress(address) {
  for (const query of geocodeQueries(address)) {
    const byAddress = await geocodeOne(query, "address");
    if (byAddress.coordSource !== "failed") return byAddress;
  }
  for (const query of geocodeQueries(address)) {
    const byKeyword = await geocodeOne(query, "keyword");
    if (byKeyword.coordSource !== "failed") return byKeyword;
  }
  return { lat: null, lng: null, coordSource: "failed" };
}

const raw = await fs.readFile(customerMasterPath, "utf8");
const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
const customers = Array.isArray(data.customers) ? data.customers : [];
const addressCache = new Map();
let processed = 0;
let changed = 0;
let failed = 0;
let skipped = 0;
let cleaned = 0;
for (const customer of customers) {
  if (hasCoords(customer) && (!customer.coordSource || customer.coordSource === "failed")) {
    customer.coordSource = "existing_coord";
    cleaned += 1;
  }
}
const targets = customers.filter(customer => !hasCoords(customer) || (retryFailed && customer.coordSource === "failed"));

console.log(`Customer master: ${customers.length.toLocaleString()} rows`);
console.log(`Missing coordinates: ${targets.length.toLocaleString()} rows`);
console.log(`Cleaned existing coordinates: ${cleaned.toLocaleString()} rows`);
console.log(`Start geocoding. timeout ${timeoutMs}ms / delay ${delayMs}ms / save every ${saveEvery} rows`);

for (const customer of targets) {
  const address = normalizeAddress(customer.address);
  if (!address) {
    customer.lat = null;
    customer.lng = null;
    customer.coordSource = "failed";
    processed += 1;
    failed += 1;
  } else {
    if (!addressCache.has(address)) {
      try {
        addressCache.set(address, await geocodeAddress(address));
      } catch (error) {
        console.warn(`Failed: ${address} / ${error.message}`);
        addressCache.set(address, { lat: null, lng: null, coordSource: "failed" });
      }
      await sleep(delayMs);
    } else {
      skipped += 1;
    }
    const result = addressCache.get(address);
    customer.lat = result.lat;
    customer.lng = result.lng;
    customer.coordSource = result.coordSource;
    processed += 1;
    if (result.coordSource === "failed") failed += 1;
    else changed += 1;
  }

  if (processed % saveEvery === 0) {
    data.updatedAt = new Date().toISOString();
    await writeCustomerMaster(data);
    console.log(`Saved ${processed.toLocaleString()}/${targets.length.toLocaleString()} - success ${changed.toLocaleString()} - failed ${failed.toLocaleString()} - duplicate ${skipped.toLocaleString()}`);
  } else if (processed % 10 === 0) {
    console.log(`Progress ${processed.toLocaleString()}/${targets.length.toLocaleString()} - success ${changed.toLocaleString()} - failed ${failed.toLocaleString()} - duplicate ${skipped.toLocaleString()}`);
  }
}

data.updatedAt = new Date().toISOString();
await writeCustomerMaster(data);
console.log(`Done. success ${changed.toLocaleString()} - failed ${failed.toLocaleString()} - duplicate ${skipped.toLocaleString()}`);


