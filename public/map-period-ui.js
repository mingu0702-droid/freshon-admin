/* Pure period selection: driver history never comes from today's vehicle master. */
(function(root) {
  function select(rows, vehicles = [], driverKey = '') {
    const wanted = new Set(vehicles);
    const unique = new Map();
    for (const row of rows) {
      const code = String(row.customerCode || '');
      if (!code) continue;
      const previous = unique.get(code);
      unique.set(code, { ...row, history: [...(previous?.history || []), ...(row.history || [])] });
    }
    return [...unique.values()].flatMap(row => {
      const seen = new Set();
      row.history = row.history.filter(item => {
        const key = item.sourceKey || [item.deliveryDate, item.vehicle, item.driverKey].join('|');
        if (seen.has(key)) return false; seen.add(key); return true;
      }).sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate));
      const history = (row.history || []).filter(item => (!wanted.size || wanted.has(String(item.vehicle))) && (!driverKey || item.driverKey === driverKey))
        .sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate));
      if (!history.length) return [];
      const latest = history[0];
      return [{ ...row, vehicle: latest.vehicle, driverKey: latest.driverKey, driverName: latest.driverName,
        lastDeliveryDate: latest.deliveryDate, visitCount: history.length,
        periodVisitCount: row.history.length, vehicles: [...new Set(row.history.map(item => item.vehicle))],
        drivers: [...new Set(row.history.map(item => item.driverKey).filter(Boolean))],
        status: '', order: null, representativeLabel: '선택 기간 내 최신 배차', history: row.history }];
    });
  }
  function cluster(rows, project, level, selectedCode = '', viewport = null) {
    const points = rows.map(row => ({ row, point: project(row) })).filter(({ row, point }) =>
      row.customerCode === selectedCode || !viewport ||
      (point.x >= -60 && point.y >= -60 && point.x <= viewport.width + 60 && point.y <= viewport.height + 60));
    if ((level < 9 && points.length <= 200) || points.length < 50) return points.map(item => item.row);
    const buckets = new Map(), selected = [];
    const size = viewport ? Math.max(44, Math.ceil(Math.sqrt((viewport.width + 120) * (viewport.height + 120) / 160))) : 44;
    for (const { row, point } of points) {
      if (row.customerCode === selectedCode) { selected.push(row); continue; }
      const key = Math.floor(point.x / size) + ':' + Math.floor(point.y / size);
      if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row);
    }
    return [...selected, ...[...buckets.values()].flatMap(group => group.length === 1 ? group : [{ ...group[0], clusterCount: group.length }])];
  }
  root.MapPeriodUi = Object.freeze({ select, cluster });
})(typeof window === 'undefined' ? globalThis : window);
