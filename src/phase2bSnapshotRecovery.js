export const PHASE2B_SNAPSHOT_MAX_ERRORS = 3;

function dateMs(value) {
  const ms = Date.parse(`${String(value || "").slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function phase2bSnapshotProgress(startDate, currentDate, targetDate) {
  const start = dateMs(startDate), current = dateMs(currentDate), target = dateMs(targetDate);
  if (start == null || current == null || target == null) return 0;
  if (target <= start) return current >= target ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((current - start) * 1000 / (target - start)) / 10));
}

export function phase2bSnapshotFailure(previous, errorCode, now = Date.now(), maxErrors = PHASE2B_SNAPSHOT_MAX_ERRORS) {
  const code = String(errorCode || "SNAPSHOT_REFRESH_FAILED");
  const consecutiveErrors = previous?.lastErrorCode === code ? Number(previous.consecutiveErrors || 0) + 1 : 1;
  return {
    consecutiveErrors,
    lastErrorCode: code,
    lastErrorAt: new Date(now).toISOString(),
    phase: consecutiveErrors >= maxErrors ? "ERROR" : "WAITING"
  };
}

export function phase2bSnapshotWatchdogNeeded(state, options = {}) {
  const now = Number(options.now || Date.now());
  const stallMs = Number(options.stallMs || 7 * 60 * 1000);
  if (!state || state.phase === "DONE" || state.phase === "ERROR") return false;
  if (options.hasContinuation || options.running) return false;
  const updatedAt = Date.parse(state.updatedAt || "");
  return !Number.isFinite(updatedAt) || now - updatedAt >= stallMs;
}
