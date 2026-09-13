/* Pure period selection: driver history never comes from today's vehicle master. */
(function(root) {
  function select(rows, vehicles = [], driverKey = '') {
    const wanted = new Set(vehicles);
    return rows.flatMap(row => {
      const history = (row.history || []).filter(item => (!wanted.size || wanted.has(String(item.vehicle))) && (!driverKey || item.driverKey === driverKey))
        .sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate));
      if (!history.length) return [];
      const latest = history[0];
      return [{ ...row, vehicle: latest.vehicle, driverKey: latest.driverKey, driverName: latest.driverName,
        lastDeliveryDate: latest.deliveryDate, status: '', order: null, representativeLabel: '선택 기간 내 최신 배차', history: row.history }];
    });
  }
  function cluster(rows, project, level, selectedCode = '') {
    if (level < 9 || rows.length < 50) return rows;
    const buckets = new Map(), selected = [];
    for (const row of rows) {
      if (row.customerCode === selectedCode) { selected.push(row); continue; }
      const point = project(row), key = Math.floor(point.x / 44) + ':' + Math.floor(point.y / 44);
      if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row);
    }
    return [...selected, ...[...buckets.values()].flatMap(group => group.length < 3 ? group : [{ ...group[0], clusterCount: group.length }])];
  }
  root.MapPeriodUi = Object.freeze({ select, cluster });
})(typeof window === 'undefined' ? globalThis : window);
