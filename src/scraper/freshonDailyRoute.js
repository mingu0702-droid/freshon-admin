import { chromium, request } from "playwright";
import { config } from "../config.js";

const PAGE_SIZE = 1000;
const MAX_PAGES = 80;
const ROUTE_TIMEOUT_MS = Math.min(config.navTimeoutMs, 25000);
const freshonOrigin = new URL(config.freshonBaseUrl).origin;

function assertCredentials() {
  if (!config.freshonId || !config.freshonPassword) {
    throw new Error("FRESHON_ID and FRESHON_PASSWORD must be configured as environment variables.");
  }
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        await locator.fill(value).catch(() => null);
        return true;
      }
    }
  }
  return false;
}

async function maybeLogin(page) {
  const idFilled = await fillFirstVisible(page, [
    "input[name='id']",
    "input[name='userId']",
    "input[name='loginId']",
    "input[type='text']"
  ], config.freshonId);

  const pwFilled = await fillFirstVisible(page, [
    "input[name='password']",
    "input[name='passwd']",
    "input[type='password']"
  ], config.freshonPassword);

  if (!idFilled || !pwFilled) return;

  const submit = page.locator("button[type='submit'], input[type='submit'], button").first();
  if (await submit.count()) {
    await Promise.allSettled([
      page.waitForLoadState("domcontentloaded", { timeout: ROUTE_TIMEOUT_MS }),
      submit.click({ timeout: 4000 })
    ]);
  } else {
    await page.keyboard.press("Enter").catch(() => null);
    await page.waitForLoadState("domcontentloaded", { timeout: ROUTE_TIMEOUT_MS }).catch(() => null);
  }
}

async function createLoggedInContext() {
  if (config.freshonCookie) {
    const context = await request.newContext({
      baseURL: freshonOrigin,
      extraHTTPHeaders: {
        Accept: "application/json, text/plain, */*",
        Cookie: config.freshonCookie,
        Origin: freshonOrigin,
        Referer: config.freshonBaseUrl
      }
    });
    return { browser: null, context };
  }

  assertCredentials();
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();
  page.setDefaultTimeout(ROUTE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(ROUTE_TIMEOUT_MS);

  await page.goto(`${config.freshonBaseUrl}#/bo/wm/standard/driverCarListPage`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await maybeLogin(page);
  await page.waitForLoadState("domcontentloaded", { timeout: ROUTE_TIMEOUT_MS }).catch(() => null);
  return { browser, context: page.context() };
}

function toForm({ page, date, vehicle, center }) {
  return {
    page: String(page),
    isPaging: "true",
    isCount: "true",
    size: String(PAGE_SIZE),
    sort: "est_cd,ASC",
    excelFileNm: `daily_route_${date || ""}_${vehicle || ""}`,
    logCd: "011",
    estCd: "",
    estName: "",
    estNm: "",
    estGbn: "",
    startDate: "",
    endDate: "",
    carCd: "",
    carNm: vehicle || "",
    shipGbn: "1",
    baecha: center || ""
  };
}

function weekdayKeys(date) {
  const day = new Date(`${date}T00:00:00`).getDay();
  return [
    ["carSeqSun", "carSeqSunNm", "sun"],
    ["carSeqMon", "carSeqMonNm", "mon"],
    ["carSeqTue", "carSeqTueNm", "tue"],
    ["carSeqWed", "carSeqWedNm", "wed"],
    ["carSeqThu", "carSeqThuNm", "thu"],
    ["carSeqFri", "carSeqFriNm", "fri"],
    ["carSeqSat", "carSeqSatNm", "sat"]
  ][day];
}

function norm(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function rowMatchesVehicle(row, vehicle, date) {
  const target = norm(vehicle);
  const keys = weekdayKeys(date);
  const weekdayValues = keys.map((key) => row[key]).filter(Boolean);
  if (weekdayValues.some((value) => norm(value) === target || norm(value).includes(target))) return true;

  return [
    row.carCd,
    row.carNm,
    row.mainCarSeq,
    row.mainCarSeqNm,
    row.carSeq,
    row.carSeqNm,
    row.baecha
  ].filter(Boolean).some((value) => norm(value) === target || norm(value).includes(target));
}

function toStop(row, index) {
  return {
    sequence: index + 1,
    raw: row,
    code: row.estCd || "",
    name: row.estNm || row.estName || "",
    address: row.address || "",
    amount: row.avgOrderAmt || row.orderAmt || row.amt || ""
  };
}

async function fetchFixedDispatchPage(context, { page, date, vehicle, center }) {
  const response = await context.request.post(`${freshonOrigin}/bo/wm/standard/fixedAlctnList`, {
    form: toForm({ page, date, vehicle, center }),
    headers: {
      Accept: "application/json, text/plain, */*",
      Origin: freshonOrigin,
      Referer: config.freshonBaseUrl
    },
    timeout: ROUTE_TIMEOUT_MS
  });

  if (!response.ok()) {
    throw new Error(`fixedAlctnList API failed: ${response.status()} ${response.statusText()}`);
  }
  const json = await response.json();
  if (json.status && Number(json.status) !== 200) {
    throw new Error(json.message || `fixedAlctnList API returned status ${json.status}`);
  }
  return Array.isArray(json.data) ? json.data : [];
}

async function scrapeDailyRouteWithContext(context, { date, vehicle, center = "" }) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await fetchFixedDispatchPage(context, { page, date, vehicle, center });
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const sourceRows = rows.filter((row) => rowMatchesVehicle(row, vehicle, date));
  const stops = sourceRows
    .filter((row) => row.address)
    .map(toStop);

  return {
    generatedAt: new Date().toISOString(),
    source: "freshon-fixed-dispatch-api",
    date,
    vehicle,
    center,
    rowCount: stops.length,
    stops
  };
}

export async function withDailyRouteSession(callback) {
  const { browser, context } = await createLoggedInContext();
  try {
    return await callback((job) => scrapeDailyRouteWithContext(context, job));
  } finally {
    await context.close?.();
    await browser?.close();
  }
}

export async function refreshDailyRouteData({ date, vehicle, center = "" }) {
  return withDailyRouteSession((scrape) => scrape({ date, vehicle, center }));
}
