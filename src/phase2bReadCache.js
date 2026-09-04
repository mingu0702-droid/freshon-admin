function estimateBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch (_) { return 0; }
}

export function createPhase2bReadCache({ name, ttlMs, staleMs, maxEntries, maxBytes, now = () => Date.now() }) {
  const entries = new Map();
  const inFlight = new Map();
  let bytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(key);
  }

  function cleanup() {
    const time = now();
    for (const [key, entry] of entries) if (entry.staleUntil <= time) remove(key);
    while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
  }

  function save(key, value) {
    remove(key);
    const savedAt = now();
    const entry = { value, expiresAt: savedAt + ttlMs, staleUntil: savedAt + ttlMs + staleMs, bytes: estimateBytes(value) };
    entries.set(key, entry);
    bytes += entry.bytes;
    cleanup();
  }

  function refresh(key, loader) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve().then(loader).then((value) => { save(key, value); return value; });
    inFlight.set(key, promise);
    promise.catch(() => {}).finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
    return promise;
  }

  async function load(key, loader) {
    cleanup();
    const entry = entries.get(key);
    const time = now();
    if (entry && entry.expiresAt > time) {
      entries.delete(key); entries.set(key, entry);
      return { value: entry.value, cache: "HIT" };
    }
    if (entry && entry.staleUntil > time) {
      refresh(key, loader);
      entries.delete(key); entries.set(key, entry);
      return { value: entry.value, cache: "STALE" };
    }
    return { value: await refresh(key, loader), cache: "MISS" };
  }

  return { load, cleanup, stats: () => ({ name, entries: entries.size, inFlight: inFlight.size, bytes }) };
}
