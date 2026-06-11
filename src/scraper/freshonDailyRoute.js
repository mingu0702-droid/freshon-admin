import { chromium, request } from "playwright";
import { config } from "../config.js";

const PAGE_SIZE = 1000;
const MAX_PAGES = 8;
const ROUTE_TIMEOUT_MS = Math.min(config.navTimeoutMs, 15000);
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

async function createLoggedInContext({ forceLogin = false } = {}) {
  if (config.freshonCookie && !forceLogin) {
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

  await page.goto(`${config.freshonBaseUrl}#/bo/wm/dispatch/dailyDsptcPage`, {
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
    excelFileNm: `daily_dispatch_${date || ""}_${vehicle || ""}`,
    logCd: "011",
    logCdNm: center || "",
    logisticsCenter: center || "",
    logisticsCenterNm: center || "",
    whCd: "",
    centerCd: "",
    baecha: center || "",
    startDate: date || "",
    endDate: date || "",
    inReqDate: date || "",
    enteringDate: date || "",
    reqDate: date || "",
    dlvyReqDate: date || "",
    carSeq: vehicle || "",
    carSeqNm: vehicle || "",
    carCd: vehicle || "",
    carNm: vehicle || "",
    carNo: vehicle || "",
    fixedCarSeq: vehicle || "",
    fixedCarSeqNm: vehicle || "",
    shipGbn: "1",
    shipGbnNm: "night",
    tcYn: "",
    tcGbn: ""
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
    row.fixedCarSeq,
    row.fixedCarSeqNm,
    row.carNo,
    row.carNumber,
    row.vehicle,
    row.baecha
  ].filter(Boolean).some((value) => norm(value) === target || norm(value).includes(target));
}

function toStop(row, index) {
  return {
    sequence: index + 1,
    raw: row,
    code: row.estCd || row.customerCode || row.custCd || row.custCode || row.storeCd || "",
    name: row.estNm || row.estName || row.customerName || row.custNm || row.storeNm || "",
    address: row.address || row.addr || row.dlvyAddr || row.deliveryAddress || row.customerAddress || "",
    vehicle: row.carSeqSunNm || row.carSeqMonNm || row.carSeqTueNm || row.carSeqWedNm || row.carSeqThuNm || row.carSeqFriNm || row.carSeqSatNm || row.carNm || row.mainCarSeqNm || "",
    customerCode: row.estCd || row.customerCode || row.custCd || "",
    customerName: row.estNm || row.estName || row.customerName || row.custNm || "",
    amount: row.avgOrderAmt || row.orderAmt || row.amt || row.saleAmt || "",
    dailyAmount: row.daySaleAmt || row.dailySaleAmt || row.orderAmt || row.amt || "",
    monthlyAmount: row.monthSaleAmt || row.monthlySaleAmt || row.avgOrderAmt || "",
    orderCount: row.orderCnt || row.ordCnt || row.totalAlcnt || row.alcnt || row.count || "",
    deliveryPattern: row.mon || row.tue || row.wed || row.thu || row.fri || row.sat || row.sun || ""
  };
}

function extractRows(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.rows)) return json.rows;
  if (Array.isArray(json?.list)) return json.list;
  if (Array.isArray(json?.result)) return json.result;
  if (Array.isArray(json?.data?.rows)) return json.data.rows;
  if (Array.isArray(json?.data?.list)) return json.data.list;
  if (Array.isArray(json?.result?.rows)) return json.result.rows;
  if (Array.isArray(json?.result?.list)) return json.result.list;
  return [];
}

async function postDailyDispatchPage(api, endpoint, { page, date, vehicle, center }, variant) {
  const form = toForm({ page, date, vehicle, center });
  const params = new URLSearchParams(form);
  const commonHeaders = {
    Accept: "application/json, text/plain, */*",
    Origin: freshonOrigin,
    Referer: `${freshonOrigin}/bo/main#/bo/wm/dispatch/dailyDsptcPage`
  };
  const options = variant === "json"
    ? { data: form, headers: { ...commonHeaders, "Content-Type": "application/json; charset=UTF-8" }, timeout: ROUTE_TIMEOUT_MS }
    : variant === "query"
      ? { headers: commonHeaders, timeout: ROUTE_TIMEOUT_MS }
      : { form, headers: commonHeaders, timeout: ROUTE_TIMEOUT_MS };
  const url = variant === "query" ? `${freshonOrigin}${endpoint}?${params.toString()}` : `${freshonOrigin}${endpoint}`;
  return api.post(url, options);
}

async function fetchDailyDispatchPage(context, { page, date, vehicle, center }) {
  const api = context.request || context;
  const endpoints = [
    "/bo/wm/dispatch/dailyDsptcGridList",
    "/bo/wm/dispatch/dailyDsptcList",
    "/bo/wm/dispatch/dailyDsptc/list",
    "/bo/wm/dispatch/dailyDsptcPage/list",
    "/bo/wm/dispatch/selectDailyDsptcList",
    "/bo/wm/dispatch/dailyDispatchList"
  ];
  const errors = [];
  for (const endpoint of endpoints) {
    for (const variant of ["json", "form", "query"]) {
      const response = await postDailyDispatchPage(api, endpoint, { page, date, vehicle, center }, variant).catch((error) => {
        errors.push(`${endpoint}:${variant}:${error.message || error}`);
        return null;
      });
      if (!response) continue;
      if (!response.ok()) {
        errors.push(`${endpoint}:${variant}:HTTP ${response.status()}`);
        continue;
      }
      const json = await response.json().catch(async () => ({ raw: await response.text().catch(() => "") }));
      const rows = extractRows(json);
      if (rows.length) return rows;
      errors.push(`${endpoint}:${variant}:no rows`);
    }
  }
  throw new Error(`dailyDsptcPage API returned no rows. ${errors.slice(0, 8).join(" / ")}`);
}

async function scrapeDailyRouteWithContext(context, { date, vehicle, center = "" }) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await fetchDailyDispatchPage(context, { page, date, vehicle, center });
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const sourceRows = rows.filter((row) => rowMatchesVehicle(row, vehicle, date));
  const stops = sourceRows
    .filter((row) => row.address)
    .map(toStop);

  return {
    generatedAt: new Date().toISOString(),
    source: "freshon-daily-dispatch-api",
    date,
    vehicle,
    center,
    rowCount: stops.length,
    stops
  };
}

export async function withDailyRouteSession(callback, options = {}) {
  const { browser, context } = await createLoggedInContext(options);
  try {
    return await callback((job) => scrapeDailyRouteWithContext(context, job));
  } finally {
    await context.close?.();
    await browser?.close();
  }
}

export async function refreshDailyRouteData({ date, vehicle, center = "", forceLogin = false }) {
  return withDailyRouteSession((scrape) => scrape({ date, vehicle, center }), { forceLogin });
}
