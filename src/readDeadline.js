export function createReadDeadline({ milliseconds = 5000, now = Date.now } = {}) {
  const controller = new AbortController(), expiresAt = now() + milliseconds;
  const abort = () => controller.abort(Object.assign(new Error('HISTORY_UPSTREAM_TIMEOUT'), { name: 'AbortError' }));
  const timer = setTimeout(abort, milliseconds); timer.unref?.();
  return { signal: controller.signal, expiresAt, remaining: () => Math.max(0, expiresAt - now()),
    check() { if (now() >= expiresAt) abort(); controller.signal.throwIfAborted(); },
    abort, dispose: () => clearTimeout(timer) };
}

// Installed BEFORE session verification: auth and all upstream pages share a budget.
export function historyDeadline(req, res, next) {
  const budget = createReadDeadline(); req.historyBudget = budget;
  const close = () => { if (!res.writableFinished) budget.abort(); cleanup(); };
  const cleanup = () => { budget.dispose(); req.off('aborted', close); res.off('close', close); res.off('finish', cleanup); };
  req.once('aborted', close); res.once('close', close); res.once('finish', cleanup); next();
}
