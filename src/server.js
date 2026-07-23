import express from "express";
import { spawn } from "node:child_process";
import compression from "compression";
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
import { clearDailyRouteCache, readDailyRoute, readDispatchCache, readDispatchCacheLocalFirst, readDispatchCacheLocalOnly, readDispatchMeta, readMonthlyDispatchSummaryLocalFirst, writeDailyRoute, writeDailyRouteCache, writeMonthlyDispatchSummary } from "./store.js";
import { writeDispatchCache } from "./store.js";
import { getBrowserGateStatus } from "./scraper/browserGate.js";
import { recordRequest, runtimeSnapshot } from "./runtimeMetrics.js";

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
const GOOGLE_FETCH_TIMEOUT_MS = 8000;
function fetchWithTimeout(url, options = {}, timeoutMs = GOOGLE_FETCH_TIMEOUT_MS) {
  return fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeoutMs)
  });
}
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

app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.once("finish", () => {
    recordRequest(req.path, Number(process.hrtime.bigint() - started) / 1e6, res.statusCode);
  });
  next();
});
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
  if (!force && deliveryAdminSession.cookie && Date.now() < deliveryAdminSession.expiresAt) {
    return deliveryAdminSession.cookie;
  }
  if (config.deliveryAdminCookie && !force) {
    deliveryAdminSession.cookie = config.deliveryAdminCookie;
    deliveryAdminSession.expiresAt = Date.now() + 20 * 60 * 1000;
    return deliveryAdminSession.cookie;
  }
  if (!config.deliveryAdminId || !config.deliveryAdminPassword) {
    throw new Error("DELIVERY_ADMIN_ID and DELIVERY_ADMIN_PASSWORD are not configured.");
  }
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
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (response.ok) {
      const token = payload?.token || payload?.accessToken || payload?.access_token || payload?.data?.token || payload?.data?.accessToken || payload?.data?.access_token;
      if (token) deliveryAdminSession.authorization = `Bearer ${token}`;
      deliveryAdminSession.username = config.deliveryAdminId;
      deliveryAdminSession.expiresAt = Date.now() + 20 * 60 * 1000;
      return deliveryAdminSession.cookie || deliveryAdminSession.authorization;
    }
    errors.push(`${attempt.url}: HTTP ${response.status}${payload?.message ? ` ${payload.message}` : ""}`);
  }
  throw new Error(`Delivery admin login failed. Tried ${errors.join(" / ")}`);
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
    return await readDeliveryAdminJson(pathname, options);
  } catch (error) {
    if (error.status !== 401) throw error;
    await ensureDeliveryAdminSession(true);
    return readDeliveryAdminJson(pathname, options);
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
    const values = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, header: 1 });
    const parsed = rowsFromSheetValues(values, file, sheetName);
    rows.push(...parsed.rows);
    for (const column of parsed.columns) columns.add(column);
  }

  return { rows, columns: [...columns] };
}

async function withFileBuffer(file, callback) {
  if (file.buffer) return callback(file);
  if (!file.path) throw new Error(`${file.originalname} upload temp file was not found.`);
  const buffer = await fs.readFile(file.path);
  return callback({ ...file, buffer });
}

async function parseEncryptedWorkbook(file) {
  const workbook = await XlsxPopulate.fromDataAsync(file.buffer, { password: config.excelPassword });
  const rows = [];
  const columns = new Set();

  for (const sheet of workbook.sheets()) {
    const usedRange = sheet.usedRange();
    if (!usedRange) continue;
    const values = usedRange.value();
    const parsed = rowsFromSheetValues(values, file, sheet.name());
    rows.push(...parsed.rows);
    for (const column of parsed.columns) columns.add(column);
  }

  return { rows, columns: [...columns] };
}

function spawnDecryptWithPython(command, inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [decryptScriptPath, inputPath, outputPath, config.excelPassword], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} decrypt exited with code ${code}`));
      }
    });
  });
}

async function runPythonDecrypt(inputPath, outputPath) {
  const errors = [];
  for (const command of ["python3", "python"]) {
    try {
      await spawnDecryptWithPython(command, inputPath, outputPath);
      return;
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
    }
  }
  throw new Error(`Python Excel decrypt failed. ${errors.join(" / ")}`);
}

async function parseOfficeCryptoWorkbook(file) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "freshon-excel-"));
  const inputPath = path.join(tempDir, "input.xls");
  const outputPath = path.join(tempDir, "decrypted.xls");
  try {
    await fs.writeFile(inputPath, file.buffer);
    await runPythonDecrypt(inputPath, outputPath);
    const decryptedBuffer = await fs.readFile(outputPath);
    return parsePlainWorkbook({ ...file, buffer: decryptedBuffer });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function parseWorkbook(file) {
  try {
    return parsePlainWorkbook(file);
  } catch (error) {
    try {
      return await parseEncryptedWorkbook(file);
    } catch (encryptedError) {
      try {
        return await parseOfficeCryptoWorkbook(file);
      } catch (officeCryptoError) {
        throw new Error(`${file.originalname} ?뚯씪???쎌? 紐삵뻽?듬땲?? ?뷀샇??Excel 蹂듯샇?붾룄 ?ㅽ뙣?덉뒿?덈떎. ?뷀샇 ?ㅼ젙(EXCEL_PASSWORD)怨??뚯씪 ?뺤떇???뺤씤?댁＜?몄슂. (?쇰컲: ${error.message} / xlsx?뷀샇: ${encryptedError.message} / 援ы삎?뷀샇: ${officeCryptoError.message})`);
      }
    }
  }
}

async function parseWorkbookFast(file) {
  try {
    return parsePlainWorkbook(file);
  } catch (plainError) {
    try {
      return await parseOfficeCryptoWorkbook(file);
    } catch (officeCryptoError) {
      try {
        return await parseEncryptedWorkbook(file);
      } catch (encryptedError) {
        throw new Error(`${file.originalname} parse failed. Check EXCEL_PASSWORD and file format. (plain: ${plainError.message} / office: ${officeCryptoError.message} / xlsx: ${encryptedError.message})`);
      }
    }
  }
}

function spawnPythonParse(command, inputPath, outputPath, sourceName) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [parseExcelScriptPath, inputPath, outputPath, config.excelPassword, sourceName], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} parse exited with code ${code}`));
      }
    });
  });
}

async function parseWorkbookWithPython(file) {
  if (!file.path) return withFileBuffer(file, parseWorkbookFast);
  const outputPath = path.join(os.tmpdir(), `freshon-parse-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const errors = [];
  try {
    for (const command of ["python3", "python"]) {
      try {
        await spawnPythonParse(command, file.path, outputPath, file.originalname);
        const text = await fs.readFile(outputPath, "utf8");
        return JSON.parse(text);
      } catch (error) {
        errors.push(`${command}: ${error.message}`);
      }
    }
    return await withFileBuffer(file, parseWorkbookFast);
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

function makeRowKey(row) {
  const priorityKeys = [
    "date", "requestDate", "deliveryDate", "inReqDate", "enteringDate", "outDate",
    "customerCode", "customerERPCode", "erpCode", "custCd", "estCd",
    "vehicle", "vehicleNo", "carSeq", "carNm", "fixedCarSeq",
    "address", "customerAddress", "addr", "roadAddress"
  ];
  const values = [];
  for (const key of priorityKeys) {
    if (row[key]) values.push(normalizeCell(row[key]));
  }
  if (values.length >= 2) return values.join("|");
  const fallback = Object.entries(row)
    .filter(([key, value]) => !String(key).startsWith("_") && normalizeCell(value))
    .slice(0, 8)
    .map(([key, value]) => `${key}:${normalizeCell(value)}`);
  return fallback.length ? fallback.join("|") : JSON.stringify(row);
}
function mergeColumns(left = [], right = []) {
  return [...new Set([...left, ...right])].filter((column) => !String(column).startsWith("_"));
}

function mergeRows(existingRows = [], uploadedRows = []) {
  const map = new Map();
  for (const row of existingRows) map.set(makeRowKey(row), row);
  for (const row of uploadedRows) map.set(makeRowKey(row), row);
  return [...map.values()];
}

const DATE_COLUMN_RE = /(date|일자|날짜|입고요청일|배송일|출고일|확정일|requestDate|deliveryDate|inReqDate|enteringDate|outDate)/i;

function inferRange(rows) {
  const dates = [];
  for (const row of rows) {
    for (const [key, value] of Object.entries(row || {})) {
      if (String(key).startsWith("_")) continue;
      if (!DATE_COLUMN_RE.test(String(key))) continue;
      const normalized = normalizeDateValue(normalizeCell(value));
      if (normalized && normalized >= "2025-01-01") dates.push(normalized);
    }
  }
  dates.sort();
  if (!dates.length) return null;
  return { startDate: dates[0], endDate: dates[dates.length - 1] };
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function parseGoogleServiceAccount() {
  if (!config.googleServiceAccountJsonBase64 || !config.googleSheetId) return null;
  const json = Buffer.from(config.googleServiceAccountJsonBase64, "base64").toString("utf8");
  const account = JSON.parse(json);
  if (!account.client_email || !account.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is missing client_email/private_key.");
  }
  return account;
}

async function getGoogleAccessToken() {
  const account = parseGoogleServiceAccount();
  if (!account) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google token failed: ${body.error_description || body.error || response.status}`);
  return body.access_token;
}

const DISPATCH_SHEET_COLUMNS = [
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

function coordinateFromDispatchRow(row, type) {
  const direct = firstValue(row, type === "lat"
    ? ["lat", "latitude", "위도", "GPS위도"]
    : ["lng", "lon", "longitude", "경도", "GPS경도"]);
  if (direct) return direct;
  const gps = firstValue(row, ["GPS정보", "GPS", "좌표"]);
  const values = normalizeCell(gps).match(/-?\d+(?:\.\d+)?/g) || [];
  return values.length >= 2 ? values[type === "lat" ? 0 : 1] : "";
}

function dispatchDateFromRow(row) {
  const value = firstValue(row, [
    "deliveryDate", "_inferredDeliveryDate", "date", "requestDate", "inReqDate", "enteringDate", "outDate",
    "입고요청일(배송일)", "입고요청일", "배송일", "배송일자", "일자", "출고일", "배차일", "배차일자",
    "운행일자", "납품일자", "배송결과처리일시", "배송결과처리일", "배송완료일시", "배송완료일", "기준일"
  ]);
  return normalizeDateValue(value) || parseDispatchDate(value) || parseDispatchDate(row?._sourceFile || row?.sourceFile || "");
}

function dispatchVehicleFromRow(row) {
  return normalizeVehicleValue(firstValue(row, [
    "vehicle", "vehicleNo", "carSeq", "carNm", "carNo", "carNumber", "fixedCarSeq", "fixedVehicle", "changedVehicle",
    "확정호차", "기준호차", "호차", "차량", "차량번호", "차량호차", "배송호차", "배차호차", "운행호차", "변경호차",
    "확정차", "기준차", "변경차", "배송차", "배차차량", "운행차량", "차량호"
  ]));
}

function dispatchSequenceFromRow(row, fallback) {
  return firstValue(row, ["sequence", "routeOrder", "배송순번", "순번", "순서", "배송순서", "착순"]) || String(fallback);
}

function dispatchAddressFromRow(row, fallback = "") {
  const main = firstValue(row, [
    "address", "customerAddress", "고객주소", "주소", "배송주소", "도로명주소", "지번주소"
  ]);
  const detail = firstValue(row, [
    "addressDetail", "detailAddress", "상세주소", "상세주소1", "주소상세", "상세주소2", "상세"
  ]);
  return [main, detail]
    .map(normalizeCell)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim() || normalizeCell(fallback);
}

function normalizeDispatchRowForSheet(row, index, generatedAt) {
  const vehicle = normalizeVehicleValue(row?.vehicle || row?.vehicleNo || dispatchVehicleFromRow(row));
  const sequence = normalizeCell(row?.sequence || row?.routeOrder || row?.savedOrder || dispatchSequenceFromRow(row, index + 1));
  const stop = buildStopFromDispatchRow(row, vehicle, sequence);
  const amount = amountFromDispatchRow(row);
  const sourceFile = row._sourceFile || row.sourceFile || row.sourceFileName || row.fileName || row.excelFileNm || "";
  const deliveryDate = normalizeDateValue(row?.deliveryDate || row?.date || row?._inferredDeliveryDate || dispatchDateFromRow(row)) || parseDispatchDate(sourceFile);
  const customerCode = normalizeCell(row?.customerCode || row?.code || row?.custCd || row?.estCd || row?.erpCode || stop.customerCode || firstValue(row, ["고객코드", "고객 코드", "고객ERP코드", "ERP코드", "거래처코드", "매장코드"]));
  const customerName = normalizeCell(row?.customerName || row?.name || stop.customerName || firstValue(row, ["고객명", "매장명", "거래처명", "상호"]));
  const address = normalizeCell(row?.address || stop.address || dispatchAddressFromRow(row, stop.address));
  return {
    deliveryDate,
    vehicle,
    sequence,
    customerCode,
    customerName,
    address,
    lat: coordinateFromDispatchRow(row, "lat"),
    lng: coordinateFromDispatchRow(row, "lng"),
    amount,
    dailyAmount: amount,
    monthlyAmount: amount,
    deliveryPattern: firstValue(row, ["deliveryPattern", "배송패턴", "배송요일", "요일", "운행요일"]),
    sourceFile,
    savedOrder: row._savedOrder || index + 1,
    updatedAt: generatedAt
  };
}

function dedupeDispatchSheetRows(rows) {
  const map = new Map();
  const scoreRow = (row) => {
    const source = normalizeSearchValue(row.sourceFile || row._sourceFile || row.source || "");
    return (Number(row.amount || row.dailyAmount || row.monthlyAmount || 0) ? 100 : 0)
      + (source.includes("freshon") || source.includes("프레시온") ? 30 : 0)
      + (row.lat && row.lng ? 10 : 0)
      + (normalizeVehicleValue(row.vehicle) ? 3 : 0)
      + (Number(row.savedOrder || row.sequence || 0) ? 1 : 0);
  };
  for (const row of rows) {
    const customerKey = normalizeCell(row.customerCode) || `${normalizeSearchValue(row.customerName)}|${normalizeSearchValue(row.address)}`;
    const key = [row.deliveryDate, customerKey].join("|");
    if (!key.replace(/\|/g, "")) continue;
    const previous = map.get(key);
    if (!previous || scoreRow(row) >= scoreRow(previous)) map.set(key, row);
  }
  return [...map.values()];
}

function hasDispatchAmountColumn(row) {
  return Object.keys(row || {}).some((key) => {
    const header = normalizeCell(key);
    if (!/(매출|주문|출고|판매|공급|합계|금액|amount|amt|price)/i.test(header)) return false;
    return !/(기준|한도|비율|율|수량|중량|착지|건수|전화|연락|코드|호차|톤수)/i.test(header);
  });
}

function validateDispatchSheetAmounts(sourceRows, normalizedRows) {
  const amountColumnRows = sourceRows.filter(hasDispatchAmountColumn).length;
  const nonZeroAmountRows = normalizedRows.filter((row) => Number(row.amount || 0)).length;
  if (amountColumnRows >= 20 && nonZeroAmountRows === 0) {
    throw new Error("엑셀에 매출금액 컬럼이 있지만 금액을 0원으로만 읽었습니다. 1~5월/6월 양식 금액 컬럼 파싱을 확인해야 합니다.");
  }
}


function normalizedDispatchRowsFromPayload(payload) {
  const generatedAt = payload.generatedAt || new Date().toISOString();
  const sourceRows = Array.isArray(payload.rows) ? payload.rows : [];
  const rows = dedupeDispatchSheetRows(sourceRows
    .map((row, index) => normalizeDispatchRowForSheet(row, index, generatedAt))
    .filter((row) => row.deliveryDate && row.vehicle && (row.customerCode || row.customerName || row.address)));
  validateDispatchSheetAmounts(sourceRows, rows);
  return { generatedAt, sourceRows, rows };
}

function buildDailyRouteCacheFromNormalizedRows(rows, generatedAt, source = "sheet-index") {
  const groups = new Map();
  for (const row of rows || []) {
    const date = normalizeDateValue(row.deliveryDate);
    const vehicle = normalizeVehicleValue(row.vehicle);
    if (!date || !vehicle) continue;
    const key = `${date}|${vehicle}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const routes = {};
  for (const [key, groupRows] of groups.entries()) {
    const [date, vehicle] = key.split("|");
    const sortedRows = dedupeDispatchSheetRows(groupRows)
      .map((row, index) => ({ row, index }))
      .sort((left, right) => routeSortValue(left.row, left.index) - routeSortValue(right.row, right.index))
      .map((item) => item.row);
    routes[date] ||= {};
    routes[date][vehicle] = {
      generatedAt,
      source,
      date,
      vehicle,
      center: "",
      rowCount: sortedRows.length,
      cacheHit: true,
      cacheType: "daily-route-index",
      dateBasis: "배송일자",
      stops: sortedRows.map((row, index) => buildStopFromDispatchRow(row, vehicle, index + 1))
    };
  }
  return { generatedAt, source, routes, routeCount: [...groups.keys()].length, rowCount: rows.length };
}

function buildRouteIndexValuesFromNormalizedRows(rows, generatedAt) {
  const cache = buildDailyRouteCacheFromNormalizedRows(rows, generatedAt, "route-index-preview");
  const values = [["deliveryDate", "vehicle", "rowCount", "totalAmount", "updatedAt", "payload"]];
  Object.entries(cache.routes || {}).forEach(([date, vehicles]) => {
    Object.entries(vehicles || {}).forEach(([vehicle, route]) => {
      const totalAmount = (route.stops || []).reduce((sum, stop) => sum + Number(stop.amount || stop.dailyAmount || 0), 0);
      values.push([date, vehicle, route.rowCount || route.stops?.length || 0, Math.round(totalAmount), generatedAt, JSON.stringify(route)]);
    });
  });
  return values;
}

function buildSheetValues(payload) {
  const { rows } = normalizedDispatchRowsFromPayload(payload);
  const columns = DISPATCH_SHEET_COLUMNS;
  return [
    columns,
    ...rows.map((row) => columns.map((column) => normalizeCell(row[column])))
  ];
}

async function getGoogleSheetNameAndHeaders(headers) {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}?fields=sheets.properties.title`;
  const metaResponse = await fetchWithTimeout(metaUrl, { headers });
  const metaBody = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) throw new Error(`Google sheet metadata failed: ${metaBody.error?.message || metaResponse.status}`);
  const sheetTitles = (metaBody.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);
  const wantedSheetName = config.googleSheetName || "customers";
  const sheetName = sheetTitles.includes(wantedSheetName) ? wantedSheetName : sheetTitles[0];
  if (!sheetName) throw new Error("Google spreadsheet has no readable sheet tab.");
  return { sheetName, wantedSheetName };
}


async function ensureGoogleSheetTab(headers, sheetName) {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}?fields=sheets.properties.title`;
  const metaResponse = await fetch(metaUrl, { headers });
  const metaBody = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) throw new Error(`Google sheet metadata failed: ${metaBody.error?.message || metaResponse.status}`);
  const titles = (metaBody.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);
  if (titles.includes(sheetName)) return;
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}:batchUpdate`;
  const response = await fetch(batchUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !String(body.error?.message || "").includes("already exists")) {
    throw new Error(`Google sheet tab create failed (${sheetName}): ${body.error?.message || response.status}`);
  }
}

async function clearAndWriteGoogleSheetValues(headers, sheetName, values) {
  await ensureGoogleSheetTab(headers, sheetName);
  const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/${encodeURIComponent(sheetName)}:clear`;
  const clearResponse = await fetch(clearUrl, { method: "POST", headers, body: "{}" });
  if (!clearResponse.ok && clearResponse.status !== 400) {
    const text = await clearResponse.text();
    throw new Error(`Google sheet clear failed (${sheetName}): HTTP ${clearResponse.status} ${text.slice(0, 200)}`);
  }
  const columns = values[0] || [];
  const dataRows = values.slice(1);
  const chunkSize = 5000;
  let updatedRows = 0;
  let updatedRange = "";
  for (let offset = 0; offset < dataRows.length || offset === 0; offset += chunkSize) {
    const batch = offset === 0 ? [columns, ...dataRows.slice(0, chunkSize)] : dataRows.slice(offset, offset + chunkSize);
    if (!batch.length || (batch.length === 1 && !batch[0].length)) break;
    const startRow = offset === 0 ? 1 : offset + 2;
    const range = `${sheetName}!A${startRow}`;
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    const updateResponse = await fetch(updateUrl, { method: "PUT", headers, body: JSON.stringify({ values: batch }) });
    const updateBody = await updateResponse.json().catch(() => ({}));
    if (!updateResponse.ok) throw new Error(`Google sheet update failed (${sheetName}) at row ${startRow}: ${updateBody.error?.message || updateResponse.status}`);
    updatedRows += offset === 0 ? Math.max(0, batch.length - 1) : batch.length;
    updatedRange = updateBody.updatedRange || updatedRange;
  }
  return { updatedRows, updatedRange, columns: columns.length };
}

async function getGoogleSheetTab(headers, spreadsheetId, wantedName = "", wantedGid = null, fallbackName = "customers") {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(title,sheetId)`;
  const metaResponse = await fetch(metaUrl, { headers });
  const metaBody = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) throw new Error(`Google sheet metadata failed: ${metaBody.error?.message || metaResponse.status}`);
  const sheets = (metaBody.sheets || []).map((sheet) => sheet.properties || {}).filter((sheet) => sheet.title);
  const byGid = Number.isFinite(wantedGid) ? sheets.find((sheet) => Number(sheet.sheetId) === Number(wantedGid)) : null;
  const titles = sheets.map((sheet) => sheet.title);
  const wantedSheetName = wantedName || fallbackName;
  const sheetName = byGid?.title || (titles.includes(wantedSheetName) ? wantedSheetName : titles[0]);
  if (!sheetName) throw new Error("Google spreadsheet has no readable sheet tab.");
  return { sheetName, wantedSheetName };
}

async function readRowsFromGoogleSheet({ spreadsheetId, sheetName, sheetGid, fallbackName, force = false, cacheKey = "" }) {
  if (!spreadsheetId || !config.googleServiceAccountJsonBase64) return null;
  if (!force && cacheKey === "driver" && googleDriverMemoryCache && Date.now() - googleDriverMemoryCache.readAt < 60 * 1000) return googleDriverMemoryCache.payload;
  const token = await getGoogleAccessToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const tab = await getGoogleSheetTab(headers, spreadsheetId, sheetName, sheetGid, fallbackName);
  const range = `${tab.sheetName}!A:O`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const response = await fetchWithTimeout(url, { headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google sheet read failed: ${body.error?.message || response.status}`);
  const values = Array.isArray(body.values) ? body.values : [];
  const columns = (values[0] || []).map((value) => normalizeCell(value)).filter(Boolean);
  const rows = values.slice(1).map((line, index) => {
    const row = {};
    columns.forEach((column, columnIndex) => { row[column] = normalizeCell(line[columnIndex]); });
    row._savedOrder = index + 1;
    row._sourceSheet = tab.sheetName;
    return row;
  }).filter((row) => Object.values(row).some((value) => normalizeCell(value)));
  const payload = { generatedAt: new Date().toISOString(), sheetName: tab.sheetName, columns, rows, rowCount: rows.length };
  if (cacheKey === "driver") googleDriverMemoryCache = { readAt: Date.now(), payload };
  return payload;
}

async function readRouteFromGoogleRouteIndex(date, vehicle, { force = false } = {}) {
  const requestedDate = normalizeDateValue(date);
  const requestedVehicle = normalizeVehicleValue(vehicle);
  if (!requestedDate || !requestedVehicle || !config.googleSheetId || !config.googleServiceAccountJsonBase64) return null;
  const cacheKey = `${requestedDate}|${requestedVehicle}`;
  const monthTab = `route_index_${requestedDate.slice(0, 7).replace("-", "_")}`;
  const token = await getGoogleAccessToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function loadIndexRows(sheetName) {
    const indexRange = `${sheetName}!A:E`;
    const indexUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/${encodeURIComponent(indexRange)}?majorDimension=ROWS`;
    const indexResponse = await fetchWithTimeout(indexUrl, { headers });
    const indexBody = await indexResponse.json().catch(() => ({}));
    if (!indexResponse.ok) return null;
    const values = Array.isArray(indexBody.values) ? indexBody.values : [];
    const columns = (values[0] || []).map((value) => normalizeCell(value));
    const dateIndex = columns.indexOf("deliveryDate");
    const vehicleIndex = columns.indexOf("vehicle");
    const rows = new Map();
    if (dateIndex >= 0 && vehicleIndex >= 0) {
      values.slice(1).forEach((line, offset) => {
        const rowDate = normalizeDateValue(line[dateIndex]);
        const rowVehicle = normalizeVehicleValue(line[vehicleIndex]);
        if (rowDate && rowVehicle) rows.set(`${rowDate}|${rowVehicle}`, offset + 2);
      });
    }
    return { sheetName, rows };
  }
  const cacheTabKey = `${monthTab}|route_index`;
  if (force || !googleRouteIndexMemoryCache || googleRouteIndexMemoryCache.cacheTabKey !== cacheTabKey || Date.now() - googleRouteIndexMemoryCache.readAt >= 10 * 60 * 1000) {
    const monthRows = await loadIndexRows(monthTab);
    const fallbackRows = monthRows?.rows?.size ? null : await loadIndexRows("route_index");
    const picked = monthRows?.rows?.size ? monthRows : fallbackRows;
    googleRouteIndexMemoryCache = { readAt: Date.now(), cacheTabKey, sheetName: picked?.sheetName || "route_index", rows: picked?.rows || new Map(), routes: new Map() };
  }
  if (googleRouteIndexMemoryCache.routes.has(cacheKey)) return googleRouteIndexMemoryCache.routes.get(cacheKey);
  const rowNumber = googleRouteIndexMemoryCache.rows.get(cacheKey);
  if (!rowNumber) return null;
  const payloadRange = `${googleRouteIndexMemoryCache.sheetName}!F${rowNumber}:F${rowNumber}`;
  const payloadUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/${encodeURIComponent(payloadRange)}?majorDimension=ROWS`;
  const payloadResponse = await fetchWithTimeout(payloadUrl, { headers });
  const payloadBody = await payloadResponse.json().catch(() => ({}));
  if (!payloadResponse.ok) return null;
  const payloadText = normalizeCell(payloadBody.values?.[0]?.[0]);
  if (!payloadText) return null;
  try {
    const route = JSON.parse(payloadText);
    if (!route?.stops?.length) return null;
    const payload = { ...route, date: requestedDate, vehicle: requestedVehicle, source: "google-sheet-route-index", api: "monthly-dispatch-route" };
    googleRouteIndexMemoryCache.routes.set(cacheKey, payload);
    return payload;
  } catch {
    return null;
  }
}
async function readDispatchFromGoogleSheet({ force = false } = {}) {
  if (!config.googleSheetId || !config.googleServiceAccountJsonBase64) return null;
  if (!force && googleDispatchMemoryCache && Date.now() - googleDispatchMemoryCache.readAt < 10 * 60 * 1000) {
    return googleDispatchMemoryCache.payload;
  }
  const token = await getGoogleAccessToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}?fields=sheets.properties.title`;
  const metaResponse = await fetchWithTimeout(metaUrl, { headers });
  const metaBody = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) throw new Error(`Google sheet metadata failed: ${metaBody.error?.message || metaResponse.status}`);
  const titles = (metaBody.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean);
  const preferred = config.googleSheetName || "customers";
  const orderedTitles = [...new Set([preferred, ...titles].filter((title) => titles.includes(title)))];
  for (const sheetName of orderedTitles) {
    const range = `${sheetName}!A:O`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
    const response = await fetchWithTimeout(url, { headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Google sheet read failed: ${body.error?.message || response.status}`);
    const values = Array.isArray(body.values) ? body.values : [];
    const columns = (values[0] || []).map((value) => normalizeCell(value)).filter(Boolean);
    const rawRows = values.slice(1)
      .map((line, index) => {
        const row = {};
        columns.forEach((column, columnIndex) => {
          row[column] = normalizeCell(line[columnIndex]);
        });
        row._savedOrder = index + 1;
        row._sourceSheet = sheetName;
        return row;
      })
      .filter((row) => Object.values(row).some((value) => normalizeCell(value)));
    if (!columns.length || !rawRows.length) continue;
    if (!isDispatchSheet(columns, rawRows)) continue;
    const generatedAt = new Date().toISOString();
    const rows = dedupeDispatchSheetRows(rawRows
      .map((row, index) => normalizeDispatchRowForSheet(row, index, generatedAt))
      .filter((row) => row.deliveryDate && row.vehicle && (row.customerCode || row.customerName || row.address)));
    const payload = {
      generatedAt,
      source: "google-sheet",
      range: inferRange(rows),
      columns: DISPATCH_SHEET_COLUMNS,
      rows,
      rowCount: rows.length,
      sheetName,
      warning: sheetName === preferred ? null : `Configured sheet "${preferred}" was empty, so "${sheetName}" was used.`
    };
    googleDispatchMemoryCache = { readAt: Date.now(), payload };
    return payload;
  }
  return null;
}

async function readDispatchSource(preferGoogle = true, forceGoogle = false) {
  if (preferGoogle && config.googleSheetId && config.googleServiceAccountJsonBase64) {
    try {
      const sheetCache = await readDispatchFromGoogleSheet({ force: forceGoogle });
      if (sheetCache?.rows?.length) return sheetCache;
    } catch (error) {
      if (forceGoogle) console.error("Google sheet dispatch read failed; falling back to local cache:", error.message);
    }
    const localCache = await readDispatchCacheLocalFirst();
    if (localCache?.rows?.length) return { ...localCache, source: localCache.source || "local-dispatch-cache-fallback" };
    throw new Error("Google sheet dispatch data is empty and no local dispatch cache was found. Upload monthly dispatch Excel once to rebuild the sheet cache.");
  }
  return readDispatchCacheLocalFirst();
}

function isDispatchSheet(columns, rows = []) {
  const normalizedColumns = columns.map((column) => normalizeColumnName(column)).join("|");
  const hasVehicle = /(확정호차|기준호차|호차|배차호차|배송호차|vehicle)/i.test(normalizedColumns);
  const hasDate = /(입고요청일|배송일|배송결과처리일시|배차일|운행일자|기준일|date)/i.test(normalizedColumns);
  const hasAmount = /(매출|주문금액|출고금액|판매금액|금액|amount|amt|price)/i.test(normalizedColumns);
  const hasCustomer = /(고객|매장|거래처|customer|store|est)/i.test(normalizedColumns);
  const sampleHasDate = rows.slice(0, 30).some((row) => normalizeDateValue(firstValue(row, [
    "입고요청일(배송일)", "입고요청일", "배송일", "배송일자", "배송결과처리일시", "배송완료일시", "배차일", "운행일자", "기준일", "date", "deliveryDate", "updatedAt"
  ])));
  return hasCustomer && hasVehicle && (hasDate || sampleHasDate || hasAmount);
}

function effectiveDateFromDriverRow(row) {
  return parseDispatchDate(firstValue(row, ["적용일", "적용일자", "변경일", "변경일자", "시작일", "시작일자", "기준일"])) || "0000-00-00";
}

async function readDriverMasterFromGoogleSheet({ date = "" } = {}) {
  const sheet = await readRowsFromGoogleSheet({
    spreadsheetId: config.googleDriverSheetId,
    sheetName: config.googleDriverSheetName,
    sheetGid: config.googleDriverSheetGid,
    fallbackName: "기사연락처와 차량톤수",
    cacheKey: "driver"
  });
  const targetDate = parseDispatchDate(date) || "9999-12-31";
  const byVehicle = new Map();
  for (const row of sheet?.rows || []) {
    const vehicle = normalizeVehicleValue(firstValue(row, ["호차", "차량", "차량번호", "운행호차", "기준호차"]));
    if (!vehicle) continue;
    const effectiveDate = effectiveDateFromDriverRow(row);
    if (effectiveDate > targetDate) continue;
    const item = {
      vehicle,
      driverName: firstValue(row, ["기사명", "기사 이름", "배송기사명", "담당기사", "성명", "배송기사명", "기사"]),
      phone: firstValue(row, ["전화번호", "연락처", "기사연락처", "기사 연락처", "배송기사휴대전화번호", "배송기사 휴대전화번호", "휴대폰", "핸드폰"]),
      carrier: firstValue(row, ["운수사", "운수사명", "운수회사", "업체", "운송사", "소속", "협력사"]),
      ton: firstValue(row, ["톤수", "차량톤수", "차량 톤수", "차량톤수", "톤"]),
      effectiveDate
    };
    const prev = byVehicle.get(vehicle);
    if (!prev || item.effectiveDate >= prev.effectiveDate) byVehicle.set(vehicle, item);
  }
  return { generatedAt: sheet?.generatedAt || null, sheetName: sheet?.sheetName || null, rowCount: sheet?.rowCount || 0, vehicles: [...byVehicle.values()] };
}

function sheetRowIdentity(row) {
  const code = firstValue(row, ["customerCode", "code", "custCd", "estCd", "erpCode", "고객코드", "고객 코드", "고객ERP코드", "ERP코드", "거래처코드", "매장코드"]);
  const address = firstValue(row, ["고객주소", "주소", "배송주소"]);
  const name = firstValue(row, ["고객명", "매장명", "거래처명", "상호"]);
  const vehicle = firstValue(row, ["기준호차", "확정호차", "호차", "배송호차"]);
  if (code) return `code:${normalizeSearchValue(code)}`;
  return `addr:${normalizeSearchValue(address)}|name:${normalizeSearchValue(name)}|vehicle:${normalizeVehicleValue(vehicle)}`;
}

function dedupeRowsForSheet(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = sheetRowIdentity(row);
    if (!key || key === "addr:|name:|vehicle:") continue;
    const previous = map.get(key);
    const previousScore = previous ? Object.values(previous).filter((value) => normalizeCell(value)).length : -1;
    const score = Object.values(row || {}).filter((value) => normalizeCell(value)).length;
    if (!previous || score >= previousScore) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => Number(a?._savedOrder || 0) - Number(b?._savedOrder || 0));
}

async function syncDispatchToGoogleSheet(payload) {
  if (!config.googleSheetId || !config.googleServiceAccountJsonBase64) return { skipped: true, reason: "Google Sheets env not configured." };
  const token = await getGoogleAccessToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const { sheetName, wantedSheetName } = await getGoogleSheetNameAndHeaders(headers);
  const normalized = normalizedDispatchRowsFromPayload(payload);
  const values = [
    DISPATCH_SHEET_COLUMNS,
    ...normalized.rows.map((row) => DISPATCH_SHEET_COLUMNS.map((column) => normalizeCell(row[column])))
  ];
  const mainWrite = await clearAndWriteGoogleSheetValues(headers, sheetName, values);
  const routeIndexValues = buildRouteIndexValuesFromNormalizedRows(normalized.rows, normalized.generatedAt);
  const routeIndexWrite = await clearAndWriteGoogleSheetValues(headers, "route_index", routeIndexValues);
  const dailyRouteCache = buildDailyRouteCacheFromNormalizedRows(normalized.rows, normalized.generatedAt, "google-sheet-route-index");
  await writeDailyRouteCache(dailyRouteCache);
  googleDispatchMemoryCache = {
    readAt: Date.now(),
    payload: {
      generatedAt: normalized.generatedAt,
      source: "google-sheet",
      sheetName,
      range: inferRange(normalized.rows),
      columns: DISPATCH_SHEET_COLUMNS,
      rows: normalized.rows,
      rowCount: normalized.rows.length
    }
  };
  let verified = null;
  let verifyError = null;
  try {
    verified = await readDispatchFromGoogleSheet({ force: true });
  } catch (error) {
    verifyError = error.message;
  }
  return {
    skipped: false,
    sheetName,
    requestedSheetName: wantedSheetName,
    rows: mainWrite.updatedRows,
    columns: mainWrite.columns,
    updatedRange: mainWrite.updatedRange,
    routeIndexSheetName: "route_index",
    routeIndexRows: routeIndexWrite.updatedRows,
    routeCount: dailyRouteCache.routeCount,
    verifiedRows: verified?.rowCount || 0,
    verifiedRange: verified?.range || null,
    verifiedAt: verified?.generatedAt || null,
    verifyError
  };
}

async function readVehicleAreaData() {
  vehicleAreaDataPromise ||= fs.readFile(vehicleAreaSourceUrl, "utf8")
    .then((text) => {
      const jsonText = text
        .replace(/^window\.VEHICLE_AREA_DATA\s*=\s*/, "")
        .replace(/;\s*$/, "");
      return JSON.parse(jsonText);
    })
    .catch(() => ({ vehicles: [] }));
  return vehicleAreaDataPromise;
}

async function readCustomerMasterData() {
  customerMasterDataPromise ||= fs.readFile(customerMasterSourceUrl, "utf8")
    .then((text) => JSON.parse(text.replace(/^\uFEFF/, "")))
    .catch(() => ({ customers: [] }));
  return customerMasterDataPromise;
}

function customerSearchScore(item, query, normalizedQuery) {
  const fields = [item.code, item.name, item.address, item.vehicle, item.route, item.sequence].filter(Boolean);
  const normalizedFields = fields.map(normalizeSearchValue);
  if (normalizedFields.some((value) => value === normalizedQuery)) return 100;
  if (normalizeSearchValue(item.code) === normalizedQuery) return 95;
  if (normalizeSearchValue(item.name).includes(normalizedQuery)) return 85;
  if (normalizeSearchValue(item.address).includes(normalizedQuery)) return 75;
  if (fields.some((value) => value.includes(query))) return 65;
  if (normalizedFields.some((value) => value.includes(normalizedQuery))) return 55;
  return 0;
}

function pushCustomerSearchItem(results, seen, item, query, normalizedQuery) {
  if (!item || !(item.code || item.name || item.address)) return;
  const score = customerSearchScore(item, query, normalizedQuery);
  if (!score) return;
  const key = [item.code, item.name, item.address, item.vehicle, item.sequence].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  results.push({ ...item, score });
}

async function buildCustomerSearchItems(query) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return [];
  const results = [];
  const seen = new Set();
  const customerMaster = await readCustomerMasterData().catch(() => ({ customers: [] }));
  for (const row of customerMaster.customers || customerMaster.rows || []) {
    pushCustomerSearchItem(results, seen, {
      source: "customer-master",
      code: normalizeCell(row.customerCode || row.code),
      name: normalizeCell(row.customerName || row.storeName || row.name),
      address: normalizeCell(row.address),
      vehicle: normalizeVehicleValue(row.route || row.vehicle || row.vehicleNo),
      route: normalizeCell(row.logisticsCenter || row.center),
      sequence: normalizeCell(row.stopOrder || row.sequence),
      hasCoords: Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)),
      lat: Number.isFinite(Number(row.lat)) ? Number(row.lat) : null,
      lng: Number.isFinite(Number(row.lng)) ? Number(row.lng) : null
    }, query, normalizedQuery);
  }
  const vehicleAreaData = await readVehicleAreaData().catch(() => ({ vehicles: [] }));
  for (const vehicle of vehicleAreaData.vehicles || []) {
    for (const customer of vehicle.customers || []) {
      pushCustomerSearchItem(results, seen, {
        source: "vehicle-area",
        code: normalizeCell(customer.id || customer.code || customer.customerCode),
        name: normalizeCell(customer.name || customer.customerName),
        address: normalizeCell(customer.address),
        vehicle: normalizeVehicleValue(vehicle.vehicle),
        route: vehicle.area_label || vehicle.primary_area || "",
        sequence: normalizeCell(customer.sequence || customer.routeOrder || customer.order),
        hasCoords: Number.isFinite(customer.lat) && Number.isFinite(customer.lng),
        lat: Number.isFinite(customer.lat) ? customer.lat : null,
        lng: Number.isFinite(customer.lng) ? customer.lng : null
      }, query, normalizedQuery);
    }
  }
  const cachedDispatchRows = googleDispatchMemoryCache?.payload?.rows || [];
  for (const row of cachedDispatchRows) {
    const item = fixedDispatchSearchRow(row);
    pushCustomerSearchItem(results, seen, {
      source: "fixed-dispatch",
      code: item.code,
      name: item.name,
      address: item.address,
      vehicle: item.vehicle,
      route: item.center,
      sequence: normalizeCell(row?.착순 || row?.순번 || row?.routeOrder),
      hasCoords: item.hasCoords,
      lat: item.lat,
      lng: item.lng
    }, query, normalizedQuery);
  }
  const unique = new Set();
  return results
    .sort((a, b) => b.score - a.score || Number(b.hasCoords) - Number(a.hasCoords))
    .filter((item) => {
      const key = normalizeSearchValue(item.code || item.address || item.name);
      if (!key || unique.has(key)) return false;
      unique.add(key);
      return true;
    })
    .slice(0, 30);
}

function normalizeColumnName(value) {
  return normalizeLookupKey(value);
}

function firstValue(row, columns) {
  return lookupRowValue(row, columns);
}

function exactColumnValue(row, columns) {
  const entries = Object.entries(row);
  for (const column of columns) {
    const target = normalizeColumnName(column);
    const match = entries.find(([key, value]) => normalizeColumnName(key) === target && normalizeCell(value));
    if (match) return normalizeCell(match[1]);
  }
  return "";
}

function normalizeDateValue(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const yyyy = value.getFullYear();
    if (yyyy < 2020 || yyyy > 2035) return "";
    return value.toISOString().slice(0, 10);
  }
  const text = normalizeCell(value);
  if (!text) return "";
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (Number.isFinite(serial) && serial > 40000 && serial < 60000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      const yyyy = date.getUTCFullYear();
      if (yyyy >= 2020 && yyyy <= 2035) return date.toISOString().slice(0, 10);
    }
  }
  const match = text.match(/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
  if (!match) return "";
  const yyyy = Number(match[1]);
  if (!Number.isFinite(yyyy) || yyyy < 2020 || yyyy > 2035) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function monthKeyFromDate(date) {
  const normalized = normalizeDateValue(date);
  return normalized ? normalized.slice(0, 7) : "";
}

function numberFromMoney(value) {
  const raw = normalizeCell(value).replace(/[^\d.-]/g, "");
  const number = Number(raw);
  return Number.isFinite(number) ? number : 0;
}

function excelSerialDateToIso(value) {
  const text = normalizeCell(value);
  const serial = typeof value === "number"
    ? value
    : (/^\d{5}(?:\.\d+)?$/.test(text) ? Number(text) : NaN);
  if (!Number.isFinite(serial) || serial < 35000 || serial > 60000) return "";
  const date = new Date(Math.round((serial - 25569) * 86400000));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function plausibleAmountFromCell(value, header = "") {
  const text = normalizeCell(value);
  if (!text) return 0;
  const title = normalizeCell(header);
  if (!/(매출|주문|출고|판매|공급|합계|금액|amount|amt|price)/i.test(title)) return 0;
  if (/(일자|날짜|전화|연락|휴대|주소|코드|호차|톤수|착지|순번|순서|중량|수량|건수)/i.test(title)) return 0;
  if (/20\d{2}[-./년\s]\d{1,2}|010[-\d\s]{7,}/.test(text)) return 0;
  const amount = numberFromMoney(text);
  if (!Number.isFinite(amount) || Math.abs(amount) < 1000 || Math.abs(amount) > 50000000) return 0;
  return amount;
}

function looseAmountFromCell(value, header = "") {
  const text = normalizeCell(value);
  if (!text || excelSerialDateToIso(value)) return 0;
  const title = normalizeCell(header);
  if (/(일자|날짜|전화|연락|휴대|주소|코드|호차|차량|톤수|착지|순번|순서|중량|수량|건수|위도|경도|lat|lng|gps|savedOrder|sequence|vehicle)/i.test(title)) return 0;
  if (/20\d{2}[-./년\s]\d{1,2}|010[-\d\s]{7,}|^[SB]\d{4,}$/i.test(text)) return 0;
  if (/^\d{1,4}$/.test(text)) return 0;
  const amount = numberFromMoney(text);
  if (!Number.isFinite(amount) || Math.abs(amount) < 1000 || Math.abs(amount) > 50000000) return 0;
  return amount;
}

function amountFromDispatchRow(row) {
  const amountKeys = [
    "amount",
    "dailyAmount",
    "monthlyAmount",
    "salesAmount",
    "totalAmount",
    "saleAmt",
    "orderAmt",
    "totOrderAmt",
    "totalOrderAmt",
    "\uB9E4\uCD9C\uAE08\uC561",
    "\uB9E4\uCD9C\uC561",
    "\uC6D4\uB9E4\uCD9C\uC561",
    "\uC6D4\uB9E4\uCD9C",
    "\uCD1D\uB9E4\uCD9C",
    "\uCD1D\uB9E4\uCD9C\uAE08\uC561",
    "\uC77C\uB9E4\uCD9C",
    "\uC77C\uB9E4\uCD9C\uAE08\uC561",
    "\uCD1D\uC8FC\uBB38\uAE08\uC561",
    "\uCD1D\uC8FC\uBB38\uC561",
    "\uC8FC\uBB38\uAE08\uC561",
    "\uC8FC\uBB38\uC561",
    "\uAE08\uC561",
    "\uCD9C\uACE0\uAE08\uC561",
    "\uD310\uB9E4\uAE08\uC561",
    "\uACF5\uAE09\uAC00\uC561",
    "\uD569\uACC4\uAE08\uC561"
  ];
  for (const key of amountKeys) {
    const direct = numberFromMoney(row?.[key]);
    if (direct) return direct;
  }
  let fallback = 0;
  for (const [key, value] of Object.entries(row || {})) {
    const header = normalizeCell(key);
    if (!/(매출|주문|출고|판매|공급|합계|금액|amount|amt|price)/i.test(header)) continue;
    if (/(기준|한도|비율|율|수량|중량|착지|건수|전화|연락|코드|호차|톤수)/i.test(header)) continue;
    const amount = numberFromMoney(value);
    if (Math.abs(amount) > Math.abs(fallback)) fallback = amount;
  }
  if (fallback) return fallback;
  const rawValues = Array.isArray(row?.__rawValues) ? row.__rawValues : [];
  const rawHeaders = Array.isArray(row?.__headers) ? row.__headers : [];
  for (let index = 0; index < rawValues.length; index += 1) {
    const amount = plausibleAmountFromCell(rawValues[index], rawHeaders[index]);
    if (Math.abs(amount) > Math.abs(fallback)) fallback = amount;
  }
  if (fallback) return fallback;
  for (let index = 0; index < rawValues.length; index += 1) {
    const amount = looseAmountFromCell(rawValues[index], rawHeaders[index]);
    if (Math.abs(amount) > Math.abs(fallback)) fallback = amount;
  }
  return fallback;
}

function dispatchSourceFileDateMatches(row, requestedDate) {
  const date = normalizeDateValue(requestedDate);
  if (!date) return false;
  const source = normalizeCell(row?.sourceFile || row?.fileName || row?.excelFileNm || row?.uploadFileName || "");
  if (!source) return false;
  const parsed = parseDispatchDate(source);
  if (parsed === date) return true;
  const mmddDot = date.slice(5).replace("-", ".");
  const mmddCompact = date.slice(5).replace("-", "");
  const mmddKorean = `${Number(date.slice(5, 7))}월`;
  const dayKorean = `${Number(date.slice(8, 10))}일`;
  return source.includes(date)
    || source.includes(mmddDot)
    || source.includes(mmddCompact)
    || (source.includes(mmddKorean) && source.includes(dayKorean));
}

function dispatchRowDateMatches(row, requestedDate) {
  const date = normalizeDateValue(requestedDate);
  if (!date) return false;
  const rowDate = normalizeDateValue(row.deliveryDate || row.date || row._inferredDeliveryDate);
  return rowDate === date || dispatchSourceFileDateMatches(row, date);
}

function dispatchVehicleMatches(rowVehicle, requestedVehicle) {
  const rowTokens = vehicleTokens(rowVehicle);
  const requestedTokens = vehicleTokens(requestedVehicle);
  for (const token of requestedTokens) {
    if (rowTokens.has(token)) return true;
  }
  return normalizeVehicleValue(rowVehicle) === normalizeVehicleValue(requestedVehicle);
}

function parseDispatchDate(value) {
  const serialDate = excelSerialDateToIso(value);
  if (serialDate) return serialDate;
  const text = normalizeCell(value);
  if (!text) return "";
  const iso = text.match(/(20\d{2})[-./년\s]*(\d{1,2})[-./월\s]*(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  const short = text.match(/(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (short) return `2026-${String(short[1]).padStart(2, "0")}-${String(short[2]).padStart(2, "0")}`;
  return "";
}

function normalizeVehicleValue(value) {
  const text = normalizeCell(value).replace(/\s+/g, "");
  if (!text) return "";
  return text
    .replace(new RegExp("\\uD638\\uCC28$", "u"), "")
    .replace(new RegExp("\\uD638$", "u"), "")
    .replace(new RegExp("\\uBC88$", "u"), "");
}

function vehicleTokens(value) {
  const text = normalizeVehicleValue(value);
  const tokens = new Set();
  if (!text) return tokens;
  tokens.add(text);
  const digitMatch = text.match(/\d{2,4}/);
  if (digitMatch) tokens.add(digitMatch[0]);
  const prefixedMatch = text.match(/[\uC6A9\uCC99]\d{1,4}/u);
  if (prefixedMatch) tokens.add(prefixedMatch[0]);
  return tokens;
}

function rowMatchesDailyRoute(row, date, vehicle) {
  const rowDate = dispatchDateFromRow(row);
  if (!rowDate) return false;
  if (rowDate !== date) return false;
  const selected = vehicleTokens(vehicle);
  if (!selected.size) return false;
  const rowTokens = new Set();
  for (const token of vehicleTokens(dispatchVehicleFromRow(row))) rowTokens.add(token);
  const vehicleColumns = [
    "\uD655\uC815\uD638\uCC28",
    "\uAE30\uC900\uD638\uCC28",
    "\uD638\uCC28",
    "\uCC28\uB7C9",
    "\uCC28\uB7C9\uBC88\uD638",
    "\uBC30\uCC28\uD638\uCC28",
    "\uBC30\uCC28 \uD638\uCC28",
    "\uBC30\uC1A1\uD638\uCC28",
    "\uC6B4\uD589\uD638\uCC28",
    "\uD638\uCC28\uBA85",
    "vehicle",
    "vehicleNo",
    "carSeq",
    "carNm",
    "fixedCarSeq"
  ];
  for (const column of vehicleColumns) {
    for (const token of vehicleTokens(row[column])) rowTokens.add(token);
  }
  for (const [key, value] of Object.entries(row)) {
    const column = normalizeColumnName(key);
    if (column.includes("\uD638\uCC28") || column.includes("\uCC28\uB7C9")) {
      for (const token of vehicleTokens(value)) rowTokens.add(token);
    }
  }
  return [...rowTokens].some((value) => selected.has(value));
}

function deliveryCompletionInfo(row) {
  const status = firstValue(row, ["\uBC30\uC1A1\uC0C1\uD0DC", "\uC0C1\uD0DC", "\uCC98\uB9AC\uC0C1\uD0DC"]);
  const completeFlag = exactColumnValue(row, ["\uBC30\uC1A1\uC644\uB8CC"]);
  const completedAt = firstValue(row, ["\uBC30\uC1A1\uACB0\uACFC\uCC98\uB9AC\uC77C\uC2DC", "\uBC30\uC1A1\uC644\uB8CC\uC77C\uC2DC", "\uBC30\uC1A1\uC644\uB8CC \uC77C\uC2DC", "\uC644\uB8CC\uC77C\uC2DC", "\uC644\uB8CC\uC2DC\uAC04"]);
  const statusText = [status, completeFlag].filter(Boolean).join(" ");
  const appRecorded = statusText.includes("\uBC30\uC1A1\uC644\uB8CC")
    && !statusText.includes("\uBC30\uC1A1\uB204\uB77D")
    && !statusText.includes("\uB9C8\uAC10");
  return {
    status,
    completeFlag,
    deliveryCompletedAt: appRecorded ? completedAt : "",
    rawDeliveryCompletedAt: completedAt,
    appRecorded,
    appUsageGroup: appRecorded ? "\uAE30\uC0AC\uC571 \uC644\uB8CC\uAE30\uB85D" : "\uC571 \uBBF8\uC0AC\uC6A9/\uBBF8\uAE30\uB85D"
  };
}

function isDeliveryHistoryRow(row) {
  return Boolean(firstValue(row, [
    "\uBC30\uC1A1ID",
    "\uBC30\uC1A1\uC0C1\uD0DC",
    "\uBC30\uC1A1\uBC29\uBC95",
    "\uBC30\uC1A1\uC644\uB8CC\uC77C\uC2DC",
    "\uBC30\uCC28\uD655\uC815\uC77C\uC2DC"
  ]));
}

function routeIdentity(row) {
  const code = firstValue(row, ["\uACE0\uAC1D", "\uACE0\uAC1D\uCF54\uB4DC", "\uACE0\uAC1D \uCF54\uB4DC", "\uACE0\uAC1DERP\uCF54\uB4DC", "ERP\uCF54\uB4DC", "\uAC70\uB798\uCC98\uCF54\uB4DC", "\uB9E4\uC7A5\uCF54\uB4DC"]);
  if (code) return `code:${code}`;
  const name = firstValue(row, ["\uACE0\uAC1D\uBA85", "\uB9E4\uC7A5\uBA85", "\uAC70\uB798\uCC98\uBA85", "\uC0C1\uD638"]);
  const address = [
    firstValue(row, ["\uACE0\uAC1D\uC8FC\uC18C", "\uC8FC\uC18C", "\uBC30\uC1A1\uC8FC\uC18C"]),
    firstValue(row, ["\uC0C1\uC138\uC8FC\uC18C", "\uC0C1\uC138\uC8FC\uC18C1", "\uC0C1\uC138"])
  ].filter(Boolean).join(" ").trim();
  return `fallback:${name}|${address}`;
}

function mergeRouteBaseWithHistory(baseRow, historyRow) {
  if (!historyRow) return baseRow;
  const merged = { ...baseRow };
  const alwaysCopy = [
    "\uBC30\uC1A1\uACB0\uACFC\uCC98\uB9AC\uC77C\uC2DC",
    "\uBC30\uC1A1\uC0C1\uD0DC",
    "\uBC30\uC1A1\uBC29\uBC95",
    "\uBC30\uCC28 \uD655\uC815 \uC77C\uC2DC(\uC13C\uD130 \uCD9C\uBC1C \uC2DC\uAC04)",
    "GPS\uC815\uBCF4",
    "\uC2E4\uD328\uC0AC\uC720"
  ];
  for (const [key, value] of Object.entries(historyRow)) {
    if (alwaysCopy.includes(key) || !normalizeCell(merged[key])) {
      merged[key] = value;
    }
  }
  return merged;
}

function buildStopFromDispatchRow(row, vehicle, sequence) {
  const address = dispatchAddressFromRow(row);
  const customerCode = firstValue(row, ["customerCode", "code", "\uACE0\uAC1D", "\uACE0\uAC1D\uCF54\uB4DC", "\uACE0\uAC1D \uCF54\uB4DC", "\uACE0\uAC1DERP\uCF54\uB4DC", "ERP\uCF54\uB4DC", "\uAC70\uB798\uCC98\uCF54\uB4DC", "\uB9E4\uC7A5\uCF54\uB4DC"]);
  const customerName = firstValue(row, ["customerName", "name", "\uACE0\uAC1D\uBA85", "\uB9E4\uC7A5\uBA85", "\uAC70\uB798\uCC98\uBA85", "\uC0C1\uD638"]);
  const amount = amountFromDispatchRow(row) || firstValue(row, ["amount", "dailyAmount", "monthlyAmount", "\uB9E4\uCD9C\uAE08\uC561", "\uB9E4\uCD9C\uC561", "\uC6D4\uB9E4\uCD9C\uC561", "\uC6D4\uB9E4\uCD9C", "\uAE08\uC561", "\uCD9C\uACE0\uAE08\uC561", "\uD310\uB9E4\uAE08\uC561"]);
  const deliveryTime = firstValue(row, ["\uBC30\uC1A1\uC2DC\uAC04", "\uB3C4\uCC29\uC2DC\uAC04", "\uCD9C\uBC1C\uC2DC\uAC04", "\uC785\uACE0\uC2DC\uAC04", "\uC2DC\uAC04"]);
  const completion = deliveryCompletionInfo(row);
  const lat = coordinateFromDispatchRow(row, "lat");
  const lng = coordinateFromDispatchRow(row, "lng");
  return {
    sequence,
    raw: row,
    code: customerCode,
    name: customerName,
    address,
    vehicle: `${vehicle}\uD638`,
    customerCode,
    customerName,
    amount,
    dailyAmount: amount,
    monthlyAmount: amount,
    deliveryTime: completion.deliveryCompletedAt || deliveryTime,
    deliveryCompletedAt: completion.deliveryCompletedAt,
    rawDeliveryCompletedAt: completion.rawDeliveryCompletedAt,
    deliveryStatus: completion.status || completion.completeFlag,
    appRecorded: completion.appRecorded,
    appUsageGroup: completion.appUsageGroup,
    routeOrder: firstValue(row, ["\uBC30\uC1A1\uC21C\uBC88", "\uC21C\uBC88", "\uC21C\uC11C", "\uBC30\uC1A1\uC21C\uC11C"]),
    orderCount: firstValue(row, ["\uBC30\uC1A1\uAC74\uC218", "\uC8FC\uBB38\uC218", "\uAC74\uC218"]),
    weight: firstValue(row, ["\uC911\uB7C9", "\uBB34\uAC8C"]),
    cbm: firstValue(row, ["CBM", "cbm"])
  };
}

function routeSortValue(row, fallbackIndex) {
  const completion = deliveryCompletionInfo(row);
  const completedAtMatch = normalizeCell(completion.deliveryCompletedAt).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (completedAtMatch) {
    return Number(completedAtMatch[1]) * 3600 + Number(completedAtMatch[2]) * 60 + Number(completedAtMatch[3] || 0);
  }

  const orderText = firstValue(row, ["\uBC30\uC1A1\uC21C\uBC88", "\uC21C\uBC88", "\uC21C\uC11C", "\uBC30\uC1A1\uC21C\uC11C"]);
  const orderMatch = normalizeCell(orderText).match(/\d+/);
  if (orderMatch) return Number(orderMatch[0]);

  const timeText = firstValue(row, ["\uBC30\uC1A1\uC2DC\uAC04", "\uB3C4\uCC29\uC2DC\uAC04", "\uCD9C\uBC1C\uC2DC\uAC04", "\uC785\uACE0\uC2DC\uAC04", "\uC2DC\uAC04"]);
  const timeMatch = normalizeCell(timeText).match(/(\d{1,2})\D?(\d{2})?/);
  if (timeMatch) return Number(timeMatch[1]) * 100 + Number(timeMatch[2] || 0);

  return 100000 + fallbackIndex;
}

async function buildDailyRouteFromUploadedDispatch({ date, vehicle, center = "" }) {
  const cache = await readDispatchCacheLocalOnly();
  if (!cache?.rows?.length) return null;
  const generatedAt = cache.generatedAt || new Date().toISOString();
  const requestedDate = normalizeDateValue(date);
  const requestedVehicle = normalizeVehicleValue(vehicle);
  const matchedItems = (cache.rows || [])
    .map((row, index) => ({ row: normalizeDispatchRowForSheet(row, index, generatedAt), index }))
    .filter((item) => dispatchRowDateMatches(item.row, requestedDate) && dispatchVehicleMatches(item.row.vehicle, requestedVehicle));
  const deliveryItems = matchedItems.filter((item) => isDeliveryHistoryRow(item.row));
  const baseItems = matchedItems.filter((item) => !isDeliveryHistoryRow(item.row));
  const historyByKey = new Map();
  for (const item of deliveryItems) {
    historyByKey.set(routeIdentity(item.row), item.row);
  }
  const routeItems = (baseItems.length ? baseItems : matchedItems)
    .map((item) => ({
      ...item,
      row: baseItems.length ? mergeRouteBaseWithHistory(item.row, historyByKey.get(routeIdentity(item.row))) : item.row
    }))
    .sort((left, right) => routeSortValue(left.row, left.index) - routeSortValue(right.row, right.index))
  const rows = dedupeDispatchSheetRows(routeItems.map((item) => item.row))
    .sort((left, right) => routeSortValue(left, 0) - routeSortValue(right, 0));
  if (!rows.length) return null;
  const appRecordedCount = rows.filter((row) => deliveryCompletionInfo(row).appRecorded).length;
  const appMissingCount = rows.length - appRecordedCount;
  const source = baseItems.length && deliveryItems.length
    ? "uploaded-fixed-dispatch-with-delivery-history"
    : deliveryItems.length
      ? "uploaded-delivery-history"
      : "uploaded-fixed-dispatch";
  const monthKey = monthKeyFromDate(date);
  const payloadSource = cache.source === "google-sheet" ? "google-sheet" : "monthly-dispatch-cache";
  return {
    generatedAt: new Date().toISOString(),
    source: payloadSource,
    originalSource: source,
    cacheGeneratedFrom: cache.generatedAt || null,
    cacheHit: true,
    cacheType: "monthly-dispatch",
    monthKey,
    dateBasis: "배송날짜",
    warning: baseItems.length && deliveryItems.length
      ? "Uploaded fixed-dispatch rows were used as the route base, and delivery-history rows were merged only for app completion records."
      : deliveryItems.length
        ? "Uploaded delivery-history Excel data was used because no fixed-dispatch route base rows matched this date and vehicle."
        : payloadSource === "google-sheet" ? "Google Sheets monthly data was used for this daily route." : "Uploaded fixed-dispatch Excel monthly data was used for this daily route.",
    date,
    vehicle,
    center,
    rowCount: rows.length,
    appRecordedCount,
    appMissingCount,
    stops: rows.map((row, index) => buildStopFromDispatchRow(row, vehicle, index + 1))
  };
}

function deliveryRecordVehicle(record) {
  return normalizeVehicleValue(
    record.fixedNo
    || record.fixed_no
    || record.fixedNumber
    || record.vehicle
    || record.vehicleNo
    || record.carrierNo
    || record.carrierName
    || ""
  );
}

function extractPoint(value) {
  if (!value || typeof value !== "object") return {};
  const candidates = [
    value,
    value.location,
    value.coordinate,
    value.coord,
    value.point,
    value.position,
    value.address
  ].filter(Boolean);
  for (const item of candidates) {
    const lat = Number(item.lat ?? item.latitude ?? item.y ?? item.wgs84Y);
    const lng = Number(item.lng ?? item.lon ?? item.longitude ?? item.x ?? item.wgs84X);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return {};
}

function deliveryStopText(value, keys) {
  for (const key of keys) {
    const text = normalizeCell(value?.[key]);
    if (text) return text;
  }
  return "";
}

function buildStopFromDeliveryAdminPoint(point, vehicle, sequence) {
  const nestedCustomer = point.customer || point.store || point.destination || point.place || {};
  const nestedCarrier = point.carrier || {};
  const coords = extractPoint(point);
  const customerCode = deliveryStopText(point, ["customerCode", "customerCd", "estCd", "code", "id"])
    || deliveryStopText(nestedCustomer, ["customerCode", "customerCd", "estCd", "code", "id"]);
  const customerName = deliveryStopText(point, ["customerName", "customerNm", "estNm", "name", "storeName", "title"])
    || deliveryStopText(nestedCustomer, ["customerName", "customerNm", "estNm", "name", "storeName", "title"]);
  const address = deliveryStopText(point, ["address", "addr", "roadAddress", "destinationAddress"])
    || deliveryStopText(nestedCustomer, ["address", "addr", "roadAddress", "destinationAddress"]);
  const deliveryTime = deliveryStopText(point, ["completedAt", "deliveryCompletedAt", "arrivedAt", "arrivalTime", "startedAt", "time"]);
  const vehicleName = deliveryStopText(point, ["fixedNo", "vehicle", "vehicleNo", "carrierNo"])
    || deliveryStopText(nestedCarrier, ["fixedNo", "vehicle", "vehicleNo", "carrierNo"])
    || vehicle;
  return {
    sequence,
    raw: point,
    code: customerCode,
    name: customerName,
    address,
    lat,
    lng,
    vehicle: `${normalizeVehicleValue(vehicleName) || vehicle}\uD638`,
    customerCode,
    customerName,
    amount: deliveryStopText(point, ["amount", "salesAmount", "cost", "price"]),
    dailyAmount: deliveryStopText(point, ["amount", "salesAmount", "cost", "price"]),
    monthlyAmount: "",
    deliveryTime,
    deliveryCompletedAt: deliveryTime,
    rawDeliveryCompletedAt: deliveryTime,
    deliveryStatus: deliveryStopText(point, ["status", "deliveryStatus", "state"]),
    appRecorded: Boolean(deliveryTime),
    appUsageGroup: deliveryTime ? "\uB51C\uB9AC\uBC84\uB9AC \uC5B4\uB4DC\uBBFC \uC870\uD68C" : "\uC870\uD68C\uB41C \uB3D9\uC120",
    routeOrder: deliveryStopText(point, ["order", "sequence", "seq", "sort"]),
    orderCount: "",
    weight: deliveryStopText(point, ["weight", "weightKg"]),
    cbm: deliveryStopText(point, ["cbm", "CBM"]),
    ...coords
  };
}

function extractDeliveryRouteStops(detailPayload) {
  const result = detailPayload?.resultB || detailPayload?.data?.resultB || detailPayload?.resultA || detailPayload?.data?.resultA || detailPayload;
  const costs = asArray(result?.costs || result?.data?.costs);
  const costStops = costs
    .map((cost) => asArray(cost?.route)[0])
    .filter(Boolean);
  if (costStops.length) return costStops;
  const route = asArray(result?.route || result?.routes || result?.items || result?.stops);
  if (route.length) return route;
  return findArrayDeep(detailPayload, (item) => {
    if (!item || typeof item !== "object") return false;
    return Boolean(
      item.customerName || item.customerNm || item.estNm || item.storeName || item.address || item.addr || extractPoint(item).lat
    );
  }) || [];
}

function taskRowNested(row) {
  return {
    carrier: row?.carrier || row?.carrierInfo || row?.driver || {},
    customer: row?.customer || row?.customerInfo || row?.store || row?.franchise || {},
    order: row?.order || row?.orderInfo || {},
    center: row?.logisticsCenter || row?.logisticsCenterInfo || row?.center || {}
  };
}

function deliveryTaskVehicle(row) {
  const nested = taskRowNested(row);
  return normalizeVehicleValue(
    row?.fixedNo
    || row?.fixed_no
    || row?.fixedNumber
    || row?.fixedVehicleNo
    || row?.carrierNo
    || row?.vehicleNo
    || row?.vehicle
    || nested.carrier.fixedNo
    || nested.carrier.fixed_no
    || nested.carrier.fixedNumber
    || nested.carrier.carrierNo
    || nested.carrier.vehicleNo
    || nested.carrier.name
    || ""
  );
}

function deliveryTaskStatus(row) {
  const nested = taskRowNested(row);
  const status = deliveryStopText(row, ["taskStatus", "deliveryStatus", "status", "statusText", "taskStatusText", "deliveryStatusText"])
    || deliveryStopText(nested.order, ["taskStatus", "deliveryStatus", "status", "statusText"]);
  const upper = status.toUpperCase();
  const completedAt = deliveryStopText(row, [
    "completedAt",
    "deliveryCompletedAt",
    "deliveryCompleteAt",
    "taskCompletedAt",
    "deliveredAt",
    "completedDatedAt",
    "deliveryCompletedDatedAt"
  ]);
  const appRecorded = Boolean(completedAt)
    || upper === "COMPLETED"
    || status.includes("\uBC30\uC1A1\uC644\uB8CC");
  return { status, completedAt, appRecorded };
}

function deliveryTaskSortValue(row, fallbackIndex) {
  const status = deliveryTaskStatus(row);
  const timeText = status.completedAt
    || deliveryStopText(row, ["deliveryCompletedAt", "completedAt", "fixedAt", "carrierConfirmedAt", "updatedAt", "createdAt"]);
  const timeMatch = normalizeCell(timeText).match(/(?:T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/)
    || normalizeCell(timeText).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    return Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3] || 0);
  }

  const orderText = deliveryStopText(row, ["sequence", "seq", "sort", "sortNo", "routeOrder", "deliverySequence"]);
  const orderMatch = normalizeCell(orderText).match(/\d+/);
  if (orderMatch) return Number(orderMatch[0]);

  return 100000 + fallbackIndex;
}

function buildStopFromDeliveryTaskRow(row, vehicle, sequence) {
  const nested = taskRowNested(row);
  const customerCode = deliveryStopText(row, ["customerErpCode", "customerERPCode", "customerCode", "customerCd", "erpCode", "erpCd"])
    || deliveryStopText(nested.customer, ["erpCode", "erpCd", "customerErpCode", "customerCode", "code"]);
  const customerName = deliveryStopText(row, ["customerName", "customerNm", "storeName", "name"])
    || deliveryStopText(nested.customer, ["name", "customerName", "customerNm", "storeName"]);
  const address = [
    deliveryStopText(row, ["address", "customerAddress", "roadAddress", "jibunAddress", "addr"])
      || deliveryStopText(nested.customer, ["address", "roadAddress", "jibunAddress", "addr"]),
    deliveryStopText(row, ["addressDetail", "detailAddress", "customerAddressDetail"])
      || deliveryStopText(nested.customer, ["addressDetail", "detailAddress"])
  ].filter(Boolean).join(" ").trim();
  const amount = deliveryStopText(row, ["salesAmount", "amount", "sales", "price", "totalAmount"])
    || deliveryStopText(nested.order, ["salesAmount", "amount", "price", "totalAmount"]);
  const status = deliveryTaskStatus(row);
  const vehicleName = deliveryTaskVehicle(row) || vehicle;
  const coords = extractPoint(row);
  return {
    sequence,
    raw: row,
    code: customerCode,
    name: customerName,
    address,
    vehicle: `${normalizeVehicleValue(vehicleName) || vehicle}\uD638`,
    customerCode,
    customerName,
    amount,
    dailyAmount: amount,
    monthlyAmount: amount,
    deliveryTime: status.completedAt,
    deliveryCompletedAt: status.completedAt,
    rawDeliveryCompletedAt: status.completedAt,
    deliveryStatus: status.status,
    appRecorded: status.appRecorded,
    appUsageGroup: status.appRecorded ? "\uB51C\uB9AC\uBC84\uB9AC \uC5B4\uB4DC\uBBFC \uBC30\uC1A1\uC644\uB8CC" : "\uB51C\uB9AC\uBC84\uB9AC \uC5B4\uB4DC\uBBFC \uC870\uD68C",
    routeOrder: deliveryStopText(row, ["sequence", "seq", "sort", "sortNo", "routeOrder", "deliverySequence"]),
    orderCount: deliveryStopText(row, ["shipmentCount", "orderCount", "deliveryCount", "count"]),
    weight: deliveryStopText(row, ["weight", "weightKg", "totalWeight"]),
    cbm: deliveryStopText(row, ["cbm", "CBM", "totalCbm"]),
    ...coords
  };
}

function extractDeliveryTaskRows(payload) {
  if (Array.isArray(payload)) return payload;
  const direct = payload?.data?.content
    || payload?.data?.items
    || payload?.data?.list
    || payload?.data?.rows
    || payload?.content
    || payload?.items
    || payload?.list
    || payload?.rows;
  if (Array.isArray(direct)) return direct;
  return findArrayDeep(payload, (item) => {
    if (!item || typeof item !== "object") return false;
    return Boolean(
      deliveryTaskVehicle(item)
      || item.customerName
      || item.customerErpCode
      || item.deliveryId
      || item.taskId
    );
  }) || [];
}

async function fetchDeliveryTaskRows({ date, vehicle }) {
  const selectedTokens = vehicleTokens(vehicle);
  const variants = [
    { fromDatedAt: date, toDatedAt: date, searchOption: "FIXED_NO", searchValue: vehicle },
    { fromDatedAt: date, toDatedAt: date, searchType: "FIXED_NO", searchKeyword: vehicle },
    { fromDatedAt: date, toDatedAt: date, fixedNo: vehicle },
    { startDatedAt: date, endDatedAt: date, searchOption: "FIXED_NO", searchValue: vehicle },
    { "enteringDatedAtBetween[0]": date, "enteringDatedAtBetween[1]": date, searchOption: "FIXED_NO", searchValue: vehicle },
    { "enteringDatedAtBetween[0]": date, "enteringDatedAtBetween[1]": date, fixedNo: vehicle },
    { enteringDatedAt: date, searchOption: "FIXED_NO", searchValue: vehicle },
    { enteringDatedAt: date, fixedNo: vehicle },
    { fromDatedAt: date, toDatedAt: date },
    { enteringDatedAtBetween: [date, date] }
  ];

  let lastRows = [];
  const errors = [];
  for (const query of variants) {
    let payload;
    try {
      payload = await deliveryAdminJson(`/api/bali/task/all?${deliveryApiQuery(query)}`, { method: "GET" });
    } catch (error) {
      errors.push(error.message || String(error));
      continue;
    }
    const rows = extractDeliveryTaskRows(payload);
    const matched = rows.filter((row) => {
      const tokens = vehicleTokens(deliveryTaskVehicle(row));
      return [...tokens].some((token) => selectedTokens.has(token));
    });
    if (matched.length) return matched;
    if (rows.length) lastRows = rows;
  }

  if (lastRows.length) {
    return lastRows.filter((row) => {
      const tokens = vehicleTokens(deliveryTaskVehicle(row));
      return [...tokens].some((token) => selectedTokens.has(token));
    });
  }
  if (errors.length && !lastRows.length) {
    const error = new Error(`Delivery admin task lookup failed. ${errors[0]}`);
    error.status = 502;
    throw error;
  }
  return [];
}

async function buildDailyRouteFromDeliveryAdmin({ date, vehicle, center = "" }) {
  if ((!config.deliveryAdminId || !config.deliveryAdminPassword) && !config.deliveryAdminCookie) return null;

  const rows = await fetchDeliveryTaskRows({ date, vehicle });
  if (!rows.length) {
    const error = new Error(`Delivery admin task rows were not found for ${date} ${vehicle}.`);
    error.status = 404;
    throw error;
  }

  const sortedRows = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => deliveryTaskSortValue(left.row, left.index) - deliveryTaskSortValue(right.row, right.index))
    .map((item) => item.row);
  const stops = sortedRows
    .map((row, index) => buildStopFromDeliveryTaskRow(row, vehicle, index + 1))
    .filter((stop) => stop.name || stop.address || (Number.isFinite(stop.lat) && Number.isFinite(stop.lng)));
  if (!stops.length) {
    const error = new Error("Delivery admin returned task rows, but no usable stop rows were found.");
    error.status = 404;
    throw error;
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "delivery-admin-live",
    warning: "Delivery admin task/all data was used from the task lookup screen. No browser automation was started.",
    date,
    vehicle,
    center,
    rowCount: stops.length,
    appRecordedCount: stops.filter((stop) => stop.appRecorded).length,
    appMissingCount: stops.filter((stop) => !stop.appRecorded).length,
    stops
  };
}

async function freshonFetch(pathname, options = {}) {
  const origin = new URL(config.freshonBaseUrl).origin;
  const url = pathname.startsWith("http") ? pathname : `${origin}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
  const { timeoutMs = 12000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: fetchOptions.signal || controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "freshon-admin-daily-route/1.0",
        Origin: origin,
        Referer: `${origin}/bo/main#/bo/wm/dispatch/dailyDsptcPage`,
        ...(config.freshonCookie ? { Cookie: config.freshonCookie } : {}),
        ...(fetchOptions.headers || {})
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Freshon request timed out after ${Math.round(timeoutMs / 1000)}s (${pathname})`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readFreshonJson(pathname, options = {}) {
  const response = await freshonFetch(pathname, options);
  const text = await response.text();
  const preview = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (parseError) {
    payload = { raw: text };
    const looksHtml = /<!doctype|<html|<body|login|로그인|j_username|password/i.test(text || "");
    const error = new Error(
      looksHtml
        ? "Freshon returned an HTML/login page instead of JSON. The browser session cookie is likely expired or not accepted."
        : "Freshon returned a non-JSON response."
    );
    error.status = looksHtml ? 401 : 502;
    error.payload = payload;
    error.diagnostic = {
      type: looksHtml ? "html-or-login-response" : "json-parse-error",
      pathname,
      status: response.status,
      statusText: response.statusText,
      contentType,
      responsePreview: preview,
      parserMessage: parseError.message
    };
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Freshon HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    error.diagnostic = {
      type: "http-error",
      pathname,
      status: response.status,
      statusText: response.statusText,
      contentType,
      responsePreview: preview,
      payloadKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : []
    };
    throw error;
  }
  return payload;
}

function freshonAttemptDiagnostic({ endpoint, variant, result, payload, rows, matched, stops, error }) {
  const base = {
    endpoint,
    variant: variant?.label || "",
    method: variant?.options?.method || "GET",
    result
  };
  if (error) {
    const diagnostic = error.diagnostic || {};
    return {
      ...base,
      result: "error",
      type: diagnostic.type || "request-error",
      status: error.status || diagnostic.status || null,
      statusText: diagnostic.statusText || "",
      contentType: diagnostic.contentType || "",
      message: error.message || String(error),
      responsePreview: diagnostic.responsePreview || "",
      parserMessage: diagnostic.parserMessage || ""
    };
  }
  const firstRow = Array.isArray(rows) && rows.length ? rows[0] : null;
  return {
    ...base,
    rowCount: Array.isArray(rows) ? rows.length : 0,
    matchedCount: Array.isArray(matched) ? matched.length : 0,
    stopCount: Array.isArray(stops) ? stops.length : 0,
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
    sampleRowKeys: firstRow && typeof firstRow === "object" ? Object.keys(firstRow).slice(0, 20) : []
  };
}

async function buildDailyRouteFromFreshonLogin({ date, vehicle, center = "" }) {
  if (!config.freshonId || !config.freshonPassword) {
    const error = new Error("FRESHON_ID and FRESHON_PASSWORD are not configured for automatic Freshon login.");
    error.status = 401;
    error.diagnostics = {
      type: "missing-freshon-credentials",
      date,
      vehicle,
      center,
      hasId: Boolean(config.freshonId),
      hasPassword: Boolean(config.freshonPassword)
    };
    throw error;
  }
  const timeoutMs = 65000;
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      const error = new Error(`Freshon ID/PW automatic login timed out after ${Math.round(timeoutMs / 1000)}s.`);
      error.status = 504;
      error.diagnostics = {
        type: "freshon-id-password-timeout",
        date,
        vehicle,
        center,
        timeoutMs,
        hasId: Boolean(config.freshonId),
        hasPassword: Boolean(config.freshonPassword)
      };
      reject(error);
    }, timeoutMs);
  });
  try {
    const { refreshDailyRouteData } = await import("./scraper/freshonDailyRoute.js");
    const result = await Promise.race([
      refreshDailyRouteData({ date, vehicle, center, forceLogin: true }),
      timeout
    ]);
    return {
      ...result,
      source: result?.source || "freshon-id-password-login",
      warning: "Freshon ID/PW automatic login was used because cookie lookup failed or was unavailable."
    };
  } catch (error) {
    const rawMessage = error.message || String(error);
    const noRows = /dailyDsptcPage API returned no rows|:no rows/i.test(rawMessage);
    const wrapped = new Error(noRows
      ? `Freshon daily dispatch returned no rows for the selected date/vehicle. ${rawMessage}`
      : `Freshon ID/PW automatic login failed. ${rawMessage}`);
    wrapped.status = /Cannot find package 'playwright'|ERR_MODULE_NOT_FOUND/i.test(String(error.message || ""))
      ? 500
      : (error.status || 502);
    wrapped.diagnostics = {
      type: "freshon-id-password-login",
      date,
      vehicle,
      center,
      hasId: Boolean(config.freshonId),
      hasPassword: Boolean(config.freshonPassword),
      message: error.message || String(error)
    };
    throw wrapped;
  }
}

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setDate(parsed.getDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function compactDate(date) {
  return String(date || "").replace(/\D/g, "");
}

function freshonDailyRouteForm({ date, vehicle, center = "", page = 0, inDate = date, shipGbn = "1", logCd = "011", vehicleFilter = vehicle }) {
  const centerText = center || "";
  const carValue = vehicleFilter || "";
  return {
    page: String(page),
    isPaging: "false",
    isCount: "true",
    size: "100",
    sort: ",ASC",
    excelFileNm: `일일배차 내역_${compactDate(date)}`,
    sqlType: "LOTSIM003_P01",
    logCd,
    inDate,
    closeTrans: "2",
    shipGbn,
    logCdNm: centerText,
    logisticsCenter: centerText,
    logisticsCenterNm: centerText,
    whCd: "",
    centerCd: "",
    baecha: centerText,
    startDate: date,
    endDate: date,
    inReqDate: date,
    enteringDate: date,
    reqDate: date,
    dlvyReqDate: inDate,
    carSeq: carValue,
    carSeqNm: carValue,
    carCd: carValue,
    carNm: carValue,
    carNo: carValue,
    fixedCarSeq: carValue,
    fixedCarSeqNm: carValue,
    shipGbnNm: shipGbn === "1" ? "night" : "",
    estCd: "",
    estName: "",
    tcYn: "",
    tcGbn: ""
  };
}

function freshonDailyRouteRequestVariants({ date, vehicle, center = "", page = 0 }) {
  const baseVariants = [...new Set([date, addDays(date, 1)].filter(Boolean))]
    .flatMap((inDate) => [
      { inDate, shipGbn: "", logCd: "011" },
      { inDate, shipGbn: "1", logCd: "011" },
      { inDate, shipGbn: "", logCd: "" },
      { inDate, shipGbn: "1", logCd: "" }
    ])
    .flatMap((base) => [
      { ...base, vehicleFilter: vehicle },
      { ...base, vehicleFilter: "" }
    ]);
  return baseVariants.flatMap((base) => {
    const form = freshonDailyRouteForm({ date, vehicle, center, page, ...base });
    const params = new URLSearchParams(form);
    const carLabel = base.vehicleFilter ? "car" : "allcar";
    return [
      {
        label: `form:${base.inDate}:ship${base.shipGbn || "all"}:log${base.logCd || "all"}:${carLabel}`,
        options: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          timeoutMs: 10000,
          body: params.toString()
        }
      },
      {
        label: `json:${base.inDate}:ship${base.shipGbn || "all"}:log${base.logCd || "all"}:${carLabel}`,
        options: {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8" },
          timeoutMs: 15000,
          body: JSON.stringify(form)
        }
      }
    ];
  });
}

function extractFreshonRows(payload) {
  const isFreshonCustomerRow = (item) => {
    if (!item || typeof item !== "object") return false;
    const hasPagingOnlyKeys = item.totalCnt != null || item.totalPages != null || item.isPaging != null || item.sortName != null;
    const hasCustomer = item.estCd || item.estNm || item.customerCode || item.customerName || item.custCd || item.custNm || item.custErpCd || item.dlvyPlaceNm;
    const hasAddress = item.addr || item.address || item.customerAddress || item.roadAddress || item.baseAddr || item.dlvyAddr || item.deliveryAddress || item.shipAddr;
    const hasVehicle = item.confirmCarSeq || item.confirmedCarSeq || item.fixedCarSeq || item.baseCarSeq || item.changeCarSeq || item.carSeq || item.carSeqNm || item.carCd || item.carNm || item.carNo || item.hocha || item.vehicle;
    return Boolean(hasCustomer || hasAddress || hasVehicle) && !hasPagingOnlyKeys;
  };
  if (Array.isArray(payload)) return payload.filter(isFreshonCustomerRow);
  const direct = payload?.data?.content
    || payload?.data?.items
    || payload?.data?.list
    || payload?.data?.rows
    || payload?.data
    || payload?.content
    || payload?.items
    || payload?.list
    || payload?.rows;
  if (Array.isArray(direct)) return direct.filter(isFreshonCustomerRow);
  return findArrayDeep(payload, isFreshonCustomerRow) || [];
}

function freshonRowVehicle(row) {
  return normalizeVehicleValue(
    row.confirmCarSeq
    || row.confirmedCarSeq
    || row.fixedCarSeq
    || row.baseCarSeq
    || row.changeCarSeq
    || row.carSeq
    || row.carSeqNm
    || row.carCd
    || row.carNm
    || row.carNo
    || row.hocha
    || row.vehicle
    || ""
  );
}

function buildStopFromFreshonDailyRow(row, vehicle, sequence) {
  const customerCode = deliveryStopText(row, ["estCd", "customerCode", "custCd", "erpCode", "customerErpCode", "custCode", "custErpCd"]);
  const customerName = deliveryStopText(row, ["estNm", "estName", "customerName", "custNm", "customerNm", "custName", "storeName", "dlvyPlaceNm", "deliveryPlaceName"]);
  const amount = deliveryStopText(row, ["totalOrderAmt", "totOrderAmt", "orderAmt", "saleAmt", "salesAmount", "amt", "totalAmount", "daySaleAmt"]);
  const weight = deliveryStopText(row, ["weight", "weightKg", "totalWeight"]);
  const cbm = deliveryStopText(row, ["cbm", "CBM"]);
  const address = [
    deliveryStopText(row, ["addr", "address", "customerAddress", "roadAddress", "baseAddr", "dlvyAddr", "deliveryAddress", "shipAddr"]),
    deliveryStopText(row, ["addrDtl", "addressDetail", "detailAddress", "dtlAddr", "dlvyAddrDtl", "deliveryAddressDetail", "shipAddrDtl"])
  ].filter(Boolean).join(" ").trim();
  return {
    sequence,
    raw: row,
    code: customerCode,
    name: customerName,
    address,
    vehicle: `${vehicle}\uD638`,
    customerCode,
    customerName,
    amount,
    dailyAmount: amount,
    monthlyAmount: amount,
    ton: deliveryStopText(row, ["carTonNm", "carTon", "ton", "tonnage"]),
    driverName: deliveryStopText(row, ["driverName", "driverNm", "기사명"]),
    deliveryTime: "",
    deliveryCompletedAt: "",
    rawDeliveryCompletedAt: "",
    deliveryStatus: "Freshon daily dispatch",
    appRecorded: false,
    appUsageGroup: "Freshon daily dispatch lookup",
    routeOrder: deliveryStopText(row, ["seq", "sequence", "sort", "rownum", "No"]),
    orderCount: deliveryStopText(row, ["deliveryCount", "orderCount", "count", "customerCount"]),
    weight,
    cbm
  };
}

function freshonRowMatchesVehicleCustomer(row, vehicleData) {
  if (!vehicleData?.customers?.length) return false;
  const stop = buildStopFromFreshonDailyRow(row, vehicleData.vehicle, 1);
  const key = String(stop.customerCode || stop.code || "").trim();
  const name = String(stop.customerName || stop.name || "").replace(/\s+/g, "");
  const address = String(stop.address || "").replace(/\s+/g, "");
  return vehicleData.customers.some((customer) => {
    const customerId = String(customer.id || "").trim();
    const customerName = String(customer.name || "").replace(/\s+/g, "");
    const customerAddress = String(customer.address || "").replace(/\s+/g, "");
    return (key && customerId === key)
      || (name && customerName && (customerName === name || customerName.includes(name) || name.includes(customerName)))
      || (address && customerAddress && (customerAddress.includes(address) || address.includes(customerAddress)));
  });
}

async function buildDailyRouteFromFreshon({ date, vehicle, center = "" }) {
  if (!config.freshonCookie) {
    const error = new Error("FRESHON_COOKIE is not configured. Freshon direct lookup needs the browser session cookie.");
    error.status = 401;
    error.diagnostics = {
      type: "missing-cookie",
      date,
      vehicle,
      center,
      hasCookie: false,
      attempts: []
    };
    throw error;
  }
  const selected = vehicleTokens(vehicle);
  const vehicleAreaData = await readVehicleAreaData().catch(() => null);
  const vehicleData = (vehicleAreaData?.vehicles || []).find((item) => String(item.vehicle) === String(vehicle));
  const endpoints = [
    "/bo/wm/dispatch/dailyDsptcGridList",
    "/bo/wm/dispatch/dailyDsptcGrid1List",
    "/bo/wm/dispatch/dailyDsptcGrid2List",
    "/bo/wm/dispatch/dailyDsptcGrid3List",
    "/bo/wm/dispatch/dailyDsptcGrid4List",
    "/bo/wm/dispatch/dailyDsptcGrid1/list",
    "/bo/wm/dispatch/dailyDsptcGrid1",
    "/bo/wm/dispatch/LOTMTR005_list",
    "/bo/wm/dispatch/LOTMTR005/list",
    "/bo/wm/dispatch/LOTMTR005",
    "/bo/wm/dispatch/dispatchStatusList",
    "/bo/wm/dispatch/alctnStatusList",
    "/bo/wm/dispatch/dailyDsptcList",
    "/bo/wm/dispatch/dailyDsptc/list",
    "/bo/wm/dispatch/dailyDsptcPage/list",
    "/bo/wm/dispatch/selectDailyDsptcList",
    "/bo/wm/dispatch/dailyDispatchList"
  ];
  const diagnostics = [];
  for (const endpoint of endpoints) {
    for (const variant of freshonDailyRouteRequestVariants({ date, vehicle, center })) {
      try {
        const payload = await readFreshonJson(`${endpoint}${variant.suffix || ""}`, variant.options);
        const rows = extractFreshonRows(payload);
        const matched = rows.filter((row) => {
          const tokens = vehicleTokens(freshonRowVehicle(row));
          if (tokens.size) return [...tokens].some((token) => selected.has(token));
          return freshonRowMatchesVehicleCustomer(row, vehicleData);
        });
        if (!matched.length) {
          diagnostics.push(freshonAttemptDiagnostic({ endpoint, variant, result: "no-vehicle-match", payload, rows, matched }));
          continue;
        }
        const stops = matched
          .map((row, index) => buildStopFromFreshonDailyRow(row, vehicle, index + 1))
          .filter((stop) => stop.customerCode || stop.customerName || stop.address);
        if (!stops.length) {
          diagnostics.push(freshonAttemptDiagnostic({ endpoint, variant, result: "matched-without-stop-fields", payload, rows, matched, stops }));
          continue;
        }
        return {
          generatedAt: new Date().toISOString(),
          source: "freshon-daily-dispatch-api",
          warning: "Freshon daily dispatch management data was used. Coordinates are matched against the operating-map customer cache.",
          date,
          vehicle,
          center,
          rowCount: stops.length,
          appRecordedCount: 0,
          appMissingCount: stops.length,
          stops
        };
      } catch (error) {
        const diagnostic = freshonAttemptDiagnostic({ endpoint, variant, result: "error", error });
        diagnostics.push(diagnostic);
        if (Number(error.status || diagnostic.status) === 401 || diagnostic.type === "html-or-login-response") {
          const authError = new Error(error.message || "Freshon cookie lookup was rejected.");
          authError.status = 401;
          authError.diagnostics = {
            type: "freshon-cookie-auth-rejected",
            date,
            vehicle,
            center,
            hasCookie: true,
            attemptCount: diagnostics.length,
            attempts: diagnostics.slice(0, 8)
          };
          throw authError;
        }
      }
    }
  }
  const preferredError = diagnostics.find((item) => item.result === "error" && !String(item.message || "").includes("timed out after"))
    || diagnostics.find((item) => item.result === "error")
    || diagnostics[0];
  const detail = preferredError?.message || preferredError?.result || "No matching rows returned.";
  const error = new Error(`Freshon daily dispatch lookup failed. Current guessed dailyDsptcPage API did not return route rows. ${detail}`);
  error.status = preferredError?.status || 502;
  error.diagnostics = {
    type: "freshon-daily-route",
    date,
    vehicle,
    center,
    hasCookie: true,
    attemptCount: diagnostics.length,
    attempts: diagnostics.slice(0, 48)
  };
  throw error;
}

function dateRangeList(startDate, endDate) {
  const start = normalizeDateValue(startDate);
  const end = normalizeDateValue(endDate);
  if (!start || !end) throw new Error("startDate and endDate are required.");
  const dates = [];
  let cursor = start;
  for (let guard = 0; guard < 370 && cursor <= end; guard += 1) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function normalizeFreshonCookie(value) {
  const text = normalizeCell(value);
  if (!text) return "";
  return text.includes("=") ? text : `F_IDF=${text}`;
}

async function fetchFreshonRowsForDate(date, cookie = "") {
  const endpoints = [
    "/bo/wm/dispatch/dailyDsptcGrid1List",
    "/bo/wm/dispatch/dailyDsptcGridList",
    "/bo/wm/dispatch/dailyDsptcGrid2List",
    "/bo/wm/dispatch/dailyDsptcGrid3List",
    config.freshonFixedDispatchApiUrl || ""
  ].filter(Boolean);
  const attempts = [];
  for (const endpoint of endpoints) {
    const form = freshonDailyRouteForm({ date, vehicle: "", inDate: date, shipGbn: "2", logCd: "011", vehicleFilter: "" });
    for (const variant of [
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(form).toString() },
      { method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(form) }
    ]) {
      try {
        const payload = await readFreshonJson(endpoint, { ...variant, timeoutMs: 20000 });
        const rows = extractFreshonRows(payload);
        attempts.push(`${endpoint}:${rows.length}`);
        if (rows.length) return { rows, endpoint, attempts };
      } catch (error) {
        attempts.push(`${endpoint}:${error.status || "ERR"}`);
      }
    }
  }
  return { rows: [], endpoint: "", attempts };
}

function freshonRowsToDispatchRows(rows, date, generatedAt) {
  return rows.map((row, index) => {
    const vehicle = freshonRowVehicle(row);
    const stop = buildStopFromFreshonDailyRow(row, vehicle, index + 1);
    return {
      deliveryDate: date,
      vehicle,
      sequence: stop.routeOrder || stop.sequence || index + 1,
      customerCode: stop.customerCode || stop.code,
      customerName: stop.customerName || stop.name,
      address: stop.address,
      amount: stop.amount,
      dailyAmount: stop.dailyAmount || stop.amount,
      monthlyAmount: stop.monthlyAmount || stop.amount,
      deliveryPattern: "",
      sourceFile: "freshon-month-sync",
      savedOrder: index + 1,
      updatedAt: generatedAt,
      raw: row
    };
  }).filter((row) => row.deliveryDate && row.vehicle && (row.customerCode || row.customerName || row.address));
}

async function fetchFreshonMonthlyRows({ startDate, endDate, cookie = "" }) {
  const generatedAt = new Date().toISOString();
  const safeCookie = normalizeFreshonCookie(cookie || config.freshonCookie);
  if (!safeCookie) throw new Error("FRESHON_COOKIE 또는 요청 cookie가 필요합니다.");
  const dates = dateRangeList(startDate, endDate);
  const rows = [];
  const daily = [];
  for (const date of dates) {
    const result = await fetchFreshonRowsForDate(date, safeCookie);
    const normalizedRows = freshonRowsToDispatchRows(result.rows, date, generatedAt);
    rows.push(...normalizedRows);
    daily.push({ date, fetched: result.rows.length, saved: normalizedRows.length, endpoint: result.endpoint, attempts: result.attempts.slice(0, 6) });
  }
  return { generatedAt, source: "freshon-month-sync", rows, rowCount: rows.length, range: { startDate: dates[0], endDate: dates.at(-1) }, daily };
}
async function buildFallbackDailyRoute({ date, vehicle, center = "", reason = "" }) {
  const uploaded = await buildDailyRouteFromUploadedDispatch({ date, vehicle, center });
  if (uploaded && uploaded.rowCount > 0) return uploaded;
  return null;
}

app.get("/api/health", (_req, res) => {
  const snapshot = runtimeSnapshot({ browserGate: getBrowserGateStatus() });
  res.json({
    ok: true,
    generatedAt: snapshot.generatedAt,
    uptimeSeconds: snapshot.uptimeSeconds,
    memory: snapshot.memory,
    browserGate: snapshot.browserGate
  });
});

app.get("/api/runtime-metrics", requireView, (_req, res) => {
  res.json(runtimeSnapshot({ browserGate: getBrowserGateStatus() }));
});

app.get("/api/status", requireView, async (_req, res) => {
  const cache = refreshState.running ? null : await readDispatchMeta();
  res.json({
    refresh: refreshState,
    routeRefresh: {
      running: false,
      total: 0,
      completed: 0,
      failed: 0,
      lastError: "Freshon live scraping is disabled. Upload monthly Excel files instead."
    },
    cache: {
      generatedAt: cache?.generatedAt || null,
      range: cache?.range || null,
      rowCount: cache?.rowCount || 0,
      warning: cache?.warning || null
    }
  });
});

app.get("/api/fixed-dispatch", requireView, async (req, res) => {
  try {
    const cache = await readDispatchSource(req.query.source === "google");
    const rows = Array.isArray(cache.rows) ? cache.rows : [];
    const requestedLimit = Number(req.query.limit ?? 500);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(0, Math.min(Math.floor(requestedLimit), 5000))
      : 500;
    res.json({
      ...cache,
      rows: limit ? rows.slice(0, limit) : rows,
      rowCount: cache.rowCount || rows.length,
      totalRows: rows.length,
      previewLimit: limit
    });
  } catch (error) {
    console.error("Fixed dispatch read failed:", error);
    res.status(500).json({
      error: "Fixed dispatch read failed.",
      message: error.message
    });
  }
});

app.post("/api/fixed-dispatch/sync-google-sheet", requireAdmin, async (_req, res) => {
  try {
    const cache = await readDispatchCache();
    const rows = Array.isArray(cache.rows) ? cache.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No fixed-dispatch rows are saved yet." });
    const googleSheetSync = await syncDispatchToGoogleSheet(cache);
    refreshState = {
      ...refreshState,
      lastError: null,
      lastFinishedAt: new Date().toISOString(),
      googleSheetSync
    };
    console.log("Manual Google Sheets sync result:", googleSheetSync);
    res.json({ ok: true, googleSheetSync });
  } catch (error) {
    refreshState = {
      ...refreshState,
      lastError: error.message,
      lastFinishedAt: new Date().toISOString()
    };
    console.error("Manual Google Sheets sync failed:", error);
    res.status(500).json({ error: error.message });
  }
});
app.post("/api/freshon/month-sync", requireAdmin, async (req, res) => {
  try {
    const startDate = normalizeDateValue(req.body?.startDate);
    const endDate = normalizeDateValue(req.body?.endDate || req.body?.startDate);
    const cookie = normalizeFreshonCookie(req.body?.cookie || config.freshonCookie);
    const payload = await fetchFreshonMonthlyRows({ startDate, endDate, cookie });
    if (!payload.rows.length) return res.status(404).json({ error: "프레시온에서 저장할 행을 찾지 못했습니다.", daily: payload.daily });
    const googleSheetSync = await syncDispatchToGoogleSheet(payload);
    refreshState = { ...refreshState, lastError: null, lastFinishedAt: new Date().toISOString(), googleSheetSync };
    res.json({ ok: true, rowCount: payload.rowCount, range: payload.range, daily: payload.daily, googleSheetSync });
  } catch (error) {
    refreshState = { ...refreshState, lastError: error.message, lastFinishedAt: new Date().toISOString() };
    res.status(error.status || 500).json({ error: error.message });
  }
});

function buildMonthlyDispatchSummary(cache) {
  const generatedAt = cache.generatedAt || new Date().toISOString();
  const rows = Array.isArray(cache.rows)
    ? cache.rows.map((row, index) => normalizeDispatchRowForSheet(row, index, generatedAt))
    : [];
  const vehicles = new Map();
  const stores = new Map();
  let totalAmount = 0;
  let coordinateMissingCount = 0;
  for (const row of rows) {
    const date = row.deliveryDate;
    const vehicle = normalizeVehicleValue(row.vehicle);
    const code = row.customerCode;
    const name = row.customerName;
    const address = row.address;
    const lat = row.lat;
    const lng = row.lng;
    const amount = Number(row.amount || 0);
    if (!lat || !lng) coordinateMissingCount += 1;
    totalAmount += amount;
    if (vehicle) {
      const current = vehicles.get(vehicle) || { vehicle, stopCount: 0, amount: 0, dates: new Set() };
      current.stopCount += 1;
      current.amount += amount;
      if (date) current.dates.add(date);
      vehicles.set(vehicle, current);
    }
    const storeKey = code || `${name}|${address}`;
    if (storeKey && storeKey !== "|") {
      const current = stores.get(storeKey) || { code, name, address, vehicle, stopCount: 0, amount: 0, dates: new Set() };
      current.stopCount += 1;
      current.amount += amount;
      if (date) current.dates.add(date);
      stores.set(storeKey, current);
    }
  }
  const vehicleRows = [...vehicles.values()]
    .map((item) => ({
      ...item,
      stops: item.stopCount,
      perStop: item.stopCount ? item.amount / item.stopCount : 0,
      dates: item.dates.size,
      lastDate: [...item.dates].sort().at(-1) || ""
    }))
    .sort((a, b) => b.amount - a.amount || b.stopCount - a.stopCount)
    .slice(0, 80);
  const storeRows = [...stores.values()]
    .map((item) => ({
      ...item,
      stops: item.stopCount,
      perStop: item.stopCount ? item.amount / item.stopCount : 0,
      dates: item.dates.size,
      lastDate: [...item.dates].sort().at(-1) || ""
    }))
    .sort((a, b) => b.amount - a.amount || b.stopCount - a.stopCount)
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
  if (!forceGoogle) {
    const cached = await readMonthlyDispatchSummaryLocalFirst();
    if (cached) {
      const payload = { ...cached, source: cached.source || "monthly-dispatch-summary-cache" };
      if (compact) delete payload.rows;
      return res.json(payload);
    }
  }
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
  const results = await buildCustomerSearchItems(q);
  res.json({
    query: q,
    generatedAt: new Date().toISOString(),
    rowCount: results.length,
    results: results.map((item) => ({
      code: item.code,
      name: item.name,
      address: item.address,
      vehicle: item.vehicle,
      center: item.route,
      sequence: item.sequence,
      lat: item.lat,
      lng: item.lng,
      hasCoords: item.hasCoords,
      source: item.source
    }))
  });
});

app.get("/api/monthly-dispatch-route", requireView, async (req, res) => {
  const date = normalizeDateValue(req.query.date);
  const vehicle = normalizeVehicleValue(req.query.vehicle);
  const center = normalizeCell(req.query.center);
  if (!date || !vehicle) return res.status(400).json({ error: "date and vehicle are required." });
  const localRoute = await buildFallbackDailyRoute({ date, vehicle, center }).catch(() => null);
  if (localRoute?.stops?.length) {
    return res.json({ ...localRoute, source: localRoute.source || "monthly-dispatch-cache", api: "monthly-dispatch-route" });
  }
  const sheetIndexedRoute = await Promise.race([
    readRouteFromGoogleRouteIndex(date, vehicle).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 6500))
  ]);
  if (sheetIndexedRoute?.stops?.length) {
    return res.json(sheetIndexedRoute);
  }
  return res.status(404).json({
    error: `월시트에 ${date} ${vehicle}호 동선이 없습니다.`,
    source: "monthly-dispatch-cache",
    date,
    vehicle,
    center
  });
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




















