import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  freshonBaseUrl: process.env.FRESHON_BASE_URL || "https://mis.freshon.co.kr/bo/main",
  freshonId: process.env.FRESHON_ID || "",
  freshonPassword: process.env.FRESHON_PASSWORD || "",
  freshonCookie: process.env.FRESHON_COOKIE || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  publicView: String(process.env.PUBLIC_VIEW || "true").toLowerCase() === "true",
  headless: String(process.env.FRESHON_HEADLESS || "true").toLowerCase() !== "false",
  navTimeoutMs: Number(process.env.FRESHON_NAV_TIMEOUT_MS || 60000),
  externalCacheBaseUrl: process.env.EXTERNAL_CACHE_BASE_URL || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  githubRepo: process.env.GITHUB_CACHE_REPO || "",
  githubBranch: process.env.GITHUB_CACHE_BRANCH || "main",
  githubCacheDir: process.env.GITHUB_CACHE_DIR || "freshon-cache"
};
