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
        lastDeliveryDate: latest.deliveryDate, visitCount: history.reduce((n,item)=>n+(item.count || 1),0),
        periodVisitCount: row.history.reduce((n,item)=>n+(item.count || 1),0), vehicles: [...new Set(row.history.map(item => item.vehicle))],
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
  function recentRange(status) {
    const end = status?.periodLatest || status?.endDate;
    if (!status?.ready || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) return null;
    const start = new Date(Date.parse(end + 'T00:00:00Z') - 59 * 86400000).toISOString().slice(0,10);
    return { start: status.startDate && status.startDate > start ? status.startDate : start, end };
  }
  function spatialIndex(rows) {
    const bins = new Map(), valid = rows.filter(row => Number.isFinite(row.lat) && Number.isFinite(row.lng));
    for (const row of valid) {
      const key = Math.floor(row.lat * 10) + ':' + Math.floor(row.lng * 10);
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(row);
    }
    return { valid, query(bounds) {
      if (!bounds) return valid;
      const {south,north,west,east} = bounds;
      if (![south,north,west,east].every(Number.isFinite) || east < west) return valid;
      const result = [];
      for (const [key, bucket] of bins) {
        const [lat,lng] = key.split(':').map(Number);
        if ((lat+1)/10 < south || lat/10 > north || (lng+1)/10 < west || lng/10 > east) continue;
        for (const row of bucket) if (row.lat >= south && row.lat <= north && row.lng >= west && row.lng <= east) result.push(row);
      }
      return result;
    }};
  }
  function reconcile(previous, entries, create, remove) {
    const next = new Map(); let created = 0, removed = 0, reused = 0;
    for (const entry of entries) {
      const old = previous.get(entry.key);
      if (old && old.fingerprint === entry.fingerprint) { next.set(entry.key,old); reused++; }
      else { if (old) { remove(old.value); removed++; } next.set(entry.key,{fingerprint:entry.fingerprint,value:create(entry)}); created++; }
    }
    for (const [key, old] of previous) if (!next.has(key)) { remove(old.value); removed++; }
    return { next, created, removed, reused };
  }
  function parseAreaInput(text) {
    const records=[];let cells=[],cell='',quoted=false,raw='';
    const finish=()=>{cells.push(cell.trim());if(cells.some(Boolean))records.push({address:cells[0]||'',customer:cells.slice(1).join(' '),originalInput:raw.trim(),inputAmbiguous:quoted||cells.length>2});cells=[];cell='';raw='';};
    const input=String(text||'').replace(/\r\n/g,'\n');
    for(let i=0;i<input.length;i++){
      const c=input[i];raw+=c;
      if(c==='"'&&(quoted||!cell.trim())){if(quoted&&input[i+1]==='"'){cell+='"';raw+=input[++i];}else quoted=!quoted;}
      else if(c==='\t'&&!quoted){cells.push(cell.trim());cell='';}
      else if(c==='\n'&&!quoted)finish();else cell+=c;
    }
    finish();return records;
  }
  root.MapPeriodUi = Object.freeze({ select, cluster, recentRange, spatialIndex, reconcile, parseAreaInput });
})(typeof window === 'undefined' ? globalThis : window);
