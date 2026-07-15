import dotenv from "dotenv";

dotenv.config();

function envValue(name, fallback = "") {
  let value = String(process.env[name] ?? fallback).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  freshonBaseUrl: envValue("FRESHON_BASE_URL", "https://mis.freshon.co.kr/bo/main"),
  freshonId: envValue("FRESHON_ID"),
  freshonPassword: envValue("FRESHON_PASSWORD"),
  freshonCookie: envValue("FRESHON_COOKIE"),
  adminToken: process.env.ADMIN_TOKEN || "",
  publicView: String(process.env.PUBLIC_VIEW || "true").toLowerCase() === "true",
  headless: String(process.env.FRESHON_HEADLESS || "true").toLowerCase() !== "false",
  navTimeoutMs: Number(process.env.FRESHON_NAV_TIMEOUT_MS || 60000),
  externalCacheBaseUrl: process.env.EXTERNAL_CACHE_BASE_URL || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  githubRepo: process.env.GITHUB_CACHE_REPO || "",
  githubBranch: process.env.GITHUB_CACHE_BRANCH || "main",
  githubCacheDir: process.env.GITHUB_CACHE_DIR || "freshon-cache",
  excelPassword: process.env.EXCEL_PASSWORD || "minkyu",
  deliveryAdminBaseUrl: envValue("DELIVERY_ADMIN_BASE_URL", "https://delivery-bali.chabyulhwa.com"),
  deliveryAdminId: envValue("DELIVERY_ADMIN_ID"),
  deliveryAdminPassword: envValue("DELIVERY_ADMIN_PASSWORD"),
  deliveryAdminCookie: envValue("DELIVERY_ADMIN_COOKIE"),
  googleSheetId: process.env.GOOGLE_SHEET_ID || "",
  googleSheetName: process.env.GOOGLE_SHEET_NAME || "customers",
  googleServiceAccountJsonBase64: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || "",
  googleDriverSheetId: process.env.GOOGLE_DRIVER_SHEET_ID || "1PKyuviFYRKFO9seAvhEmhnlwxKBjjcrpbkPJnK3tFNc",
  googleDriverSheetName: process.env.GOOGLE_DRIVER_SHEET_NAME || "",
  googleDriverSheetGid: Number(process.env.GOOGLE_DRIVER_SHEET_GID || 1584114128)
};

