import { chromium } from "playwright";
import { config } from "../config.js";

const ROUTE_TIMEOUT_MS = Math.min(config.navTimeoutMs, 25000);

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

async function clickText(page, texts) {
  for (const text of texts) {
    const target = page.getByText(text, { exact: false }).first();
    if (await target.count()) {
      const clicked = await target.click({ timeout: 4000 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }
  }
  return false;
}

async function maybeLogin(page) {
  const idFilled = await fillFirstVisible(page, [
    "input[name='id']",
    "input[name='userId']",
    "input[name='loginId']",
    "input[type='text']",
    "input[placeholder*='아이디']",
    "input[placeholder*='ID']"
  ], config.freshonId);

  const pwFilled = await fillFirstVisible(page, [
    "input[name='password']",
    "input[name='passwd']",
    "input[type='password']",
    "input[placeholder*='비밀번호']",
    "input[placeholder*='Password']"
  ], config.freshonPassword);

  if (idFilled && pwFilled) {
    await Promise.allSettled([
      page.waitForLoadState("domcontentloaded", { timeout: ROUTE_TIMEOUT_MS }),
      clickText(page, ["로그인", "Login"])
    ]);
  }
}

async function navigateToFixedDispatch(page) {
  page.setDefaultTimeout(ROUTE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(ROUTE_TIMEOUT_MS);

  await page.goto(`${config.freshonBaseUrl}#/bo/wm/standard/driverCarListPage`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await maybeLogin(page);
  await page.goto(`${config.freshonBaseUrl}#/bo/wm/standard/driverCarListPage`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await page.waitForLoadState("domcontentloaded", { timeout: ROUTE_TIMEOUT_MS }).catch(() => null);
}

async function fillByNearbyLabel(page, labels, value) {
  for (const label of labels) {
    const input = page.locator(`xpath=//*[contains(normalize-space(.), '${label}')]/following::input[1]`).first();
    if (await input.count()) {
      await input.fill(value).catch(() => null);
      return true;
    }
  }
  return false;
}

async function selectCenterIfPresent(page, center) {
  if (!center) return;
  const selects = await page.locator("select").all();
  for (const select of selects) {
    const ok = await select.selectOption({ label: center }).then(() => true).catch(() => false);
    if (ok) return;
  }
  await clickText(page, [center]);
}

async function setFilters(page, { date, vehicle, center }) {
  await selectCenterIfPresent(page, center);
  await fillByNearbyLabel(page, ["등록일", "일자"], date);
  await fillByNearbyLabel(page, ["호차"], vehicle);
  await fillFirstVisible(page, [
    "input[name*='car']",
    "input[name*='vehicle']",
    "input[id*='car']",
    "input[id*='vehicle']"
  ], vehicle);
}

async function clickSearch(page) {
  await clickText(page, ["조회", "검색", "Search"]);
  await page.waitForLoadState("domcontentloaded", { timeout: ROUTE_TIMEOUT_MS }).catch(() => null);
  await page.waitForTimeout(1200);
}

async function extractGridRows(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const rowsFromTable = [...document.querySelectorAll("table")].flatMap((table) =>
      [...table.querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("th,td")].map((cell) => clean(cell.innerText))
      )
    );

    const rowsFromGrid = [...document.querySelectorAll("[role='row'], .ag-row, .el-table__row, .ant-table-row, .dx-row")]
      .map((row) => [...row.querySelectorAll("[role='gridcell'], .ag-cell, td, .cell")]
        .map((cell) => clean(cell.innerText))
        .filter(Boolean))
      .filter((row) => row.length > 1);

    return [...rowsFromTable, ...rowsFromGrid].filter((row) => row.some(Boolean));
  });
}

function toStops(rows) {
  return rows
    .filter((row) => row.length >= 3)
    .map((row, index) => {
      const text = row.join(" ");
      const sequenceMatch = text.match(/\b(\d{1,3})\b/);
      return {
        sequence: sequenceMatch ? Number(sequenceMatch[1]) : index + 1,
        raw: row,
        code: row.find((cell) => /^[A-Z]?\d{4,}/.test(cell)) || "",
        name: row.find((cell) => /[가-힣]/.test(cell) && !/(시|군|구|동|읍|면|로|길)/.test(cell.slice(0, 8))) || row[0] || "",
        address: row.find((cell) => /(서울|경기|인천|강원|충북|충남|전북|전남|경북|경남|부산|대구|광주|대전|울산|세종|제주).+/.test(cell)) || ""
      };
    })
    .sort((a, b) => a.sequence - b.sequence);
}

async function scrapeDailyRouteOnPage(page, { date, vehicle, center = "" }) {
  if (!date || !vehicle) {
    throw new Error("date and vehicle are required.");
  }

  await setFilters(page, { date, vehicle, center });
  await clickSearch(page);

  const rows = await extractGridRows(page);
  const stops = toStops(rows);
  return {
    generatedAt: new Date().toISOString(),
    source: "freshon",
    date,
    vehicle,
    center,
    rowCount: stops.length,
    stops
  };
}

export async function withDailyRouteSession(callback) {
  assertCredentials();
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();
  try {
    await navigateToFixedDispatch(page);
    return await callback((job) => scrapeDailyRouteOnPage(page, job));
  } finally {
    await browser.close();
  }
}

export async function refreshDailyRouteData({ date, vehicle, center = "" }) {
  return withDailyRouteSession((scrape) => scrape({ date, vehicle, center }));
}
