import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requireAdmin, requireView } from "./auth.js";
import { getDefaultDispatchRange } from "./dateRange.js";
import { readDailyRoute, readDispatchCache, writeDailyRoute, writeDispatchCache } from "./store.js";
import { refreshFixedDispatchData } from "./scraper/freshonFixedDispatch.js";
import { refreshDailyRouteData } from "./scraper/freshonDailyRoute.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

let refreshState = {
  running: false,
  lastError: null,
  lastStartedAt: null,
  lastFinishedAt: null
};

let routeRefreshState = {
  running: false,
  lastError: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  total: 0,
  completed: 0,
  failed: 0,
  current: null
};

function eachDate(startDate, endDate) {
  const dates = [];
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return dates;
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function parseVehicles(value) {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  return String(value || "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

async function runRouteBatch({ startDate, endDate, vehicles, center }) {
  const dates = eachDate(startDate, endDate);
  routeRefreshState = {
    running: true,
    lastError: null,
    lastStartedAt: new Date().toISOString(),
    lastFinishedAt: null,
    total: dates.length * vehicles.length,
    completed: 0,
    failed: 0,
    current: null
  };

  try {
    for (const date of dates) {
      for (const vehicle of vehicles) {
        routeRefreshState.current = { date, vehicle };
        try {
          const payload = await refreshDailyRouteData({ date, vehicle, center });
          await writeDailyRoute(payload);
          routeRefreshState.completed += 1;
        } catch (error) {
          routeRefreshState.failed += 1;
          routeRefreshState.lastError = `${date} ${vehicle}: ${error.message}`;
        }
      }
    }
  } finally {
    routeRefreshState.running = false;
    routeRefreshState.lastFinishedAt = new Date().toISOString();
    routeRefreshState.current = null;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, generatedAt: new Date().toISOString() });
});

app.get("/api/status", requireView, async (_req, res) => {
  const cache = await readDispatchCache();
  res.json({
    refresh: refreshState,
    routeRefresh: routeRefreshState,
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
  return res.status(404).json({ error: "No cached daily route. Refresh route cache from admin first.", date, vehicle });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.post("/api/refresh", requireAdmin, async (req, res) => {
  if (refreshState.running) {
    return res.status(409).json({ error: "Refresh already running.", refresh: refreshState });
  }

  const range = req.body?.range || getDefaultDispatchRange();
  refreshState = {
    running: true,
    lastError: null,
    lastStartedAt: new Date().toISOString(),
    lastFinishedAt: null
  };

  try {
    const payload = await refreshFixedDispatchData({ range });
    await writeDispatchCache(payload);
    refreshState.running = false;
    refreshState.lastFinishedAt = new Date().toISOString();
    res.json({ ok: true, rowCount: payload.rowCount, range: payload.range });
  } catch (error) {
    refreshState.running = false;
    refreshState.lastError = error.message;
    refreshState.lastFinishedAt = new Date().toISOString();
    res.status(500).json({ error: error.message, refresh: refreshState });
  }
});

app.post("/api/refresh-daily-route", requireAdmin, async (req, res) => {
  const date = String(req.body?.date || "");
  const vehicle = String(req.body?.vehicle || "");
  const center = String(req.body?.center || "");
  if (!date || !vehicle) {
    return res.status(400).json({ error: "date and vehicle are required." });
  }

  try {
    const payload = await refreshDailyRouteData({ date, vehicle, center });
    await writeDailyRoute(payload);
    res.json({ ok: true, date, vehicle, rowCount: payload.rowCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/refresh-daily-routes", requireAdmin, async (req, res) => {
  if (routeRefreshState.running) {
    return res.status(409).json({ error: "Daily route refresh already running.", routeRefresh: routeRefreshState });
  }

  const startDate = String(req.body?.startDate || req.body?.date || "");
  const endDate = String(req.body?.endDate || req.body?.date || startDate);
  const vehicles = parseVehicles(req.body?.vehicles);
  const center = String(req.body?.center || "");

  if (!startDate || !endDate || !vehicles.length) {
    return res.status(400).json({ error: "startDate, endDate, and vehicles are required." });
  }

  runRouteBatch({ startDate, endDate, vehicles, center }).catch((error) => {
    routeRefreshState.running = false;
    routeRefreshState.lastError = error.message;
    routeRefreshState.lastFinishedAt = new Date().toISOString();
  });

  res.status(202).json({
    ok: true,
    message: "Daily route refresh started.",
    routeRefresh: {
      ...routeRefreshState,
      total: eachDate(startDate, endDate).length * vehicles.length
    }
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(config.port, () => {
  console.log(`Freshon dispatch admin listening on ${config.port}`);
});
