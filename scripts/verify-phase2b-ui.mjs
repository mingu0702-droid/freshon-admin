import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const origin = "https://freshon-admin-stage-preview-template.onrender.com";
const output = process.env.PHASE2B_VERIFY_OUTPUT;
if (!output) throw new Error("PHASE2B_VERIFY_OUTPUT is required");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const results = { checkedAt: new Date().toISOString(), errors: [], requests: [], geocode: [], screenshots: [] };
page.on("pageerror", (error) => results.errors.push(error.message));
page.on("response", (response) => {
  const url = new URL(response.url());
  if (url.origin === origin && url.pathname.startsWith("/api/")) results.requests.push({ path: url.pathname, date: url.searchParams.get("date"), status: response.status() });
  if (url.hostname === "dapi.kakao.com" && url.pathname.includes("sdk")) results.kakaoSdk = response.status();
});
page.on("console", (message) => {
  if (message.type() === "error") results.errors.push(message.text().slice(0, 250));
});
async function capture(name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  results.screenshots.push(file);
}
async function measure(label, url) {
  const started = Date.now();
  const response = await page.request.get(origin + url, { timeout: 60000 });
  const data = await response.json().catch(() => null);
  const result = { label, http: response.status(), ms: Date.now() - started, cache: response.headers()["x-phase2b-cache"] || null };
  results.requests.push(result);
  return { ...result, payload: data };
}
try {
  results.pageHttp = (await page.goto(origin + "/map-phase2b-preview.html", { waitUntil: "domcontentloaded", timeout: 60000 })).status();
  await page.waitForFunction(() => !!window.kakaoGeocoder, { timeout: 30000 });
  // Actual public street addresses, sent only to the existing Kakao geocoder.
  const addresses = ["서울 강남구 테헤란로 152", "서울 중구 세종대로 110", "서울 종로구 세종대로 175", "서울 용산구 한강대로 405", "서울 송파구 올림픽로 300", "경기 성남시 분당구 판교역로 166", "경기 수원시 팔달구 효원로 241", "부산 연제구 중앙대로 1001", "대구 중구 공평로 88", "광주 서구 내방로 111"];
  for (const address of addresses) {
    const value = await page.evaluate(async (address) => {
      const attempts = [], started = performance.now();
      for (const query of window.Phase2bUi.addressVariants(address)) {
        const begin = performance.now();
        const rows = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve([]), 7000);
          window.kakaoGeocoder.addressSearch(query, (rows, status) => { clearTimeout(timer); resolve(status === kakao.maps.services.Status.OK ? rows : []); });
        });
        const matches = rows.filter((row) => window.Phase2bUi.addressMatches(query, row.road_address?.address_name || row.address_name) || window.Phase2bUi.addressMatches(query, row.address?.address_name || ""));
        attempts.push({ ms: Math.round(performance.now() - begin), candidates: rows.length, exact: matches.length });
        if (matches.length === 1) return { address, ok: true, ms: Math.round(performance.now() - started), attempts };
      }
      return { address, ok: false, ms: Math.round(performance.now() - started), attempts };
    }, address);
    results.geocode.push(value);
    console.log(JSON.stringify({ geocode: results.geocode.length, ...value }));
  }
  await page.locator("#selectedDate").fill("2026-08-11");
  await page.locator("#selectedDate").dispatchEvent("change");
  await page.waitForFunction(() => /실제 배송 편성|기준일 조회 실패/.test(document.querySelector("#freshnessState").textContent), { timeout: 120000 });
  results.datedStatus = await page.locator("#freshnessState").textContent();
  await page.locator("#operationVehicle").selectOption("101");
  await page.waitForFunction(() => document.querySelector("#opTotal").textContent !== "-", { timeout: 60000 }).catch(() => {});
  results.historical = await page.locator("#operationBar").innerText();
  const before = await page.locator("#map").screenshot();
  const markerCount = await page.locator(".marker.storeDot").count();
  await page.locator("#areaToggle").click();
  results.boundaryOff = { before: markerCount, after: await page.locator(".marker.storeDot").count(), date: await page.locator("#selectedDate").inputValue(), vehicle: await page.locator("#operationVehicle").inputValue() };
  await page.locator("#areaToggle").click();
  results.boundaryRoundTripPixelsUnchanged = before.equals(await page.locator("#map").screenshot());
  await page.locator("#query").fill("S222538");
  await page.locator("#searchBtn").click();
  await page.locator("#detailSection.open").waitFor({ timeout: 60000 }).catch(() => {});
  results.search = await page.locator("#searchState").innerText();
  results.popup = { open: await page.locator("#detailSection.open").count(), width: (await page.locator("#detailSection").boundingBox())?.width, text: (await page.locator("#detail .code").textContent().catch(() => "")) };
  await capture("pc-1440");
  for (const [width, height] of [[390, 844], [412, 915]]) {
    await page.setViewportSize({ width, height });
    results[`mobile${width}`] = await page.evaluate(() => ({ noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth, bar: document.querySelector("#operationBar").getBoundingClientRect().toJSON() }));
    await capture(`mobile-${width}`);
  }
  const route = await measure("route-cold", "/api/map-phase2b/preview/route-plan?date=2026-08-11&vehicle=101");
  results.route = { http: route.http, total: route.payload?.data?.totalStops, completed: route.payload?.data?.completedStops, remaining: route.payload?.data?.remainingStops };
  await measure("route-warm", "/api/map-phase2b/preview/route-plan?date=2026-08-11&vehicle=101");
  const detail = await measure("detail-cold", "/api/map-phase2b/preview/detail?customerCode=S222538");
  results.detail = { http: detail.http, code: detail.payload?.data?.customerCode, accessInfoPresent: !!detail.payload?.data?.accessInfo, passwordPresent: !!detail.payload?.data?.password, forbiddenFields: Object.keys(detail.payload?.data || {}).filter((key) => /ownerPhone|claim/i.test(key)) };
  await measure("detail-warm", "/api/map-phase2b/preview/detail?customerCode=S222538");
  await measure("bounds-cold", "/api/map-phase2b/preview/bounds?mode=BASE_90D&vehicle=&south=36.8&west=126.8&north=37.3&east=127.3");
  await measure("bounds-warm", "/api/map-phase2b/preview/bounds?mode=BASE_90D&vehicle=&south=36.8&west=126.8&north=37.3&east=127.3");
  results.dailyRoutesHttp = (await page.request.get(origin + "/daily-routes.html")).status();
} catch (error) { results.fatal = error.message; }
finally {
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
