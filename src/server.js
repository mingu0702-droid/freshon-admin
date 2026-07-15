Exit code: 0
Wall time: 0.8 seconds
Total output lines: 3391
Output:
import express from "express";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import multer from "multer";
import path from "node:path";
import XLSX from "xlsx";
import XlsxPopulate from "xlsx-populate";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requireAdmin, requireView } from "./auth.js";
import { clearDailyRouteCache, readDailyRoute, readDispatchCache, readDispatchCacheLocalFirst, readDispatchMeta, readMonthlyDispatchSummaryLocalFirst, writeDailyRoute, writeDailyRouteCache, writeMonthlyDispatchSummary } from "./store.js";
import { writeDispatchCache } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");
const vehicleAreaSourceUrl = path.join(publicDir, "vehicle-data.js");
const customerMasterSourceUrl = path.join(publicDir, "customer-master-20260604.json");
const decryptScriptPath = path.join(__dirname, "decrypt_office.py");
const parseExcelScriptPath = path.join(__dirname, "parse_excel.py");
const uploadDir = path.join(os.tmpdir(), "freshon-upload-files");
const chunkDir = path.join(os.tmpdir(), "freshon-upload-chunks");
fsSync.mkdirSync(uploadDir, { recursive: true });
fsSync.mkdirSync(chunkDir, { recursive: true });

const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, file, callback) => {
      const safeName = Buffer.from(file.originalname, "latin1").toString("utf8").replace(/[^\w.-]+/g, "_");
      callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`);
    }
  }),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 12
  }
});

app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static(publicDir));

let refreshState = {
  running: false,
  lastError: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  jobId: null
};

const dailyRouteSyncJobs = new Map();

let vehicleAreaDataPromise = null;
let customerMasterDataPromise = null;
let googleDispatchMemoryCache = null;
let googleRouteIndexMemoryCache = null;
let googleDriverMemoryCache = null;
let deliveryAdminSession = {
  cookie: config.deliveryAdminCookie || "",
  authorization: "",
  username: "",
  expiresAt: 0
};
let deliveryAdminLoginPromise = null;
let freshonSession = {
  cookie: config.freshonCookie || "",
  expiresAt: config.freshonCookie ? Date.now() + 5 * 60 * 1000 : 0,
  loginPromise: null
};
const authDiagnostics = {
  freshon: { firstStatus: null, loginStatus: null, retryStatus: null, lastError: null, updatedAt: null },
  delivery: { firstStatus: null, loginStatus: null, retryStatus: null, lastError: null, updatedAt: null }
};

function recordAuthDiagnostic(source, patch) {
  authDiagnostics[source] = { ...authDiagnostics[source], ...patch, updatedAt: new Date().toISOString() };
  console.info(JSON.stringify({ event: `${source}_auth`, ...patch, updatedAt: authDiagnostics[source].updatedAt }));
}

function normalizeCell(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeSearchValue(value) {
  return normalizeCell(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()]/g, "");
}

function normalizeLookupKey(value) {
  return normalizeCell(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()[\]{}_\-./:竊덌펹]/g, "");
}

function lookupRowValue(row, keys) {
  if (!row) return "";
  for (const key of keys) {
    const value = normalizeCell(row[key]);
    if (value) return value;
  }
  const entries = Object.entries(row || {});
  for (const key of keys) {
    const target = normalizeLookupKey(key);
    if (!target) continue;
    const match = entries.find(([entryKey, value]) => {
      const name = normalizeLookupKey(entryKey);
      return normalizeCell(value) && (name === target || name.includes(target) || target.includes(name));
    });
    if (match) return normalizeCell(match[1]);
  }
  return "";
}

function pickFirstValue(row, keys) {
  return lookupRowValue(row, keys);
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fixedDispatchSearchRow(row) {
  const address = pickFirstValue(row, ["고객주소", "주소", "배송주소", "address", "customerAddress"]);
  const detailAddress = pickFirstValue(row, ["상세주소", "detailAddress"]);
  const code = pickFirstValue(row, ["customerCode", "code", "custCd", "estCd", "erpCode", "customerERPCode", "고객코드", "고객 코드", "고객ERP코드", "고객사코드", "거래처코드", "매장코드"]);
  const name = pickFirstValue(row, ["고객명", "고객명(업체명)", "고객사명", "업체명", "customerName", "name"]);
  const vehicle = normalizeVehicleValue(pickFirstValue(row, ["확정호차", "기준호차", "호차", "배차호차", "배송호차", "vehicle", "vehicleNo", "carSeq", "carNm"]));
  const deliveryDate = normalizeDateValue(pickFirstValue(row, ["deliveryDate", "입고요청일(배송일)", "입고요청일", "배송일", "배송일자", "배송결과처리일시", "배차일", "운행일자", "기준일", "date"]));
  const lat = toFiniteNumber(row?.lat ?? row?.위도 ?? row?.latitude);
  const lng = toFiniteNumber(row?.lng ?? row?.경도 ?? row?.longitude);

  return {
    code,
    name,
    address: [address, detailAddress].filter(Boolean).join(" "),
    deliveryDate,
    vehicle,
    center: pickFirstValue(row, ["물류센터", "센터", "center"]),
    sourceFile: pickFirstValue(row, ["_sourceFile", "sourceFile"]),
    sourceSheet: pickFirstValue(row, ["_sourceSheet", "sourceSheet"]),
    gps: pickFirstValue(row, ["GPS정보", "gps"]),
    lat,
    lng,
    hasCoords: lat !== null && lng !== null
  };
}

function fixedDispatchSearchScore(item, query, normalizedQuery) {
  const fields = [item.code, item.name, item.address, item.vehicle, item.center].filter(Boolean);
  const normalizedFields = fields.map(normalizeSearchValue);
  if (normalizedFields.some((value) => value === normalizedQuery)) return 100;
  if (normalizeSearchValue(item.code) === normalizedQuery) return 95;
  if (normalizeSearchValue(item.name).includes(normalizedQuery)) return 80;
  if (normalizeSearchValue(item.address).includes(normalizedQuery)) return 70;
  if (fields.some((value) => value.includes(query))) return 60;
  if (normalizedFields.some((value) => value.includes(normalizedQuery))) return 50;
  return 0;
}

function buildFixedDispatchSearchItems(cache, query, preferredDate = "") {
  const normalizedQuery = normalizeSearchValue(query);
  const targetDate = normalizeDateValue(preferredDate);
  if (!normalizedQuery) return [];
  const seen = new Set();
  return (cache.rows || [])
    .map(fixedDispatchSearchRow)
    .map((item) => ({
      ...item,
      score: fixedDispatchSearchScore(item, query, normalizedQuery),
      dateScore: targetDate && item.deliveryDate === targetDate ? 1000 : 0
    }))
    .filter((item) => item.score > 0 && (item.code || item.name || item.address))
    .sort((a, b) => b.dateScore - a.dateScore
      || b.score - a.score
      || String(b.deliveryDate || "").localeCompare(String(a.deliveryDate || ""))
      || Number(b.hasCoords) - Number(a.hasCoords))
    .filter((item) => {
      const key = [normalizeSearchValue(item.code || item.address || item.name), targetDate ? String(item.deliveryDate || "") : ""].join("|");
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);
}

function sheetHeaderScore(row) {
  const joined = (row || []).map((value) => normalizeCell(value)).join("|");
  return [
    /고객|매장|거래처/,
    /주소|배송지/,
    /호차|차량/,
    /매출|주문|금액|amount/i,
    /배송|입고|일자|날짜|date/i,
    /순번|순서|착순/
  ].reduce((score, pattern) => score + (pattern.test(joined) ? 1 : 0), 0);
}

function inferDateFromSheetRows(values, fileName = "") {
  const source = [
    normalizeCell(fileName),
    ...(values || []).slice(0, 30).map((row) => (row || []).map((value) => normalizeCell(value)).join(" "))
  ].join(" ");
  const match = source.match(/(\d{2,4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (!match) return "";
  let [, year, month, day] = match;
  if (year.length === 2) year = `20${year}`;
  return `${String(Number(year)).padStart(4, "0")}-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

function rowsFromSheetValues(values, file, sheetName) {
  const rows = [];
  const columns = new Set();
  let headerIndex = -1;
  let bestScore = 0;
  (values || []).slice(0, 120).forEach((row, index) => {
    if (!Array.isArray(row) || !row.some((value) => normalizeCell(value))) return;
    const score = sheetHeaderScore(row);
    if (score > bestScore) {
      bestScore = score;
      headerIndex = index;
    }
  });
  if (headerIndex < 0 || bestScore < 3) {
    headerIndex = values.findIndex((row) => Array.isArray(row) && row.some((value) => normalizeCell(value)));
  }
  if (headerIndex < 0) return { rows, columns: [] };

  const headers = values[headerIndex].map((value, index) => normalizeCell(value) || `column_${index + 1}`);
  const inferredDate = inferDateFromSheetRows(values, file.originalname);
  if (inferredDate && !headers.some((header) => /(deliveryDate|date|입고요청일|배송일|배송일자|일자|날짜)/i.test(header))) {
    headers.push("_inferredDeliveryDate");
  }
  for (const header of headers) {
    if (header && !header.startsWith("__EMPTY")) columns.add(header);
  }

  for (const rowValues of values.slice(headerIndex + 1)) {
    const row = {};
    headers.forEach((header, index) => {
      const column = normalizeCell(header);
      if (!column || column.startsWith("__EMPTY")) return;
      row[column] = header === "_inferredDeliveryDate" && index >= (rowValues?.length || 0)
        ? inferredDate
        : normalizeCell(rowValues?.[index]);
    });
    if (Object.values(row).some(Boolean)) {
      row.__rawValues = rowValues.map((value) => normalizeCell(value));
      row.__headers = headers;
      row._sourceFile = file.originalname;
      row._sourceSheet = sheetName;
      rows.push(row);
    }
  }
  return { rows, columns: [...columns] };
}

function normalizeBaseUrl(value) {
  const text = String(value || "").trim() || "https://delivery-bali.chabyulhwa.com";
  const fixed = text.replace("delivery-api.chabyulhwa.com", "delivery-bali.chabyulhwa.com");
  try {
    const url = new URL(fixed);
    return url.origin.replace(/\/+$/, "");
  } catch {
    return fixed.replace(/\/+$/, "");
  }
}

function mergeCookieHeader(existing, setCookieHeaders) {
  const jar = new Map();
  const addCookie = (cookie) => {
    const first = String(cookie || "").split(";")[0].trim();
    if (!first || !first.includes("=")) return;
    const [name, ...rest] = first.split("=");
    if (name) jar.set(name, rest.join("="));
  };
  String(existing || "").split(";").forEach(addCookie);
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  headers.forEach(addCookie);
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function getSetCookieHeaders(response) {
  if (!response?.headers) return [];
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

async function deliveryAdminFetch(pathname, options = {}) {
  const baseUrl = normalizeBaseUrl(config.deliveryAdminBaseUrl);
  const url = pathname.startsWith("http") ? pathname : `${baseUrl}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
  const { timeoutMs = 25000, ...fetchOptions } = options;
  const cookie = fetchOptions.cookie || deliveryAdminSession.cookie || config.deliveryAdminCookie || "";
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "freshon-admin-route-sync/1.0",
    ...(fetchOptions.headers || {})
  };
  if (cookie) headers.Cookie = cookie;
  if (deliveryAdminSession.authorization) headers.Authorization = deliveryAdminSession.authorization;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      headers,
      signal: fetchOptions.signal || controller.signal,
      redirect: fetchOptions.redirect || "manual"
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Delivery admin request timed out after ${Math.round(timeoutMs / 1000)}s (${url})`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const setCookies = getSetCookieHeaders(response);
  if (setCookies.length) deliveryAdminSession.cookie = mergeCookieHeader(deliveryAdminSession.cookie || cookie, setCookies);
  return response;
}

async function readDeliveryAdminJson(pathname, options = {}) {
  const response = await deliveryAdminFetch(pathname, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Delivery admin HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function ensureDeliveryAdminSession(force = false) {
  if (!force && (deliveryAdminSession.cookie || deliveryAdminSession.authorization) && Date.now() < deliveryAdminSession.expiresAt) {
    return deliveryAdminSession.cookie || deliveryAdminSession.authorization;
  }
  if (config.deliveryAdminCookie && !force) {
    deliveryAdminSession.cookie = config.deliveryAdminCookie;
    deliveryAdminSession.expiresAt = Date.now() + 20 * 60 * 1000;
    return deliveryAdminSession.cookie;
  }
  if (!config.deliveryAdminId || !config.deliveryAdminPassword) {
    throw new Error("DELIVERY_ADMIN_ID and DELIVERY_ADMIN_PASSWORD are not configured.");
  }
  if (deliveryAdminLoginPromise) return deliveryAdminLoginPromise;
  deliveryAdminLoginPromise = (async () => {
    deliveryAdminSession.cookie = "";
    deliveryAdminSession.authorization = "";
    const attempts = [
      { url: "/api/auth/login", body: { username: config.deliveryAdminId, password: config.deliveryAdminPassword } },
      { url: "/api/auth/login", body: { id: config.deliveryAdminId, password: config.deliveryAdminPassword } },
      { url: "https://delivery-api.chabyulhwa.com/admin/auth/sign-in", body: { username: config.deliveryAdminId, password: config.deliveryAdminPassword } },
      { url: "https://delivery-api.chabyulhwa.com/admin/auth/sign-in", body: { id: config.deliveryAdminId, password: config.deliveryAdminPassword } }
    ];
    const errors = [];
    for (const attempt of attempts) {
      const response = await deliveryAdminFetch(attempt.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt.body)
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      const token = payload?.token || payload?.accessToken || payload?.access_token || payload?.data?.token || payload?.data?.accessToken || payload?.data?.access_token;
      if (token) deliveryAdminSession.authorization = `Bearer ${token}`;
      const redirectWithSession = response.status >= 300 && response.status < 400 && Boolean(deliveryAdminSession.cookie || deliveryAdminSession.authorization);
      if (response.ok || redirectWithSession) {
        deliveryAdminSession.username = config.deliveryAdminId;
        deliveryAdminSession.expiresAt = Date.now() + 20 * 60 * 1000;
        recordAuthDiagnostic("delivery", { loginStatus: response.status, hasCookie: Boolean(deliveryAdminSession.cookie), hasToken: Boolean(deliveryAdminSession.authorization), lastError: null });
        return deliveryAdminSession.cookie || deliveryAdminSession.authorization;
      }
      errors.push(`${attempt.url}: HTTP ${response.status}${payload?.message ? ` ${payload.message}` : ""}`);
    }
    const error = new Error(`Delivery admin login failed. Tried ${errors.join(" / ")}`);
    recordAuthDiagnostic("delivery", { loginStatus: Number(errors[0]?.match(/HTTP (\d+)/)?.[1] || 0) || null, lastError: error.message });
    throw error;
  })();
  try {
    return await deliveryAdminLoginPromise;
  } finally {
    deliveryAdminLoginPromise = null;
  }
}

function deliveryApiQuery(data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== "") params.append(key, String(item));
      });
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

async function deliveryAdminJson(pathname, options = {}) {
  await ensureDeliveryAdminSession(false);
  try {
    const payload = await readDeliveryAdminJson(pathname, options);
    recordAuthDiagnostic("delivery", { firstStatus: 200, retryStatus: null, lastError: null });
    return payload;
  } catch (error) {
    if (error.status !== 401) throw error;
    recordAuthDiagnostic("delivery", { firstStatus: 401, lastError: null });
    await ensureDeliveryAdminSession(true);
    try {
      const payload = await readDeliveryAdminJson(pathname, options);
      recordAuthDiagnostic("delivery", { retryStatus: 200, lastError: null });
      return payload;
    } catch (retryError) {
      recordAuthDiagnostic("delivery", { retryStatus: retryError.status || null, lastError: retryError.message || String(retryError) });
      throw retryError;
    }
  }
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function findArrayDeep(value, predicate, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length && value.some((item) => predicate(item))) return value;
    for (const item of value) {
      const found = findArrayDeep(item, predicate, seen);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findArrayDeep(item, predicate, seen);
    if (found) return found;
  }
  return null;
}

function parsePlainWorkbook(file) {
  const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
  const rows = [];
  const columns = new Set();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const values = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, header: 1…25907 tokens truncated…opCount - a.stopCount)
    .slice(0, 120);
  return {
    generatedAt: cache.generatedAt || null,
    range: cache.range || null,
    rowCount: rows.length || cache.rowCount || 0,
    totalAmount,
    vehicleCount: vehicles.size,
    storeCount: stores.size,
    coordinateMissingCount,
    vehicles: vehicleRows,
    stores: storeRows,
    rows,
    source: cache.source === "google-sheet" ? "google-sheet" : "monthly-dispatch-cache"
  };
}

app.get("/api/monthly-dispatch-summary", requireView, async (req, res) => {
  const forceGoogle = req.query.force === "1" || req.query.force === "true";
  const compact = req.query.compact === "1" || req.query.compact === "true";
  const cache = await readDispatchSource(true, forceGoogle);
  const meta = cache.source === "google-sheet" ? { generatedAt: cache.generatedAt } : await readDispatchMeta();
  const cached = await readMonthlyDispatchSummaryLocalFirst();
  if (cache.source !== "google-sheet" && cached && cached.cacheGeneratedFrom && meta?.generatedAt && cached.cacheGeneratedFrom === meta.generatedAt) {
    const payload = { ...cached, source: cached.source || "monthly-dispatch-summary-cache" };
    if (compact) delete payload.rows;
    return res.json(payload);
  }
  const summary = { ...buildMonthlyDispatchSummary(cache), cacheGeneratedFrom: cache.generatedAt || null, source: cache.source === "google-sheet" ? "google-sheet" : "monthly-dispatch-cache" };
  await writeMonthlyDispatchSummary(summary).catch(() => null);
  if (compact) delete summary.rows;
  res.json(summary);
});

app.get("/api/vehicle-driver-master", requireView, async (req, res) => {
  res.json(await readDriverMasterFromGoogleSheet({ date: String(req.query.date || "") }));
});

app.get("/api/fixed-dispatch/customer-search", requireView, async (req, res) => {
  const q = normalizeCell(req.query.q);
  if (!q) return res.json({ query: q, results: [] });
  const cache = await readDispatchSource(true);
  res.json({
    query: q,
    generatedAt: cache.generatedAt || null,
    rowCount: cache.rowCount || cache.rows?.length || 0,
    results: buildFixedDispatchSearchItems(cache, q, req.query.date)
  });
});

app.get("/api/monthly-dispatch-route", requireView, async (req, res) => {
  const date = normalizeDateValue(req.query.date);
  const vehicle = normalizeVehicleValue(req.query.vehicle);
  const center = normalizeCell(req.query.center);
  if (!date || !vehicle) return res.status(400).json({ error: "date and vehicle are required." });
  const indexedRoute = await readDailyRoute(date, vehicle).catch(() => null);
  if (indexedRoute?.stops?.length) {
    return res.json({ ...indexedRoute, source: indexedRoute.source || "google-sheet-route-index", api: "monthly-dispatch-route" });
  }
  const sheetIndexedRoute = await readRouteFromGoogleRouteIndex(date, vehicle).catch(() => null);
  if (sheetIndexedRoute?.stops?.length) {
    return res.json(sheetIndexedRoute);
  }
  const route = await buildFallbackDailyRoute({ date, vehicle, center });
  if (!route) {
    return res.status(404).json({
      error: `월시트에 ${date} ${vehicle}호 동선이 없습니다.`,
      source: "google-sheet",
      date,
      vehicle,
      center
    });
  }
  return res.json({ ...route, source: route.source || "google-sheet", api: "monthly-dispatch-route" });
});

app.get("/api/mobile/customer-search", requireView, async (req, res) => {
  const q = normalizeCell(req.query.q);
  if (!q) return res.json({ query: q, results: [] });
  const results = await buildCustomerSearchItems(q);
  res.json({
    query: q,
    results: results.map((item) => ({
      customerCode: item.code,
      customerName: item.name,
      address: item.address,
      vehicle: item.vehicle,
      route: item.route,
      sequence: item.sequence,
      hasCoords: item.hasCoords,
      lat: item.lat,
      lng: item.lng,
      source: item.source
    }))
  });
});

function dailyRouteSyncKey({ date, vehicle }) {
  return `${date}::${vehicle}`;
}

function publicDailyRouteSyncJob(job) {
  if (!job) return null;
  return {
    key: job.key,
    date: job.date,
    vehicle: job.vehicle,
    center: job.center,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    source: job.source || null,
    stopCount: job.stopCount ?? null,
    saved: Boolean(job.saved),
    savedAt: job.savedAt || null,
    monthKey: job.monthKey || monthKeyFromDate(job.date),
    dateBasis: job.dateBasis || "배송날짜",
    cacheType: job.cacheType || null
  };
}

async function runDailyRouteSyncJob(job) {
  try {
    let live = null;
    try {
      live = await buildDailyRouteFromFreshon({ date: job.date, vehicle: job.vehicle, center: job.center });
    } catch (cookieError) {
      job.cookieError = cookieError.message || String(cookieError);
      live = await buildDailyRouteFromFreshonLogin({ date: job.date, vehicle: job.vehicle, center: job.center });
    }
    if (!live) throw new Error("Freshon returned no daily route payload.");
    await writeDailyRoute(live);
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.source = live.source || "freshon";
    job.stopCount = Array.isArray(live.stops) ? live.stops.length : 0;
    job.saved = true;
    job.savedAt = job.finishedAt;
    job.monthKey = monthKeyFromDate(live.date || job.date);
    job.dateBasis = live.dateBasis || "배송날짜";
    job.cacheType = live.cacheType || "freshon-sync";
  } catch (error) {
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    job.error = error.message || String(error);
    job.diagnostics = error.diagnostics || error.diagnostic || null;
  }
}

app.all("/api/daily-route-sync", requireView, (_req, res) => {
  res.status(410).json({ error: "daily-route-sync is disabled. Use /api/monthly-dispatch-route." });
});

app.get("/api/daily-route", requireView, async (req, res) => {
  const date = String(req.query.date || "");
  const vehicle = String(req.query.vehicle || "");
  const center = String(req.query.center || "");
  const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
  const preferFreshon = req.query.source === "freshon" || req.query.live === "1" || forceRefresh;
  const preferDeliveryAdmin = req.query.source === "delivery-admin";
  if (!date || !vehicle) {
    return res.status(400).json({ error: "date and vehicle are required." });
  }
  if (!preferFreshon && !preferDeliveryAdmin) {
    const monthlyRoute = await buildFallbackDailyRoute({ date, vehicle, center });
    if (monthlyRoute) {
      await writeDailyRoute(monthlyRoute).catch(() => {});
      return res.json(monthlyRoute);
    }
    if (req.query.source !== "saved-cache") {
      return res.status(404).json({
        error: `월 데이터에 ${date} ${vehicle}호 동선이 없습니다.`,
        source: "monthly-dispatch-cache",
        date,
        vehicle,
        center
      });
    }
  }
  const cached = await readDailyRoute(date, vehicle);
  if (cached && !forceRefresh) {
    const dispatchCache = await readDispatchSource(true).catch(() => readDispatchCache());
    const cachedAt = cached.generatedAt ? Date.parse(cached.generatedAt) : 0;
    const dispatchAt = dispatchCache.generatedAt ? Date.parse(dispatchCache.generatedAt) : 0;
    if (cached.source !== "vehicle-area-fallback" && cached.source !== "uploaded-delivery-history" && (!dispatchAt || cachedAt >= dispatchAt)) {
      return res.json(cached);
    }
  }
  if (preferFreshon) {
    try {
      const live = await buildDailyRouteFromFreshon({ date, vehicle, center });
      if (live) {
        await writeDailyRoute(live);
        return res.json(live);
      }
    } catch (error) {
      try {
        const loginLive = await buildDailyRouteFromFreshonLogin({ date, vehicle, center });
        if (loginLive) {
          await writeDailyRoute(loginLive);
          return res.json(loginLive);
        }
      } catch (loginError) {
        error.loginFallback = {
          error: loginError.message || String(loginError),
          diagnostics: loginError.diagnostics || loginError.diagnostic || null
        };
      }
      if (req.query.source === "freshon") {
        return res.status(error.status || 502).json({
          error: error.message || "Freshon daily dispatch lookup failed.",
          source: "freshon-daily-dispatch",
          diagnostics: error.diagnostics || error.diagnostic || null,
          loginFallback: error.loginFallback || null
        });
      }
    }
  }
  if (preferDeliveryAdmin) {
    try {
      const live = await buildDailyRouteFromDeliveryAdmin({ date, vehicle, center });
      if (live) {
        await writeDailyRoute(live);
        return res.json(live);
      }
    } catch (error) {
      if (req.query.source === "delivery-admin") {
        return res.status(error.status || 502).json({
          error: error.message || "Delivery admin live route lookup failed.",
          source: "delivery-admin-live"
        });
      }
    }
  }
  const fallback = await buildFallbackDailyRoute({ date, vehicle, center });
  if (fallback) {
    await writeDailyRoute(fallback);
    return res.json(fallback);
  }
  const dispatchCache = await readDispatchSource(true);
  return res.status(404).json({
    error: "No cached daily route.",
    date,
    vehicle,
    fixedDispatchRows: dispatchCache.rowCount || dispatchCache.rows?.length || 0,
    fixedDispatchGeneratedAt: dispatchCache.generatedAt || null
  });
});

app.get("/api/delivery-admin/status", requireView, async (_req, res) => {
  res.json({
    configured: Boolean((config.deliveryAdminId && config.deliveryAdminPassword) || config.deliveryAdminCookie),
    hasCookie: Boolean(deliveryAdminSession.cookie || config.deliveryAdminCookie),
    baseUrl: config.deliveryAdminBaseUrl,
    usernameConfigured: Boolean(config.deliveryAdminId)
  });
});

app.get("/api/auth-status", requireView, async (_req, res) => {
  res.json({
    freshon: {
      credentialsConfigured: Boolean(config.freshonId && config.freshonPassword),
      environmentCookieConfigured: Boolean(config.freshonCookie),
      memoryCookieAvailable: Boolean(freshonSession.cookie),
      loginInFlight: Boolean(freshonSession.loginPromise),
      diagnostics: authDiagnostics.freshon
    },
    delivery: {
      credentialsConfigured: Boolean(config.deliveryAdminId && config.deliveryAdminPassword),
      environmentCookieConfigured: Boolean(config.deliveryAdminCookie),
      memoryCookieAvailable: Boolean(deliveryAdminSession.cookie),
      memoryTokenAvailable: Boolean(deliveryAdminSession.authorization),
      loginInFlight: Boolean(deliveryAdminLoginPromise),
      sessionExpiresAt: deliveryAdminSession.expiresAt ? new Date(deliveryAdminSession.expiresAt).toISOString() : null,
      diagnostics: authDiagnostics.delivery
    }
  });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

async function processUploadedDispatchFiles(files, jobId) {
  try {
    const current = await readDispatchCache();
    let columns = current.columns || [];
    let rows = current.rows || [];
    let uploadedRowsCount = 0;
    for (const [index, file] of files.entries()) {
      refreshState.currentFile = file.originalname;
      refreshState.completedFiles = index;
      refreshState.totalFiles = files.length;
      try {
        const parsed = await parseWorkbookWithPython(file);
        parsed.rows.forEach((row, rowIndex) => {
          row._savedOrder = rows.length + rowIndex + 1;
        });
        uploadedRowsCount += parsed.rows.length;
        columns = mergeColumns(columns, parsed.columns);
        rows = mergeRows(rows, parsed.rows);
        refreshState.uploadedRows = uploadedRowsCount;
        refreshState.rowCount = rows.length;
      } finally {
        if (file.path) await fs.rm(file.path, { force: true }).catch(() => {});
      }
    }

    if (!uploadedRowsCount) {
      throw new Error("No rows were found in the uploaded Excel files.");
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      source: "uploaded-excel",
      range: inferRange(rows),
      columns,
      rows,
      rowCount: rows.length,
      uploadedFiles: files.map((file) => ({
        name: file.originalname,
        size: file.size
      })),
      warning: null
    };

    await writeDispatchCache(payload);
    const normalizedForRouteIndex = normalizedDispatchRowsFromPayload(payload);
    await writeDailyRouteCache(buildDailyRouteCacheFromNormalizedRows(normalizedForRouteIndex.rows, normalizedForRouteIndex.generatedAt, "uploaded-dispatch-route-index"));
    await writeMonthlyDispatchSummary({ ...buildMonthlyDispatchSummary(payload), cacheGeneratedFrom: payload.generatedAt });
    let googleSheetSync = null;
    try {
      googleSheetSync = await syncDispatchToGoogleSheet(payload);
      console.log("Google Sheets sync result:", googleSheetSync);
    } catch (syncError) {
      googleSheetSync = {
        skipped: true,
        failed: true,
        reason: syncError.message
      };
      console.error("Google Sheets sync failed after upload:", syncError);
    }
    await clearDailyRouteCache("fixed dispatch Excel uploaded");
    refreshState = {
      ...refreshState,
      running: false,
      lastError: null,
      lastFinishedAt: new Date().toISOString(),
      currentFile: null,
      completedFiles: files.length,
      totalFiles: files.length,
      uploadedRows: uploadedRowsCount,
      rowCount: payload.rowCount,
      range: payload.range,
      googleSheetSync,
      jobId
    };
  } catch (error) {
    refreshState = {
      ...refreshState,
      running: false,
      lastError: error.message,
      lastFinishedAt: new Date().toISOString(),
      jobId
    };
    console.error(`Upload job ${jobId} failed:`, error);
  }
}

function safePathPart(value) {
  return String(value || "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 120) || "upload";
}

async function assembleChunkedUpload({ uploadId, totalChunks, fileName, size }) {
  const dir = path.join(chunkDir, safePathPart(uploadId));
  const outputPath = path.join(uploadDir, `${Date.now()}-${safePathPart(fileName)}`);
  const output = fsSync.createWriteStream(outputPath);
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const chunkPath = path.join(dir, `${index}.part`);
      await new Promise((resolve, reject) => {
        const input = fsSync.createReadStream(chunkPath);
        const cleanup = () => {
          input.off("error", onError);
          output.off("error", onError);
          input.off("end", onEnd);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onEnd = () => {
          cleanup();
          resolve();
        };
        input.on("error", onError);
        output.on("error", onError);
        input.on("end", onEnd);
        input.pipe(output, { end: false });
      });
      await fs.rm(chunkPath, { force: true }).catch(() => {});
    }
  } finally {
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on("error", reject);
    });
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return {
    path: outputPath,
    originalname: fileName,
    size: Number(size || 0)
  };
}

app.post("/api/upload-fixed-dispatch-chunk", requireAdmin, upload.single("chunk"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Chunk file is required." });

  try {
    const uploadId = safePathPart(req.body.uploadId);
    const index = Number(req.body.index);
    const totalChunks = Number(req.body.totalChunks);
    const fileName = String(req.body.fileName || file.originalname || "upload.xlsx");
    const fileSize = Number(req.body.fileSize || file.size || 0);
    if (!uploadId || !Number.isInteger(index) || !Number.isInteger(totalChunks) || index < 0 || totalChunks < 1 || index >= totalChunks) {
      throw new Error("Invalid chunk upload metadata.");
    }

    const dir = path.join(chunkDir, uploadId);
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(file.path, path.join(dir, `${index}.part`));

    if (index < totalChunks - 1) {
      return res.json({ ok: true, received: index + 1, totalChunks });
    }

    if (refreshState.running) {
      return res.status(409).json({ error: "Upload already running.", refresh: refreshState });
    }

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    refreshState = {
      running: true,
      lastError: null,
      lastStartedAt: new Date().toISOString(),
      lastFinishedAt: null,
      currentFile: fileName,
      completedFiles: 0,
      totalFiles: 1,
      uploadedRows: 0,
      rowCount: 0,
      range: null,
      jobId
    };

    res.status(202).json({ ok: true, accepted: true, jobId, refresh: refreshState });
    setTimeout(() => {
      assembleChunkedUpload({ uploadId, totalChunks, fileName, size: fileSize })
        .then((assembled) => processUploadedDispatchFiles([assembled], jobId))
        .catch((error) => {
          refreshState = {
            ...refreshState,
            running: false,
            lastError: error.message,
            lastFinishedAt: new Date().toISOString(),
            jobId
          };
          console.error(`Upload assemble job ${jobId} failed:`, error);
        });
    }, 250);
  } catch (error) {
    if (file.path) await fs.rm(file.path, { force: true }).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/upload-fixed-dispatch", requireAdmin, upload.array("files", 40), async (req, res) => {
  if (refreshState.running) {
    return res.status(409).json({ error: "Upload already running.", refresh: refreshState });
  }
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: "Excel files are required." });
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  refreshState = {
    running: true,
    lastError: null,
    lastStartedAt: new Date().toISOString(),
    lastFinishedAt: null,
    currentFile: files[0]?.originalname || null,
    completedFiles: 0,
    totalFiles: files.length,
    uploadedRows: 0,
    rowCount: 0,
    range: null,
    jobId
  };

  res.status(202).json({ ok: true, accepted: true, jobId, refresh: refreshState });
  setImmediate(() => {
    processUploadedDispatchFiles(files, jobId);
  });
});

app.use((error, _req, res, next) => {
  if (!error) return next();
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Excel file is too large. The current upload limit is 100MB per file."
      : `Excel upload failed: ${error.message}`;
    return res.status(413).json({ error: message });
  }
  return next(error);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Freshon dispatch admin listening on ${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; closing Freshon dispatch admin cleanly.`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));





















