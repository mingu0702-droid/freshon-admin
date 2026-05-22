import fs from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve("data");
const dispatchFile = path.join(dataDir, "fixed-dispatch.json");
const dailyRouteFile = path.join(dataDir, "daily-routes.json");

export async function readDispatchCache() {
  try {
    const text = await fs.readFile(dispatchFile, "utf8");
    return JSON.parse(text);
  } catch {
    return {
      generatedAt: null,
      source: "freshon",
      range: null,
      rows: [],
      columns: [],
      warning: "아직 고정배차 캐시가 없습니다. 관리 토큰 저장 후 고정배차 갱신을 눌러주세요."
    };
  }
}

export async function writeDispatchCache(payload) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${dispatchFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, dispatchFile);
}

export async function readDailyRouteCache() {
  try {
    const text = await fs.readFile(dailyRouteFile, "utf8");
    return JSON.parse(text);
  } catch {
    return { generatedAt: null, routes: {} };
  }
}

export async function readDailyRoute(date, vehicle) {
  const cache = await readDailyRouteCache();
  return cache.routes?.[date]?.[vehicle] || null;
}

export async function writeDailyRoute(payload) {
  const cache = await readDailyRouteCache();
  const date = payload.date;
  const vehicle = payload.vehicle;
  cache.generatedAt = new Date().toISOString();
  cache.routes ||= {};
  cache.routes[date] ||= {};
  cache.routes[date][vehicle] = payload;

  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${dailyRouteFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await fs.rename(tmp, dailyRouteFile);
}
