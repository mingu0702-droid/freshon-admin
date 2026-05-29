import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const dataDir = path.resolve("data");
const dispatchFile = path.join(dataDir, "fixed-dispatch.json");
const dailyRouteFile = path.join(dataDir, "daily-routes.json");

function externalPath(fileName) {
  return `${config.githubCacheDir.replace(/^\/+|\/+$/g, "")}/${fileName}`;
}

async function readLocalJson(file, fallback) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeLocalJson(file, payload) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
  await fs.rename(tmp, file);
}

async function readExternalJson(fileName) {
  if (config.externalCacheBaseUrl) {
    const url = `${config.externalCacheBaseUrl.replace(/\/+$/g, "")}/${fileName}`;
    const response = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (response?.ok) return response.json();
  }

  if (!config.githubToken || !config.githubRepo) return null;
  const rawUrl = `https://raw.githubusercontent.com/${config.githubRepo}/${encodeURIComponent(config.githubBranch)}/${externalPath(fileName)}`;
  const rawResponse = await fetch(rawUrl, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "freshon-admin-cache"
    }
  }).catch(() => null);
  if (rawResponse?.ok) {
    return rawResponse.json();
  }

  const url = `https://api.github.com/repos/${config.githubRepo}/contents/${externalPath(fileName)}?ref=${encodeURIComponent(config.githubBranch)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "freshon-admin-cache"
    }
  }).catch(() => null);
  if (!response?.ok) return null;

  const json = await response.json();
  if (json.download_url) {
    const downloadResponse = await fetch(json.download_url, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        "User-Agent": "freshon-admin-cache"
      }
    }).catch(() => null);
    if (downloadResponse?.ok) return downloadResponse.json();
  }
  if (!json.content) return null;
  return JSON.parse(Buffer.from(json.content, "base64").toString("utf8"));
}

async function getGithubSha(fileName) {
  if (!config.githubToken || !config.githubRepo) return null;
  const url = `https://api.github.com/repos/${config.githubRepo}/contents/${externalPath(fileName)}?ref=${encodeURIComponent(config.githubBranch)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "freshon-admin-cache"
    }
  }).catch(() => null);
  if (!response?.ok) return null;
  const json = await response.json();
  return json.sha || null;
}

async function writeExternalJson(fileName, payload) {
  if (!config.githubToken || !config.githubRepo) return;
  const sha = await getGithubSha(fileName);
  const url = `https://api.github.com/repos/${config.githubRepo}/contents/${externalPath(fileName)}`;
  const body = {
    message: `Update Freshon cache ${fileName}`,
    branch: config.githubBranch,
    content: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
  };
  if (sha) body.sha = sha;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "freshon-admin-cache"
    },
    body: JSON.stringify(body)
  }).catch(() => null);

  if (!response?.ok) {
    const text = await response?.text().catch(() => "");
    console.warn(`External cache write failed for ${fileName}: ${response?.status || "network"} ${text}`);
  }
}

async function readCache(fileName, file, fallback) {
  const external = await readExternalJson(fileName).catch(() => null);
  if (external) {
    await writeLocalJson(file, external).catch(() => null);
    return external;
  }
  return readLocalJson(file, fallback);
}

async function writeCache(fileName, file, payload) {
  await writeLocalJson(file, payload);
  await writeExternalJson(fileName, payload).catch((error) => {
    console.warn(`External cache write failed for ${fileName}: ${error.message}`);
  });
}

export async function readDispatchCache() {
  return readCache("fixed-dispatch.json", dispatchFile, {
    generatedAt: null,
    source: "freshon",
    range: null,
    rows: [],
    columns: [],
    warning: "아직 고정배차 캐시가 없습니다. 관리 토큰 저장 후 고정배차 갱신을 눌러주세요."
  });
}

export async function writeDispatchCache(payload) {
  await writeCache("fixed-dispatch.json", dispatchFile, payload);
}

export async function clearDailyRouteCache(reason = "fixed dispatch cache updated") {
  await writeCache("daily-routes.json", dailyRouteFile, {
    generatedAt: new Date().toISOString(),
    routes: {},
    invalidatedReason: reason
  });
}

export async function readDailyRouteCache() {
  return readCache("daily-routes.json", dailyRouteFile, { generatedAt: null, routes: {} });
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
  await writeCache("daily-routes.json", dailyRouteFile, cache);
}
