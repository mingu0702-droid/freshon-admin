import express from "express";
import fs from "node:fs/promises";
import multer from "multer";
import path from "node:path";
import XLSX from "xlsx";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requireAdmin, requireView } from "./auth.js";
import { readDailyRoute, readDispatchCache, writeDailyRoute } from "./store.js";
import { writeDispatchCache } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024,
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

function parseWorkbook(file) {
  const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
  const rows = [];
  const columns = new Set();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const sheetRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    for (const sheetRow of sheetRows) {
      const row = {};
      for (const [key, value] of Object.entries(sheetRow)) {
        const column = normalizeCell(key);
        if (!column || column.startsWith("__EMPTY")) continue;
        row[column] = normalizeCell(value);
        columns.add(column);
      }
      if (Object.values(row).some(Boolean)) {
        row._sourceFile = file.originalname;
        row._sourceSheet = sheetName;
        rows.push(row);
      }
    }
  }

  return { rows, columns: [...columns] };
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
      if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(value)) {
        const normalized = value
          .replace(/[./]/g, "-")
          .split("-")
          .map((part, index) => index === 0 ? part : part.padStart(2, "0"))
          .join("-");
        dates.push(normalized);
      }
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

async function buildFallbackDailyRoute({ date, vehicle, center = "", reason = "" }) {
  const data = await readVehicleAreaData();
  const vehicleData = (data.vehicles || []).find((item) => String(item.vehicle) === String(vehicle));
  const customers = (vehicleData?.customers || []).filter((customer) => Number.isFinite(customer.lat) && Number.isFinite(customer.lng));
  if (!customers.length) return null;

  return {
    generatedAt: new Date().toISOString(),
    source: "vehicle-area-fallback",
    warning: reason ? `Freshon route scraping is disabled; used vehicle area data instead. ${reason}` : "Freshon route scraping is disabled; used vehicle area data instead.",
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
      vehicle: `${vehicle}호`,
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
    const parsedFiles = files.map(parseWorkbook);
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(config.port, () => {
  console.log(`Freshon dispatch admin listening on ${config.port}`);
});

