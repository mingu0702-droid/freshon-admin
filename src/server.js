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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, generatedAt: new Date().toISOString() });
});

app.get("/api/status", requireView, async (_req, res) => {
  const cache = await readDispatchCache();
  res.json({
    refresh: refreshState,
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
  if (!date || !vehicle) {
    return res.status(400).json({ error: "date and vehicle are required." });
  }
  const payload = await readDailyRoute(date, vehicle);
  if (!payload) {
    return res.status(404).json({ error: "No cached daily route.", date, vehicle });
  }
  res.json(payload);
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(config.port, () => {
  console.log(`Freshon dispatch admin listening on ${config.port}`);
});
