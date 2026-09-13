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
  root.MapPeriodUi = Object.freeze({ select });
})(typeof window === 'undefined' ? globalThis : window);
