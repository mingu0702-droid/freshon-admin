// Exact observed Delivery task schema, no master/RAW fallback.
export function validateDeliveryLivePage(payload, rows, { date, page, pageSize, received }) {
  const data = payload?.data || payload;
  const total = Number(data?.totalElements), pages = Number(data?.totalPages);
  if (!Array.isArray(rows) || !Number.isInteger(total) || total < 0 || !Number.isInteger(pages) || pages < 0
    || rows.length > pageSize || received + rows.length > total || (data?.number != null && Number(data.number) !== page)) throw new Error('DELIVERY_LIVE_PAGE_INCOMPLETE');
  for (const row of rows) {
    const rawDate = row.enteringDatedAt ?? row.carrier?.enteringDatedAt;
    const parsed = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0,10) : null;
    if (!row.id || !row.customer?.erpCode || parsed !== date) throw new Error('DELIVERY_LIVE_DATE_UNCONFIRMED');
  }
  const complete = page + 1 >= pages;
  if (complete ? received + rows.length !== total : rows.length === 0) throw new Error('DELIVERY_LIVE_PAGE_INCOMPLETE');
  return { complete, total, pages };
}
