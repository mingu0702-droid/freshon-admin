export function getYesterdayKst(now = new Date()) {
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const kst = new Date(utc + 9 * 60 * 60_000);
  kst.setDate(kst.getDate() - 1);
  return kst;
}

export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDefaultDispatchRange() {
  const end = getYesterdayKst();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 3);
  return {
    startDate: formatDate(start),
    endDate: formatDate(end)
  };
}
