import { chromium, request } from "playwright";
import { config } from "../config.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 8;
const API_TIMEOUT_MS = Math.min(config.navTimeoutMs, 15000);
const NAV_TIMEOUT_MS = Math.min(Math.max(config.navTimeoutMs, 45000), 90000);
const freshonOrigin = new URL(config.freshonBaseUrl).origin;
let freshonLoginPromise = null;
let freshonMemoryCookie = config.freshonCookie || "";

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
  const passwordInput = page.locator("input[type='password']").first();
  if (!(await passwordInput.isVisible().catch(() => false))) {
    await page.goto(`${freshonOrigin}/login`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS
    });
  }

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

  if (!idFilled || !pwFilled) return { attempted: false, status: null };

  const submit = page.locator("#btn_login, button[type='submit'], input[type='submit'], button").first();
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST", { timeout: API_TIMEOUT_MS }).catch(() => null);
  if (await submit.count()) {
    await Promise.allSettled([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: API_TIMEOUT_MS }),
      submit.click({ timeout: 4000 })
    ]);
  } else {
    await page.keyboard.press("Enter").catch(() => null);
    await page.waitForLoadState("domcontentloaded", { timeout: API_TIMEOUT_MS }).catch(() => null);
  }
  const response = await responsePromise;
  return { attempted: true, status: response?.status() || null };
}

function serializeCookies(cookies) {
  return (cookies || []).filter((cookie) => cookie?.name && cookie?.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function loginFreshonSession() {
  if (freshonLoginPromise) return freshonLoginPromise;
  freshonLoginPromise = (async () => {
    assertCredentials();
    const browser = await chromium.launch({ headless: config.headless });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(API_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      await page.goto(config.freshonBaseUrl, { waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
      const login = await maybeLogin(page);
      await page.waitForLoadState("domcontentloaded", { timeout: API_TIMEOUT_MS }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: API_TIMEOUT_MS }).catch(() => null);
      const passwordStillVisible = await page.locator("input[type='password']").first().isVisible().catch(() => false);
      const loginPageStillOpen = new URL(page.url()).pathname.startsWith("/login");
      const cookies = await context.cookies(freshonOrigin);
      const cookie = serializeCookies(cookies);
      if (!login.attempted) throw new Error("Freshon login form was not detected.");
      if (passwordStillVisible || loginPageStillOpen) throw new Error(`Freshon login was rejected (status ${login.status || "unknown"}).`);
      if (!cookie) throw new Error("Freshon login returned no session cookie.");
      freshonMemoryCookie = cookie;
      return { cookie, loginStatus: login.status, cookieCount: cookies.length };
    } finally {
      await browser.close().catch(() => null);
    }
  })();
  try {
    return await freshonLoginPromise;
  } finally {
    freshonLoginPromise = null;
  }
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return null;
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim()
      };
    })
    .filter((item) => item?.name && item.value);
}

async function seedFreshonCookies(context) {
  const cookies = parseCookieHeader(freshonMemoryCookie || config.freshonCookie);
  if (!cookies.length) return;
  await context.addCookies(cookies.map((cookie) => ({
    ...cookie,
    domain: "mis.freshon.co.kr",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax"
  }))).catch(() => null);
}

async function createLoggedInContext({ forceLogin = false } = {}) {
  if (forceLogin) await loginFreshonSession();
  const sessionCookie = freshonMemoryCookie || config.freshonCookie;
  if (sessionCookie) {
    const context = await request.newContext({
      baseURL: freshonOrigin,
      extraHTTPHeaders: {
        Accept: "application/json, text/plain, */*",
        Cookie: sessionCookie,
        Origin: freshonOrigin,
        Referer: config.freshonBaseUrl
      }
    });
    return { browser: null, context };
  }

  assertCredentials();
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  await seedFreshonCookies(context);
  const page = await context.newPage();
  page.setDefaultTimeout(API_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  await page.goto(config.freshonBaseUrl, {
    waitUntil: "commit",
    timeout: NAV_TIMEOUT_MS
  });
  await maybeLogin(page);
  await page.goto(`${config.freshonBaseUrl}#/bo/wm/dispatch/dailyDsptcPage`, {
    waitUntil: "commit",
    timeout: NAV_TIMEOUT_MS
  }).catch(() => null);
  await page.waitForLoadState("domcontentloaded", { timeout: API_TIMEOUT_MS }).catch(() => null);
  return { browser, context, page };
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

function toForm({ page, date, vehicle, center, inDate = date, shipGbn = "1", logCd = "011", vehicleFilter = vehicle }) {
  const carValue = vehicleFilter || "";
  return {
    page: String(page),
    isPaging: "false",
    isCount: "true",
    size: String(PAGE_SIZE),
    sort: ",ASC",
    excelFileNm: `일일배차 내역_${compactDate(date)}`,
    sqlType: "LOTSIM003_P01",
    logCd,
    inDate: inDate || "",
    closeTrans: "2",
    logCdNm: center || "",
    logisticsCenter: center || "",
    logisticsCenterNm: center || "",
    whCd: "",
    centerCd: "",
    baecha: center || "",
    startDate: inDate || "",
    endDate: inDate || "",
    inReqDate: inDate || "",
    enteringDate: inDate || "",
    reqDate: inDate || "",
    dlvyReqDate: inDate || "",
    carSeq: carValue,
    carSeqNm: carValue,
    carCd: carValue,
    carNm: carValue,
    carNo: carValue,
    fixedCarSeq: carValue,
    fixedCarSeqNm: carValue,
    shipGbn,
    shipGbnNm: shipGbn === "1" ? "night" : "",
    estCd: "",
    estName: "",
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
    ton: row.carTonNm || row.carTon || "",
    driverName: row.driverName || row.driverNm || "",
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
  const form = toForm({
    page,
    date,
    vehicle,
    center,
    inDate: variant.inDate || date,
    shipGbn: variant.shipGbn,
    logCd: variant.logCd,
    vehicleFilter: variant.vehicleFilter
  });
  const params = new URLSearchParams(form);
  const commonHeaders = {
    Accept: "application/json, text/plain, */*",
    Origin: freshonOrigin,
    Referer: `${freshonOrigin}/bo/main#/bo/wm/dispatch/dailyDsptcPage`
  };
  const options = variant.type === "json"
    ? { data: form, headers: { ...commonHeaders, "Content-Type": "application/json; charset=UTF-8" }, timeout: API_TIMEOUT_MS }
    : variant.type === "query"
      ? { headers: commonHeaders, timeout: API_TIMEOUT_MS }
      : { form, headers: commonHeaders, timeout: API_TIMEOUT_MS };
  const url = variant.type === "query" ? `${freshonOrigin}${endpoint}?${params.toString()}` : `${freshonOrigin}${endpoint}`;
  if (api && typeof api.evaluate === "function") {
    const result = await api.evaluate(async ({ url, form, paramsText, headers, variantType }) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: variantType === "json" ? JSON.stringify(form) : paramsText
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text()
      };
    }, {
      url,
      form,
      paramsText: params.toString(),
      headers: options.headers || commonHeaders,
      variantType: variant.type
    });
    return {
      ok: () => result.ok,
      status: () => result.status,
      json: async () => JSON.parse(result.text),
      text: async () => result.text
    };
  }
  return api.post(url, options);
}

async function fetchDailyDispatchPage(context, { page, date, vehicle, center }) {
  const api = typeof context.evaluate === "function" ? context : context.request || context;
  const endpoints = [
    "/bo/wm/dispatch/dailyDsptcGrid1List",
    "/bo/wm/dispatch/dailyDsptcGridList",
    "/bo/wm/dispatch/dailyDsptcList",
    "/bo/wm/dispatch/dailyDsptc/list",
    "/bo/wm/dispatch/dailyDsptcPage/list",
    "/bo/wm/dispatch/selectDailyDsptcList",
    "/bo/wm/dispatch/dailyDispatchList"
  ];
  const errors = [];
  const variants = [...new Set([date, addDays(date, 1)].filter(Boolean))]
    .flatMap((inDate) => [
      { inDate, shipGbn: "", logCd: "011" },
      { inDate, shipGbn: "1", logCd: "011" },
      { inDate, shipGbn: "", logCd: "" },
      { inDate, shipGbn: "1", logCd: "" }
    ])
    .flatMap((base) => [
      { ...base, vehicleFilter: vehicle },
      { ...base, vehicleFilter: "" }
    ])
    .flatMap((base) => [
      { ...base, type: "form", label: `form:${base.inDate}:ship${base.shipGbn || "all"}:log${base.logCd || "all"}:${base.vehicleFilter ? "car" : "allcar"}` },
      { ...base, type: "json", label: `json:${base.inDate}:ship${base.shipGbn || "all"}:log${base.logCd || "all"}:${base.vehicleFilter ? "car" : "allcar"}` }
    ]);
  for (const endpoint of endpoints) {
    for (const variant of variants) {
      const response = await postDailyDispatchPage(api, endpoint, { page, date, vehicle, center }, variant).catch((error) => {
        errors.push(`${endpoint}:${variant.label}:${error.message || error}`);
        return null;
      });
      if (!response) continue;
      if (!response.ok()) {
        errors.push(`${endpoint}:${variant.label}:HTTP ${response.status()}`);
        continue;
      }
      const json = await response.json().catch(async () => ({ raw: await response.text().catch(() => "") }));
      const rows = extractRows(json);
      if (rows.length) return rows;
      errors.push(`${endpoint}:${variant.label}:no rows`);
    }
  }
  const triedDates = [...new Set(variants.map((variant) => variant.inDate).filter(Boolean))].join(", ");
  throw new Error(`dailyDsptcPage API returned no rows for date=${date}, vehicle=${vehicle}, tried inDate=${triedDates}, shipGbn=all/1, logCd=011/all, carSeq=selected/all. ${errors.slice(0, 8).join(" / ")}`);
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
    .filter((row) => row.estCd || row.estName || row.customerCode || row.customerName || row.address)
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
  const { browser, context, page } = await createLoggedInContext(options);
  try {
    return await callback((job) => scrapeDailyRouteWithContext(page || context, job));
  } finally {
    await context.close?.();
    await browser?.close();
  }
}

export async function refreshDailyRouteData({ date, vehicle, center = "", forceLogin = false }) {
  return withDailyRouteSession((scrape) => scrape({ date, vehicle, center }), { forceLogin });
}
