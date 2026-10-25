import v8 from "node:v8";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

const startedAt = Date.now();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

const gc = {
  count: 0,
  durationMs: 0,
  minor: { count: 0, durationMs: 0 },
  major: { count: 0, durationMs: 0 },
  incremental: { count: 0, durationMs: 0 },
  weakcb: { count: 0, durationMs: 0 }
};
const gcNames = new Map([
  [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
  [constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, "weakcb"]
]);
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const name = gcNames.get(entry.detail?.kind ?? entry.kind);
    gc.count += 1;
    gc.durationMs += entry.duration;
    if (name) {
      gc[name].count += 1;
      gc[name].durationMs += entry.duration;
    }
  }
});
gcObserver.observe({ entryTypes: ["gc"] });

const requests = new Map();
function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

export function recordRequest(pathname, durationMs, statusCode) {
  const key = String(pathname || "/").split("?")[0];
  const item = requests.get(key) || { count: 0, errors: 0, durations: [] };
  item.count += 1;
  if (statusCode >= 500) item.errors += 1;
  item.durations.push(Number(durationMs.toFixed(2)));
  if (item.durations.length > 500) item.durations.shift();
  requests.set(key, item);
}

export function runtimeSnapshot(extra = {}) {
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const spaces = Object.fromEntries(v8.getHeapSpaceStatistics().map((space) => [
    space.space_name,
    {
      size: space.space_size,
      used: space.space_used_size,
      available: space.space_available_size,
      physical: space.physical_space_size
    }
  ]));
  const requestStats = Object.fromEntries([...requests.entries()].map(([key, value]) => [
    key,
    {
      count: value.count,
      errors: value.errors,
      minMs: value.durations.length ? Math.min(...value.durations) : 0,
      avgMs: value.durations.length
        ? Number((value.durations.reduce((sum, current) => sum + current, 0) / value.durations.length).toFixed(2))
        : 0,
      p50Ms: percentile(value.durations, 0.5),
      p95Ms: percentile(value.durations, 0.95),
      p99Ms: percentile(value.durations, 0.99),
      maxMs: value.durations.length ? Math.max(...value.durations) : 0
    }
  ]));
  return {
    generatedAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    memory,
    heap: {
      heapSizeLimit: heap.heap_size_limit,
      totalAvailableSize: heap.total_available_size,
      mallocedMemory: heap.malloced_memory,
      externalMemory: heap.external_memory
    },
    spaces,
    gc: {
      count: gc.count,
      durationMs: Number(gc.durationMs.toFixed(2)),
      minor: { ...gc.minor, durationMs: Number(gc.minor.durationMs.toFixed(2)) },
      major: { ...gc.major, durationMs: Number(gc.major.durationMs.toFixed(2)) },
      incremental: { ...gc.incremental, durationMs: Number(gc.incremental.durationMs.toFixed(2)) },
      weakcb: { ...gc.weakcb, durationMs: Number(gc.weakcb.durationMs.toFixed(2)) }
    },
    eventLoop: {
      minMs: Number((eventLoop.min / 1e6).toFixed(2)),
      meanMs: Number((eventLoop.mean / 1e6).toFixed(2)),
      p95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
      p99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(2)),
      maxMs: Number((eventLoop.max / 1e6).toFixed(2))
    },
    requests: requestStats,
    ...extra
  };
}
