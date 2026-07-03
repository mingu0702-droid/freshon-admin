import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHEET_COLUMNS = [
  "deliveryDate", "vehicle", "sequence", "customerCode", "customerName",
  "address", "lat", "lng", "amount", "dailyAmount", "monthlyAmount",
  "deliveryPattern", "sourceFile", "savedOrder", "updatedAt"
];

const sheetId = process.env.GOOGLE_SHEET_ID || "";
const sheetName = process.env.GOOGLE_SHEET_NAME || "customers";
const serviceAccountBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || "";
const kakaoKey = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_KEY || "";
const dryRun = process.argv.includes("--dry-run");
const skipGeocode = process.argv.includes("--skip-geocode");

if (!sheetId) throw new Error("GOOGLE_SHEET_ID is required.");
if (!serviceAccountBase64) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is required.");

function b64url(value) { return Buffer.from(value).toString("base64url"); }
function normalize(value) { return String(value ?? "").trim(); }
function normalizeKey(value) { return normalize(value).replace(/\s+/g, "").toLowerCase(); }
function normalizeVehicle(value) { return normalize(value).replace(/호차/g, "").replace(/\s+/g, ""); }

function cleanAddress(address) {
  let s = normalize(address).replace(/\s+/g, " ");

  const duplicated = s.match(/^(.{8,})\s+\1(.*)$/);
  if (duplicated) s = `${duplicated[1]} ${duplicated[2]}`.trim();

  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/외\s*\d+필지/g, " ");
  s = s.replace(/\b(일부|전부|준코)\b/g, " ");
  s = s.replace(/\b(\d+)\s+\1번지\b/g, "$1번지");
  s = s.replace(/\b(\d+)\s+\1\b/g, "$1");

  s = s.replace(/([가-힣A-Za-z0-9·]+(?:로|길))(\d+(?:-\d+)?)/g, "$1 $2");
  s = s.replace(/^(.+?(?:로|길)\s+\d+(?:-\d+)?).*$/g, "$1");

  s = s.replace(/\s+[A-Z]?\d+[A-Z]?\s*호.*$/i, "");
  s = s.replace(/\s+\d+[~,.-]\d+.*$/g, "");
  s = s.replace(/\s+\d+\s*,.*$/g, "");
  s = s.replace(/\s+\d+\.?\s*$/g, "");
  s = s.replace(/\s+\d+\s*층.*$/g, "");
  s = s.replace(/\s+\d+\s*충.*$/g, "");
  s = s.replace(/\s+\d+\s*F.*$/gi, "");
  s = s.replace(/\s+B\d+.*$/gi, "");
  s = s.replace(/\s+지하.*$/g, "");
  s = s.replace(/\s+제?\d+전시.*$/g, "");
  s = s.replace(/\s+상가\d*동.*$/g, "");
  s = s.replace(/\s+\d+블럭.*$/g, "");
  s = s.replace(/\s+\d+[A-Z]-?\d*[A-Z]*.*$/gi, "");

  s = s.replace(/\s+(에그드랍|바로반점|중국집|돌고래|오늘도오리|베이글릿|쪽찌|포코앤포코|쉼프레소티하우스|큐푸드컴퍼니|단토리).*$/i, "");
  s = s.replace(/\s+.*(하역장|검품장|창고|로비|정육코너|푸드코트).*$/i, "");

  return s.replace(/\s+/g, " ").trim();
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
    normalizeKey(row.customerCode) || `${normalizeKey(row.customerName)}|${normalizeKey(row.address)}`
  ].join("|");
}

function rowScore(row) {
  return (hasCoords(row) ? 100 : 0)
    + (numberValue(row.amount) || numberValue(row.dailyAmount) || numberValue(row.monthlyAmount) ? 80 : 0)
    + (/freshon|프레시온/i.test(normalize(row.sourceFile)) ? 30 : 0)
    + (normalizeVehicle(row.vehicle) ? 3 : 0)
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
    if (hasCoords(row) && row.address) {
      cache.set(normalizeKey(row.address), { lat: row.lat, lng: row.lng });
    }
  }

  return cache;
}

async function geocodeAddress(address) {
  if (!kakaoKey || skipGeocode) {
    return { coord: null, reason: "API_ERROR", kakaoStatus: "NO_KEY_OR_SKIPPED", kakaoBody: "" };
  }

  const query = cleanAddress(address);

  if (!query) {
    return { coord: null, reason: "EMPTY_ADDRESS", kakaoStatus: "", kakaoBody: "" };
  }

  let lastStatus = "";
  let lastBody = "";

  for (const endpoint of ["address", "keyword"]) {
    const url = endpoint === "address"
      ? `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}`
      : `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}`;

    const response = await fetch(url, { headers: { authorization: `KakaoAK ${kakaoKey}` } });
    const body = await response.json().catch(() => ({}));

    lastStatus = String(response.status);
    lastBody = JSON.stringify(body).slice(0, 500);

    if (!response.ok) {
      return { coord: null, reason: "API_ERROR", kakaoStatus: lastStatus, kakaoBody: lastBody };
    }

    const doc = body.documents?.[0];

    if (doc?.y && doc?.x) {
      return {
        coord: { lat: String(doc.y), lng: String(doc.x) },
        reason: "",
        kakaoStatus: lastStatus,
        kakaoBody: lastBody
      };
    }
  }

  return { coord: null, reason: "NO_RESULT", kakaoStatus: lastStatus || "200", kakaoBody: lastBody };
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeFailedGeocodeCsv(failedRows) {
  const outputDir = "outputs";
  fs.mkdirSync(outputDir, { recursive: true });

  const filePath = path.join(outputDir, "failed-geocode.csv");
  const headers = [
    "rowNumber", "customerCode", "customerName", "originalAddress",
    "cleanedAddress", "reason", "kakaoStatus", "kakaoBody"
  ];

  const lines = [
    headers.join(","),
    ...failedRows.map((item) => headers.map((header) => csvEscape(item[header])).join(","))
  ];

  fs.writeFileSync(filePath, "\uFEFF" + lines.join("\n"), "utf8");
}

async function enrichCoords(rows) {
  const cache = buildCoordCache(rows);
  let cached = 0;
  let geocoded = 0;
  let failed = 0;
  const failedRows = [];

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

    if (dryRun) {
      failed += 1;
      failedRows.push({
        rowNumber: row._index + 2,
        customerCode: row.customerCode,
        customerName: row.customerName,
        originalAddress: row.address,
        cleanedAddress: cleanAddress(row.address),
        reason: cleanAddress(row.address) ? "DRY_RUN_TARGET" : "EMPTY_ADDRESS",
        kakaoStatus: "",
        kakaoBody: ""
      });
      continue;
    }

    const result = await geocodeAddress(row.address);

    if (result.coord) {
      row.lat = result.coord.lat;
      row.lng = result.coord.lng;
      cache.set(key, result.coord);
      geocoded += 1;
    } else {
      failed += 1;
      failedRows.push({
        rowNumber: row._index + 2,
        customerCode: row.customerCode,
        customerName: row.customerName,
        originalAddress: row.address,
        cleanedAddress: cleanAddress(row.address),
        reason: result.reason || "UNKNOWN",
        kakaoStatus: result.kakaoStatus || "",
        kakaoBody: result.kakaoBody || ""
      });
    }
  }

  writeFailedGeocodeCsv(failedRows);
  return { cached, geocoded, failed };
}

function valuesFromRows(rows) {
  return [
    SHEET_COLUMNS,
    ...rows.map((row, index) => SHEET_COLUMNS.map((column) => {
      return column === "savedOrder" ? String(index + 1) : normalize(row[column]);
    }))
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

