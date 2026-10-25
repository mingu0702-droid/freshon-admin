const MAX_CONCURRENT_BROWSERS = 1;
let activeBrowsers = 0;
const waiters = [];

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeBrowsers = Math.max(0, activeBrowsers - 1);
    const next = waiters.shift();
    if (next) queueMicrotask(next);
  };
}

export async function acquireBrowserPermit() {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers += 1;
    return makeRelease();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      activeBrowsers += 1;
      resolve(makeRelease());
    });
  });
}

export function getBrowserGateStatus() {
  return { activeBrowsers, queuedBrowsers: waiters.length, limit: MAX_CONCURRENT_BROWSERS };
}
