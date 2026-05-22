import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requireAdmin, requireView } from "./auth.js";
import { getDefaultDispatchRange } from "./dateRange.js";
import { readDailyRoute, readDispatchCache, writeDailyRoute, writeDispatchCache } from "./store.js";
import { refreshFixedDispatchData } from "./scraper/freshonFixedDispatch.js";
import { refreshDailyRouteData, withDailyRouteSession } from "./scraper/freshonDailyRoute.js";

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
  skipped: 0,
  failed: 0,
  current: null,
  active: [],
  concurrency: 1,
  stopRequested: false
};

let dailyRouteWriteQueue = Promise.resolve();
let routeRefreshGeneration = 0;

const DEFAULT_ROUTE_VEHICLES = [
  "101",
  "102",
  "103",
  "104",
  "105",
  "106",
  "107",
  "108",
  "109",
  "110",
  "111",
  "112",
  "113",
  "114",
  "115",
  "116",
  "117",
  "118",
  "119",
  "120",
  "121",
  "122",
  "123",
  "124",
  "125",
  "126",
  "127",
  "151",
  "152",
  "153",
  "154",
  "155",
  "156",
  "157",
  "158",
  "159",
  "160",
  "161",
  "162",
  "163",
  "164",
  "165",
  "166",
  "167",
  "168",
  "169",
  "170",
  "171",
  "172",
  "173",
  "175",
  "176",
  "177",
  "178",
  "201",
  "202",
  "203",
  "204",
  "205",
  "206",
  "207",
  "208",
  "209",
  "210",
  "211",
  "212",
  "213",
  "214",
  "215",
  "216",
  "217",
  "218",
  "219",
  "220",
  "221",
  "222",
  "223",
  "225",
  "227",
  "228",
  "229",
  "230",
  "231",
  "234",
  "235",
  "236",
  "\uC6A901",
  "\uC6A902",
  "\uC6A903",
  "\uC6A904",
  "\uC6A905",
  "\uC6A906",
  "\uC6A907",
  "\uC6A908",
  "\uC6A909",
  "\uC6A910",
  "\uC6A911",
  "\uC6A912",
  "\uC6A913",
  "\uC6A914",
  "\uCC9901",
  "\uCC9902",
  "\uCC9903",
  "\uCC9904",
  "\uCC9905",
  "\uCC9906",
  "\uCC9907",
  "\uCC9908",
  "\uCC9909"
];

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
  const vehicles = String(value || "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  return vehicles.length ? vehicles : DEFAULT_ROUTE_VEHICLES;
}

function parseConcurrency(value) {
  const number = Number(value || process.env.ROUTE_REFRESH_CONCURRENCY || 3);
  if (!Number.isFinite(number)) return 3;
  return Math.max(1, Math.min(5, Math.floor(number)));
}

async function writeDailyRouteQueued(payload) {
  dailyRouteWriteQueue = dailyRouteWriteQueue.then(() => writeDailyRoute(payload));
  return dailyRouteWriteQueue;
}

async function runRouteBatch({ startDate, endDate, vehicles, center, concurrency = 3 }) {
  const generation = ++routeRefreshGeneration;
  const dates = eachDate(startDate, endDate);
  const jobs = dates.flatMap((date) => vehicles.map((vehicle) => ({ date, vehicle })));
  let nextJobIndex = 0;

  routeRefreshState = {
    running: true,
    lastError: null,
    lastStartedAt: new Date().toISOString(),
    lastFinishedAt: null,
    total: jobs.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    current: null,
    active: [],
    concurrency,
    stopRequested: false
  };

  async function nextJob() {
    const index = nextJobIndex;
    nextJobIndex += 1;
    return jobs[index] || null;
  }

  async function runWorker(workerId) {
    await withDailyRouteSession(async (scrape) => {
      while (routeRefreshState.running && !routeRefreshState.stopRequested) {
        const job = await nextJob();
        if (!job) return;
        const { date, vehicle } = job;
        routeRefreshState.current = { date, vehicle };
        routeRefreshState.active = [
          ...routeRefreshState.active.filter((item) => item.workerId !== workerId),
          { workerId, date, vehicle }
        ];
        try {
          const cached = await readDailyRoute(date, vehicle);
          if (cached?.stops?.length) {
            routeRefreshState.skipped += 1;
            routeRefreshState.completed += 1;
            continue;
          }
          const payload = await scrape({ date, vehicle, center });
          await writeDailyRouteQueued(payload);
          routeRefreshState.completed += 1;
        } catch (error) {
          routeRefreshState.failed += 1;
          routeRefreshState.lastError = `${date} ${vehicle}: ${error.message}`;
        }
      }
    });
  }

  try {
    const workerCount = Math.min(concurrency, jobs.length || 1);
    await Promise.all(Array.from({ length: workerCount }, (_value, index) => runWorker(index + 1)));
  } finally {
    if (generation === routeRefreshGeneration) {
      routeRefreshState.running = false;
      routeRefreshState.lastFinishedAt = new Date().toISOString();
      routeRefreshState.current = null;
      routeRefreshState.active = [];
    }
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
  const concurrency = parseConcurrency(req.body?.concurrency);

  if (!startDate || !endDate) {
    return res.status(400).json({ error: "startDate and endDate are required." });
  }

  runRouteBatch({ startDate, endDate, vehicles, center, concurrency }).catch((error) => {
    routeRefreshState.running = false;
    routeRefreshState.lastError = error.message;
    routeRefreshState.lastFinishedAt = new Date().toISOString();
  });

  res.status(202).json({
    ok: true,
    message: "Daily route refresh started.",
    routeRefresh: {
      ...routeRefreshState,
      total: eachDate(startDate, endDate).length * vehicles.length,
      concurrency
    }
  });
});

app.post("/api/cancel-daily-routes", requireAdmin, (_req, res) => {
  if (!routeRefreshState.running) {
    return res.json({ ok: true, message: "No daily route refresh is running.", routeRefresh: routeRefreshState });
  }
  routeRefreshState.stopRequested = true;
  routeRefreshState.running = false;
  routeRefreshState.lastError = "Daily route refresh was stopped by admin.";
  routeRefreshState.lastFinishedAt = new Date().toISOString();
  res.json({ ok: true, message: "Daily route refresh stop requested.", routeRefresh: routeRefreshState });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(config.port, () => {
  console.log(`Freshon dispatch admin listening on ${config.port}`);
});

