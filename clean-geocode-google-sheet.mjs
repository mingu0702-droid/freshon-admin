import crypto from "node:crypto";

const SHEET_COLUMNS = [
  "deliveryDate",
  "vehicle",
  "sequence",
  "customerCode",
  "customerName",
  "address",
  "lat",
  "lng",
  "amount",
  "dailyAmount",
  "monthlyAmount",
  "deliveryPattern",
  "sourceFile",
  "savedOrder",
  "updatedAt"
];

const sheetId = process.env.GOOGLE_SHEET_ID || "";
const sheetName = process.env.GOOGLE_SHEET_NAME || "customers";
const serviceAccountBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || "";
const kakaoKey = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_KEY || "";
const dryRun = process.argv.includes("--dry-run");
const skipGeocode = process.argv.includes("--skip-geocode");

if (!sheetId) throw new Error("GOOGLE_SHEET_ID is required.");
if (!serviceAccountBase64) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is required.");

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function normalize(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return normalize(value).replace(/\s+/g, "").toLowerCase();
}

function normalizeVehicle(value) {
  return normalize(value).replace(/호차/g, "").replace(/\s+/g, "");
}

function numberValue(value) {
  const parsed = Number(normalize(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasCoords(row) {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return lat >= 32 && lat <= 39 && lng >= 124 && lng <= 132;
}

function rowIdentity(row) {
  return [
    normalize(row.deliveryDate),
    normalizeVehicle(row.vehicle),
    normalizeKey(row.customerCode) || normalizeKey(row.customerName),
    normalizeKey(row.address)
  ].join("|");
}

function rowScore(row) {
  return (hasCoords(row) ? 100 : 0)
    + (numberValue(row.amount) ? 30 : 0)
    + (numberValue(row.dailyAmount) ? 20 : 0)
    + (numberValue(row.monthlyAmount) ? 10 : 0)
    + (normalize(row.sourceFile) ? 1 : 0);
}

function parseServiceAccount() {
  return JSON.parse(Buffer.from(serviceAccountBase64, "base64").toString("utf8"));
}

async function getAccessToken() {
  const account = parseServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google token failed: ${body.error_description || body.error || response.status}`);
  return body.access_token;
}

async function readSheet(token) {
  const range = `${sheetName}!A:O`;
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google sheet read failed: ${body.error?.message || response.status}`);
  return body.values || [];
}

function rowsFromValues(values) {
  const headers = (values[0] || []).map(normalize);
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  return values.slice(1).map((row, index) => {
    const obj = { _index: index };
    for (const column of SHEET_COLUMNS) {
      const columnIndex = indexByHeader.has(column) ? indexByHeader.get(column) : SHEET_COLUMNS.indexOf(column);
      obj[column] = normalize(row[columnIndex]);
    }
    return obj;
  }).filter((row) => row.deliveryDate && row.vehicle && (row.customerCode || row.customerName || row.address));
}

function dedupeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = rowIdentity(row);
    if (!key.replace(/\|/g, "")) continue;
    const previous = map.get(key);
    if (!previous || rowScore(row) >= rowScore(previous)) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a._index - b._index);
}

function buildCoordCache(rows) {
  const cache = new Map();
  for (const row of rows) {
    if (hasCoords(row) && row.address) cache.set(normalizeKey(row.address), { lat: row.lat, lng: row.lng });
  }
  return cache;
}

async function geocodeAddress(address) {
  if (!kakaoKey || skipGeocode) return null;
  const query = normalize(address);
  if (!query) return null;
  for (const endpoint of ["address", "keyword"]) {
    const url = endpoint === "address"
      ? `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}`
      : `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { authorization: `KakaoAK ${kakaoKey}` } });
    if (!response.ok) continue;
    const body = await response.json().catch(() => ({}));
    const doc = body.documents?.[0];
    if (doc?.y && doc?.x) return { lat: String(doc.y), lng: String(doc.x) };
  }
  return null;
}

async function enrichCoords(rows) {
  const cache = buildCoordCache(rows);
  let cached = 0;
  let geocoded = 0;
  let failed = 0;
  for (const row of rows) {
    if (hasCoords(row)) continue;
    const key = normalizeKey(row.address);
    const cachedCoord = cache.get(key);
    if (cachedCoord) {
      row.lat = cachedCoord.lat;
      row.lng = cachedCoord.lng;
      cached += 1;
      continue;
    }
    const coord = await geocodeAddress(row.address);
    if (coord) {
      row.lat = coord.lat;
      row.lng = coord.lng;
      cache.set(key, coord);
      geocoded += 1;
    } else {
      failed += 1;
    }
  }
  return { cached, geocoded, failed };
}

function valuesFromRows(rows) {
  return [
    SHEET_COLUMNS,
    ...rows.map((row, index) => SHEET_COLUMNS.map((column) => column === "savedOrder" ? String(index + 1) : normalize(row[column])))
  ];
}

async function writeSheet(token, values) {
  const range = `${sheetName}!A:O`;
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:clear`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  for (let start = 0; start < values.length; start += 5000) {
    const chunk = values.slice(start, start + 5000);
    const target = `${sheetName}!A${start + 1}`;
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(target)}?valueInputOption=RAW`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ values: chunk })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Google sheet write failed: ${body.error?.message || response.status}`);
  }
}

const token = await getAccessToken();
const values = await readSheet(token);
const sourceRows = rowsFromValues(values);
const dedupedRows = dedupeRows(sourceRows);
const coordStats = await enrichCoords(dedupedRows);
const outputValues = valuesFromRows(dedupedRows);

if (!dryRun) await writeSheet(token, outputValues);

console.log(JSON.stringify({
  dryRun,
  before: sourceRows.length,
  after: dedupedRows.length,
  removed: sourceRows.length - dedupedRows.length,
  coords: coordStats
}, null, 2));
