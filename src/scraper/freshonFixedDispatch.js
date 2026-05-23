import { chromium, request } from "playwright";
import { config } from "../config.js";
import { getDefaultDispatchRange } from "../dateRange.js";

const PAGE_SIZE = 1000;
const MAX_PAGES = 120;
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

async function clickText(page, texts) {
  for (const text of texts) {
    const target = page.getByText(text, { exact: false }).first();
    if (await target.count()) {
      const clicked = await target.click({ timeout: 5000 }).then(() => true).catch(() => false);
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
      page.waitForLoadState("domcontentloaded", { timeout: config.navTimeoutMs }),
      clickText(page, ["로그인", "Login"])
    ]);
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

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();
  await page.goto(`${config.freshonBaseUrl}#/bo/wm/standard/driverCarListPage`, {
    waitUntil: "domcontentloaded",
    timeout: config.navTimeoutMs
  });
  await maybeLogin(page);
  await page.waitForLoadState("domcontentloaded", { timeout: config.navTimeoutMs }).catch(() => null);
  return { browser, context: page.context() };
}

function toForm({ page, range }) {
  return {
    page: String(page),
    isPaging: "true",
    isCount: "true",
    size: String(PAGE_SIZE),
    sort: "est_cd,ASC",
    excelFileNm: `고정배차정보 내역_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`,
    logCd: "011",
    estCd: "",
    estName: "",
    estNm: "",
    estGbn: "",
    startDate: range?.startDate || "",
    endDate: range?.endDate || "",
    carCd: "",
    carNm: "",
    shipGbn: "1",
    baecha: ""
  };
}

function normalizeRow(row) {
  return {
    호차코드: row.carCd || "",
    호차: row.carSeqSunNm || row.carSeqMonNm || row.carSeqTueNm || row.carSeqWedNm || row.carSeqThuNm || row.carSeqFriNm || row.carSeqSatNm || row.carNm || "",
    고객코드: row.estCd || "",
    고객명: row.estNm || row.estName || "",
    주소: row.address || "",
    사업자번호: row.bizNo || "",
    배송구분: row.estGbnNm || row.shipGbnNm || "",
    담당자: row.employeeName || "",
    월: row.mon || row.carSeqMonNm || "",
    화: row.tue || row.carSeqTueNm || "",
    수: row.wed || row.carSeqWedNm || "",
    목: row.thu || row.carSeqThuNm || "",
    금: row.fri || row.carSeqFriNm || "",
    토: row.sat || row.carSeqSatNm || "",
    일: row.sun || row.carSeqSunNm || "",
    원본: JSON.stringify(row)
  };
}

async function fetchFixedDispatchPage(context, { page, range }) {
  const api = context.request || context;
  const response = await api.post(`${freshonOrigin}/bo/wm/standard/fixedAlctnList`, {
    form: toForm({ page, range }),
    headers: {
      Accept: "application/json, text/plain, */*",
      Origin: freshonOrigin,
      Referer: config.freshonBaseUrl
    },
    timeout: config.navTimeoutMs
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

export async function refreshFixedDispatchData(options = {}) {
  assertCredentials();
  const range = options.range || getDefaultDispatchRange();
  const { browser, context } = await createLoggedInContext();

  try {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await fetchFixedDispatchPage(context, { page, range });
      rows.push(...batch.map(normalizeRow));
      if (batch.length < PAGE_SIZE) break;
    }

    return {
      generatedAt: new Date().toISOString(),
      source: "freshon-api",
      range,
      columns: [
        "호차코드", "호차", "고객코드", "고객명", "주소", "사업자번호", "배송구분",
        "담당자", "월", "화", "수", "목", "금", "토", "일", "원본"
      ],
      rows,
      rowCount: rows.length
    };
  } finally {
    await context.close?.();
    await browser?.close();
  }
}
