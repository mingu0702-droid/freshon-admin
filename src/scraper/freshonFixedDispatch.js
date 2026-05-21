import { chromium } from "playwright";
import { config } from "../config.js";
import { getDefaultDispatchRange } from "../dateRange.js";

function assertCredentials() {
  if (!config.freshonId || !config.freshonPassword) {
    throw new Error("FRESHON_ID and FRESHON_PASSWORD must be configured as environment variables.");
  }
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (await locator.count()) {
      const first = locator.first();
      if (await first.isVisible().catch(() => false)) {
        await first.fill(value);
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
      await target.click({ timeout: 5000 }).catch(() => null);
      return true;
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
      page.waitForLoadState("networkidle", { timeout: config.navTimeoutMs }),
      clickText(page, ["로그인", "Login"])
    ]);
  }
}

async function navigateToFixedDispatch(page) {
  await page.goto(`${config.freshonBaseUrl}#/bo/wm/standard/driverCarListPage`, {
    waitUntil: "domcontentloaded",
    timeout: config.navTimeoutMs
  });
  await maybeLogin(page);

  await page.goto(`${config.freshonBaseUrl}#/bo/wm/standard/driverCarListPage`, {
    waitUntil: "domcontentloaded",
    timeout: config.navTimeoutMs
  });

  await page.waitForLoadState("networkidle", { timeout: config.navTimeoutMs }).catch(() => null);

  await clickText(page, ["물류관리"]);
  await clickText(page, ["기준정보 관리", "기준정보관리"]);
  await clickText(page, ["고정배차 정보 관리", "고정배차정보관리"]);
}

async function setDateRangeIfPresent(page, range) {
  const inputs = await page.locator("input").all();
  for (const input of inputs) {
    const placeholder = await input.getAttribute("placeholder").catch(() => "");
    const name = await input.getAttribute("name").catch(() => "");
    const id = await input.getAttribute("id").catch(() => "");
    const hint = `${placeholder || ""} ${name || ""} ${id || ""}`;
    if (/시작|from|start/i.test(hint)) {
      await input.fill(range.startDate).catch(() => null);
    }
    if (/종료|to|end/i.test(hint)) {
      await input.fill(range.endDate).catch(() => null);
    }
  }
}

async function clickSearch(page) {
  await clickText(page, ["조회", "검색", "Search"]);
  await page.waitForLoadState("networkidle", { timeout: config.navTimeoutMs }).catch(() => null);
  await page.waitForTimeout(1500);
}

async function extractTables(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")];
    return tables.map((table) => {
      const rows = [...table.querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("th,td")].map((cell) => cell.innerText.trim())
      ).filter((row) => row.some(Boolean));
      return rows;
    }).filter((rows) => rows.length);
  });
}

function tableToObjects(table) {
  if (!table.length) return { columns: [], rows: [] };
  const [header, ...body] = table;
  const columns = header.map((name, index) => name || `column_${index + 1}`);
  const rows = body.map((line) => Object.fromEntries(columns.map((column, index) => [column, line[index] || ""])));
  return { columns, rows };
}

export async function refreshFixedDispatchData(options = {}) {
  assertCredentials();
  const range = options.range || getDefaultDispatchRange();
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();

  try {
    await navigateToFixedDispatch(page);
    await setDateRangeIfPresent(page, range);
    await clickSearch(page);

    const tables = await extractTables(page);
    if (!tables.length) {
      throw new Error("No table data was found on the Freshon fixed-dispatch page. Selectors may need tuning.");
    }

    const largest = tables.sort((a, b) => b.length - a.length)[0];
    const parsed = tableToObjects(largest);
    return {
      generatedAt: new Date().toISOString(),
      source: "freshon",
      range,
      columns: parsed.columns,
      rows: parsed.rows,
      rowCount: parsed.rows.length
    };
  } finally {
    await browser.close();
  }
}
