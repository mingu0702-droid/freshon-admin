import express from "express";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import multer from "multer";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import XLSX from "xlsx";
import XlsxPopulate from "xlsx-populate";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requireAdmin, requireView } from "./auth.js";
import { clearDailyRouteCache, readDailyRoute, readDispatchCache, writeDailyRoute } from "./store.js";
import { writeDispatchCache } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");
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
app.use(express.static(publicDir));

let refreshState = {
  running: false,
  lastError: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  jobId: null
};

let vehicleAreaDataPromise = null;
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

function rowsFromSheetValues(values, file, sheetName) {
  const rows = [];
  const columns = new Set();
  const headerIndex = values.findIndex((row) => Array.isArray(row) && row.some((value) => normalizeCell(value)));
  if (headerIndex < 0) return { rows, columns: [] };

  const headers = values[headerIndex].map((value, index) => normalizeCell(value) || `column_${index + 1}`);
  for (const header of headers) {
    if (header && !header.startsWith("__EMPTY")) columns.add(header);
  }

  for (const rowValues of values.slice(headerIndex + 1)) {
    const row = {};
    headers.forEach((header, index) => {
      const column = normalizeCell(header);
      if (!column || column.startsWith("__EMPTY")) return;
      row[column] = normalizeCell(rowValues?.[index]);
    });
    if (Object.values(row).some(Boolean)) {
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
  const { timeoutMs = 12000, ...fetchOptions } = options;
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
    throw new Error(`Python Excel parse failed. ${errors.join(" / ")}`);
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

function inferRange(rows) {
  const dates = [];
  for (const row of rows) {
    for (const value of Object.values(row || {})) {
      const normalized = normalizeDateValue(normalizeCell(value));
      if (normalized) dates.push(normalized);
    }
  }
  dates.sort();
  if (!dates.length) return null;
  return { startDate: dates[0], endDate: dates[dates.length - 1] };
}
async function readVehicleAreaData() {
  vehicleAreaDataPromise ||= fs.readFile(path.join(publicDir, "vehicle-data.js"), "utf8")
    .then((text) => {
      const jsonText = text
        .replace(/^window\.VEHICLE_AREA_DATA\s*=\s*/, "")
        .replace(/;\s*$/, "");
      return JSON.parse(jsonText);
    })
    .catch(() => ({ vehicles: [] }));
  return vehicleAreaDataPromise;
}

function normalizeColumnName(value) {
  return normalizeCell(value).replace(/\s+/g, "").replace(/[()竊덌펹]/g, "");
}

function firstValue(row, columns) {
  for (const column of columns) {
    const value = normalizeCell(row[column]);
    if (value) return value;
  }
  const entries = Object.entries(row);
  for (const column of columns) {
    const target = normalizeColumnName(column);
    if (!target) continue;
    const match = entries.find(([key, value]) => {
      const keyName = normalizeColumnName(key);
      return normalizeCell(value) && (keyName === target || keyName.includes(target));
    });
    if (match) return normalizeCell(match[1]);
  }
  return "";
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
  const text = normalizeCell(value);
  if (!text) return "";
  const match = text.match(/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
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
  const rowDate = normalizeDateValue(firstValue(row, [
    "\uC785\uACE0\uC694\uCCAD\uC77C(\uBC30\uC1A1\uC77C)",
    "\uC785\uACE0\uC694\uCCAD\uC77C",
    "\uBC30\uC1A1\uC77C",
    "\uBC30\uC1A1\uC77C\uC790",
    "\uC77C\uC790",
    "\uCD9C\uACE0\uC77C",
    "\uBC30\uCC28\uC77C",
    "\uBC30\uCC28\uC77C\uC790",
    "\uC6B4\uD589\uC77C\uC790",
    "\uB0A9\uD488\uC77C\uC790",
    "\uB4F1\uB85D\uC77C"
  ]));
  if (rowDate !== date) return false;
  const selected = vehicleTokens(vehicle);
  if (!selected.size) return false;
  const rowTokens = new Set();
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
    "\uD638\uCC28\uBA85"
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
  const address = [
    firstValue(row, ["\uACE0\uAC1D\uC8FC\uC18C", "\uC8FC\uC18C", "\uBC30\uC1A1\uC8FC\uC18C"]),
    firstValue(row, ["\uC0C1\uC138\uC8FC\uC18C", "\uC0C1\uC138\uC8FC\uC18C1", "\uC0C1\uC138"])
  ].filter(Boolean).join(" ").trim();
  const customerCode = firstValue(row, ["\uACE0\uAC1D", "\uACE0\uAC1D\uCF54\uB4DC", "\uACE0\uAC1D \uCF54\uB4DC", "\uACE0\uAC1DERP\uCF54\uB4DC", "ERP\uCF54\uB4DC", "\uAC70\uB798\uCC98\uCF54\uB4DC", "\uB9E4\uC7A5\uCF54\uB4DC"]);
  const customerName = firstValue(row, ["\uACE0\uAC1D\uBA85", "\uB9E4\uC7A5\uBA85", "\uAC70\uB798\uCC98\uBA85", "\uC0C1\uD638"]);
  const amount = firstValue(row, ["\uB9E4\uCD9C\uAE08\uC561", "\uAE08\uC561", "\uCD9C\uACE0\uAE08\uC561", "\uD310\uB9E4\uAE08\uC561"]);
  const deliveryTime = firstValue(row, ["\uBC30\uC1A1\uC2DC\uAC04", "\uB3C4\uCC29\uC2DC\uAC04", "\uCD9C\uBC1C\uC2DC\uAC04", "\uC785\uACE0\uC2DC\uAC04", "\uC2DC\uAC04"]);
  const completion = deliveryCompletionInfo(row);
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
  const cache = await readDispatchCache();
  const matchedItems = (cache.rows || [])
    .map((row, index) => ({ row, index }))
    .filter((item) => rowMatchesDailyRoute(item.row, date, vehicle));
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
  const rows = routeItems.map((item) => item.row);
  if (!rows.length) return null;
  const appRecordedCount = rows.filter((row) => deliveryCompletionInfo(row).appRecorded).length;
  const appMissingCount = rows.length - appRecordedCount;
  const source = baseItems.length && deliveryItems.length
    ? "uploaded-fixed-dispatch-with-delivery-history"
    : deliveryItems.length
      ? "uploaded-delivery-history"
      : "uploaded-fixed-dispatch";
  return {
    generatedAt: new Date().toISOString(),
    source,
    warning: baseItems.length && deliveryItems.length
      ? "Uploaded fixed-dispatch rows were used as the route base, and delivery-history rows were merged only for app completion records."
      : deliveryItems.length
        ? "Uploaded delivery-history Excel data was used because no fixed-dispatch route base rows matched this date and vehicle."
        : "Uploaded fixed-dispatch Excel data was used for this daily route.",
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
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Freshon HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function freshonDailyRouteForm({ date, vehicle, center = "", page = 0 }) {
  const centerText = center || "";
  return {
    page: String(page),
    isPaging: "true",
    isCount: "true",
    size: "1000",
    excelFileNm: `daily_dispatch_${date}_${vehicle}`,
    logCd: "011",
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
    dlvyReqDate: date,
    carSeq: vehicle,
    carSeqNm: vehicle,
    carCd: vehicle,
    carNm: vehicle,
    carNo: vehicle,
    fixedCarSeq: vehicle,
    fixedCarSeqNm: vehicle,
    shipGbn: "1",
    shipGbnNm: "night",
    tcYn: "",
    tcGbn: ""
  };
}

function freshonDailyRouteRequestVariants({ date, vehicle, center = "", page = 0 }) {
  const form = freshonDailyRouteForm({ date, vehicle, center, page });
  const params = new URLSearchParams(form);
  return [
    {
      label: "form",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: params.toString()
      }
    },
    {
      label: "json",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(form)
      }
    },
    {
      label: "query",
      suffix: `?${params.toString()}`,
      options: {
        method: "GET"
      }
    }
  ];
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
    throw error;
  }
  const selected = vehicleTokens(vehicle);
  const vehicleAreaData = await readVehicleAreaData().catch(() => null);
  const vehicleData = (vehicleAreaData?.vehicles || []).find((item) => String(item.vehicle) === String(vehicle));
  const endpoints = [
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
  const errors = [];
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
        if (!matched.length) continue;
        const stops = matched
          .map((row, index) => buildStopFromFreshonDailyRow(row, vehicle, index + 1))
          .filter((stop) => stop.customerCode || stop.customerName || stop.address);
        if (!stops.length) continue;
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
        errors.push(`${endpoint} ${variant.label}: ${error.message || String(error)}`);
      }
    }
  }
  const error = new Error(`Freshon daily dispatch lookup failed. ${errors[0] || "No matching rows returned."}`);
  error.status = 502;
  throw error;
}

async function buildFallbackDailyRoute({ date, vehicle, center = "", reason = "" }) {
  const uploaded = await buildDailyRouteFromUploadedDispatch({ date, vehicle, center });
  if (uploaded && uploaded.rowCount > 2) return uploaded;

  const data = await readVehicleAreaData();
  const vehicleData = (data.vehicles || []).find((item) => String(item.vehicle) === String(vehicle));
  const customers = (vehicleData?.customers || []).filter((customer) => Number.isFinite(customer.lat) && Number.isFinite(customer.lng));
  if (!customers.length) return null;

  return {
    generatedAt: new Date().toISOString(),
    source: "vehicle-area-fallback",
    warning: uploaded
      ? `Uploaded route rows looked incomplete (${uploaded.rowCount} rows), so vehicle area data was shown instead.`
      : reason ? `No uploaded route rows for this date; used vehicle area data instead. ${reason}` : "No uploaded route rows for this date; used vehicle area data instead.",
    date,
    vehicle,
    center,
    rowCount: customers.length,
    stops: customers.map((customer, index) => ({
      sequence: index + 1,
      raw: customer,
      code: customer.id || "",
      name: customer.name || "",
      address: customer.address || "",
      vehicle: `${vehicle}\uD638`,
      customerCode: customer.id || "",
      customerName: customer.name || "",
      amount: customer.avg_order_amount || "",
      dailyAmount: customer.avg_order_amount || "",
      monthlyAmount: customer.avg_order_amount || "",
      orderCount: customer.delivery_pattern || "",
      deliveryPattern: customer.delivery_pattern || "",
      lat: customer.lat,
      lng: customer.lng
    }))
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, generatedAt: new Date().toISOString() });
});

app.get("/api/status", requireView, async (_req, res) => {
  const cache = await readDispatchCache();
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
      generatedAt: cache.generatedAt,
      range: cache.range,
      rowCount: cache.rowCount || cache.rows?.length || 0,
      warning: cache.warning || null
    }
  });
});

app.get("/api/fixed-dispatch", requireView, async (_req, res) => {
  res.json(await readDispatchCache());
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
  const cached = await readDailyRoute(date, vehicle);
  if (cached && !forceRefresh) {
    const dispatchCache = await readDispatchCache();
    const cachedAt = cached.generatedAt ? Date.parse(cached.generatedAt) : 0;
    const dispatchAt = dispatchCache.generatedAt ? Date.parse(dispatchCache.generatedAt) : 0;
    if (cached.source !== "uploaded-delivery-history" && (!dispatchAt || cachedAt >= dispatchAt)) {
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
      if (req.query.source === "freshon") {
        return res.status(error.status || 502).json({
          error: error.message || "Freshon daily dispatch lookup failed.",
          source: "freshon-daily-dispatch"
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
  const dispatchCache = await readDispatchCache();
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
      await pipeline(fsSync.createReadStream(chunkPath), output, { end: false });
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

app.post("/api/upload-fixed-dispatch", requireAdmin, upload.array("files", 12), async (req, res) => {
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




