/* Pure period selection: driver history never comes from today's vehicle master. */
(function(root) {
  function select(rows, vehicles = [], driverKey = '', options = {}) {
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
      const useBase=options.vehicleBasis==='base';
      if(useBase&&wanted.size&&!wanted.has(String(row.baseVehicle||'')))return [];
      const history = (row.history || []).filter(item => (useBase || !wanted.size || wanted.has(String(item.vehicle))) && (!driverKey || item.driverKey === driverKey))
        .sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate));
      if (!history.length) return [];
      const latest = history[0];
      return [{ ...row, vehicle: useBase ? String(row.baseVehicle||'') : latest.vehicle, actualVehicle:latest.vehicle, driverKey: latest.driverKey, driverName: latest.driverName,
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
    const finish=()=>{cells.push(cell);records.push({address:(cells[0]||'').trim(),customer:cells[1]||'',originalAddress:cells[0]||'',originalCustomer:cells[1]||'',originalInput:raw.replace(/\n$/,''),inputAmbiguous:quoted||cells.length>2});cells=[];cell='';raw='';};
    const input=String(text||'').replace(/\r\n/g,'\n');
    for(let i=0;i<input.length;i++){
      const c=input[i];raw+=c;
      if(c==='"'&&(quoted||!cell.trim())){if(quoted&&input[i+1]==='"'){cell+='"';raw+=input[++i];}else quoted=!quoted;}
      else if(c==='\t'&&!quoted){cells.push(cell);cell='';}
      else if(c==='\n'&&!quoted)finish();else cell+=c;
    }
    if(raw||cells.length||cell)finish();return records;
  }
  function regionForAddress(address) {
    const province=String(address||'').trim().split(/\s+/)[0];
    if (/^(제주|제주도|제주특별자치도)$/.test(province)) return '제주도';
    if (/^(부산|대구|울산)(광역시)?$|^경(상)?[남북](도)?$/.test(province)) return '영남권';
    if (/^광주(광역시)?$|^전(라)?[남북](도)?$|^전북특별자치도$/.test(province)) return '호남권';
    return '';
  }
  function areaExportRows(rows, applyDate) {
    const date=/^\d{4}-\d{2}-\d{2}$/.test(applyDate||'')?Number(applyDate.slice(5,7))+'-'+Number(applyDate.slice(8)):'';
    return rows.map(row=>{
      const decision=['O','X'].includes(row.decision)?row.decision:'검토필요';
      const reason=decision==='검토필요'?'검토필요':String(row.reason||'').replace('배송동선 맞지 않음','배송동선 맞지않음');
      return [row.originalAddress??row.address??'',row.originalCustomer??row.customer??'',decision,reason,date,
        regionForAddress(row.address),row.vehicle&&row.vehicle!=='-'?row.vehicle:'',
        row.nearestStore||row.nearby?.[0]?.customerName||'',Number.isFinite(row.nearestDistance)?Number(row.nearestDistance.toFixed(3)):''];
    });
  }
  function areaTsv(rows, applyDate, kind) {
    return areaExportRows(rows,applyDate).map(row=>(kind==='matching'?row.slice(7,9):row.slice(2,6))
      .map(v=>{const s=String(v??'');return /[\t\n\r"]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join('\t')).join('\r\n');
  }
  function mergeBaseVehicles(previous, rows) {
    const next=new Map(previous);
    for(const row of rows){
      const old=next.get(row.customerCode);
      if(old?.baseVehicle&&(!row.baseVehicle||old.baseVehicleState==='VERIFIED_MASTER'&&row.baseVehicleState!=='VERIFIED_MASTER'))continue;
      next.set(row.customerCode,row);
    }
    return next;
  }
  function baseVehicleLabel(row) {
    return row.baseVehicle?row.baseVehicle+'호':row.baseVehicleState==='UNASSIGNED'?'미지정':'확인 필요';
  }
  root.MapPeriodUi = Object.freeze({ select, cluster, recentRange, spatialIndex, reconcile, parseAreaInput,
    regionForAddress, areaExportRows, areaTsv, mergeBaseVehicles, baseVehicleLabel });
})(typeof window === 'undefined' ? globalThis : window);
