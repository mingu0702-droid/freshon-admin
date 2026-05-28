import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import multer from "multer";
import path from "node:path";
import XLSX from "xlsx";
import XlsxPopulate from "xlsx-populate";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requireAdmin, requireView } from "./auth.js";
import { readDailyRoute, readDispatchCache, writeDailyRoute } from "./store.js";
import { writeDispatchCache } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");
const decryptScriptPath = path.join(__dirname, "decrypt_office.py");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
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
  lastFinishedAt: null
};

let vehicleAreaDataPromise = null;

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
        throw new Error(`${file.originalname} 파일을 읽지 못했습니다. 암호화 Excel 복호화도 실패했습니다. 암호 설정(EXCEL_PASSWORD)과 파일 형식을 확인해주세요. (일반: ${error.message} / xlsx암호: ${encryptedError.message} / 구형암호: ${officeCryptoError.message})`);
      }
    }
  }
}

function makeRowKey(row) {
  const priorityKeys = [
    "등록일",
    "일자",
    "배송일",
    "입고요청일",
    "출고일",
    "고객코드",
    "고객 코드",
    "거래처코드",
    "매장코드",
    "호차",
    "확정호차",
    "기준호차",
    "고객주소",
    "주소"
  ];
  const values = priorityKeys.map((key) => row[key]).filter(Boolean);
  if (values.length >= 2) return values.join("|");
  return JSON.stringify(row);
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
  const dateColumns = ["등록일", "일자", "배송일", "입고요청일", "출고일"];
  const dates = [];
  for (const row of rows) {
    for (const column of dateColumns) {
      const value = normalizeCell(row[column]);
      const normalized = normalizeDateValue(value);
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
  return normalizeCell(value).replace(/\s+/g, "").replace(/[()（）]/g, "");
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
  const rowDate = normalizeDateValue(firstValue(row, ["\uC785\uACE0\uC694\uCCAD\uC77C", "\uB4F1\uB85D\uC77C", "\uC77C\uC790", "\uBC30\uC1A1\uC77C", "\uCD9C\uACE0\uC77C"]));
  if (rowDate !== date) return false;
  const selected = vehicleTokens(vehicle);
  if (!selected.size) return false;
  const rowTokens = ["\uD655\uC815\uD638\uCC28", "\uAE30\uC900\uD638\uCC28", "\uD638\uCC28", "\uCC28\uB7C9", "\uCC28\uB7C9\uBC88\uD638", "\uBC30\uCC28\uD638\uCC28"]
    .flatMap((column) => [...vehicleTokens(row[column])]);
  return rowTokens.some((value) => selected.has(value));
}

function deliveryCompletionInfo(row) {
  const status = firstValue(row, ["\uBC30\uC1A1\uC0C1\uD0DC", "\uC0C1\uD0DC", "\uCC98\uB9AC\uC0C1\uD0DC"]);
  const completeFlag = exactColumnValue(row, ["\uBC30\uC1A1\uC644\uB8CC"]);
  const completedAt = firstValue(row, ["\uBC30\uC1A1\uC644\uB8CC\uC77C\uC2DC", "\uBC30\uC1A1\uC644\uB8CC \uC77C\uC2DC", "\uC644\uB8CC\uC77C\uC2DC", "\uC644\uB8CC\uC2DC\uAC04"]);
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
  const routeItems = (deliveryItems.length ? deliveryItems : matchedItems)
    .sort((left, right) => routeSortValue(left.row, left.index) - routeSortValue(right.row, right.index))
  const rows = routeItems.map((item) => item.row);
  if (!rows.length) return null;
  const appRecordedCount = rows.filter((row) => deliveryCompletionInfo(row).appRecorded).length;
  const appMissingCount = rows.length - appRecordedCount;
  return {
    generatedAt: new Date().toISOString(),
    source: deliveryItems.length ? "uploaded-delivery-history" : "uploaded-fixed-dispatch",
    warning: deliveryItems.length
      ? "Uploaded delivery-history Excel data was used. Only rows with delivery-completed status are treated as app-recorded route points."
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

async function buildFallbackDailyRoute({ date, vehicle, center = "", reason = "" }) {
  const uploaded = await buildDailyRouteFromUploadedDispatch({ date, vehicle, center });
  if (uploaded) return uploaded;

  const data = await readVehicleAreaData();
  const vehicleData = (data.vehicles || []).find((item) => String(item.vehicle) === String(vehicle));
  const customers = (vehicleData?.customers || []).filter((customer) => Number.isFinite(customer.lat) && Number.isFinite(customer.lng));
  if (!customers.length) return null;

  return {
    generatedAt: new Date().toISOString(),
    source: "vehicle-area-fallback",
    warning: reason ? `No uploaded route rows for this date; used vehicle area data instead. ${reason}` : "No uploaded route rows for this date; used vehicle area data instead.",
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
  if (!date || !vehicle) {
    return res.status(400).json({ error: "date and vehicle are required." });
  }
  const cached = await readDailyRoute(date, vehicle);
  if (cached) {
    return res.json(cached);
  }
  const fallback = await buildFallbackDailyRoute({ date, vehicle, center });
  if (fallback) {
    await writeDailyRoute(fallback);
    return res.json(fallback);
  }
  return res.status(404).json({ error: "No cached daily route.", date, vehicle });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.post("/api/upload-fixed-dispatch", requireAdmin, upload.array("files", 12), async (req, res) => {
  if (refreshState.running) {
    return res.status(409).json({ error: "Upload already running.", refresh: refreshState });
  }
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: "Excel files are required." });
  }

  refreshState = {
    running: true,
    lastError: null,
    lastStartedAt: new Date().toISOString(),
    lastFinishedAt: null
  };

  try {
    const current = await readDispatchCache();
    const parsedFiles = await Promise.all(files.map((file) => parseWorkbook(file)));
    const uploadedRows = parsedFiles.flatMap((item) => item.rows);
    if (!uploadedRows.length) {
      throw new Error("No rows were found in the uploaded Excel files.");
    }

    const columns = mergeColumns(current.columns || [], parsedFiles.flatMap((item) => item.columns));
    const rows = mergeRows(current.rows || [], uploadedRows);
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
    refreshState.running = false;
    refreshState.lastFinishedAt = new Date().toISOString();
    refreshState.rowCount = payload.rowCount;
    refreshState.range = payload.range;
    res.json({
      ok: true,
      uploadedRows: uploadedRows.length,
      rowCount: payload.rowCount,
      files: payload.uploadedFiles,
      range: payload.range
    });
  } catch (error) {
    refreshState.running = false;
    refreshState.lastError = error.message;
    refreshState.lastFinishedAt = new Date().toISOString();
    res.status(500).json({ error: error.message });
  }
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

app.listen(config.port, () => {
  console.log(`Freshon dispatch admin listening on ${config.port}`);
});

