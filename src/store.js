import fs from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve("data");
const dispatchFile = path.join(dataDir, "fixed-dispatch.json");

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
      warning: "No cached data yet. Run refresh after configuring Freshon credentials."
    };
  }
}

export async function writeDispatchCache(payload) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${dispatchFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, dispatchFile);
}
