(function (root) {
  'use strict';
  // Private Customer metadata stays in page memory. Delivery rows remain evidence.
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const code = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const validText = (value, length) => typeof value === 'string' && value.length <= length && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  const automatic = row => /^(?:KAKAO_ADDRESS_LIVE|KAKAO_ADDRESS_TEMPORARY|KAKAO_BUILDING_EXACT_ADDRESS|KAKAO_ADDRESS_REVALIDATION|AUTO_ADDRESS|ADDRESS_GEOCODE|GEOCODE_AUTO)$/.test(row.coordinateSource || '');
  const failure = message => Object.assign(Error(message), {code: message});
  const cancelled = () => Object.assign(failure('CUSTOMER_REGISTRY_CANCELLED'), {name: 'AbortError'});

  async function addressHash(address) {
    if (!root.crypto?.subtle || typeof TextEncoder !== 'function') throw failure('CUSTOMER_REGISTRY_HASH_UNAVAILABLE');
    return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalize(address))))].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function coordinateSearch(value, customerCode, originalAddressHash) {
    if (value == null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value) || value.customerCode !== customerCode ||
      value.originalAddressHash !== originalAddressHash || !validText(value.query, 300) || !value.query.trim() ||
      !hash(value.queryHash) || value.queryHash !== await addressHash(value.query) ||
      !['BUILDING', 'CAMPUS'].includes(value.accuracy) || value.storeInteriorVerified !== false ||
      value.ruleVersion !== 'USER_CONFIRMED_SEARCH_ADDRESS_20261104') throw failure('CUSTOMER_REGISTRY_COORDINATE_SEARCH_INVALID');
    return Object.freeze({customerCode, originalAddressHash, query: value.query, queryHash: value.queryHash,
      accuracy: value.accuracy, storeInteriorVerified: false, ruleVersion: value.ruleVersion});
  }

  function orderedRows(rows, selection = {}) {
    const selected = selection.customerCode || selection.code || '';
    const query = normalize(selection.query || selection.search).replace(/\s/g, '');
    const center = normalize(selection.center || selection.centerFilter);
    const vehicles = new Set((selection.vehicles || []).map(value => String(value).replace(/호(?:차)?$/, '')));
    const score = row => {
      if (row.customerCode === selected) return 0;
      if (query && [row.customerCode, row.customerName, row.address, row.basicAddress].some(value => normalize(value).replace(/\s/g, '').includes(query))) return 1;
      const inCenter = center && [row.center, row.centerName, row.dispatchCenterCode, row.baseVehicleGroup, row.vehicleGroup].some(value => normalize(value) === center);
      const inVehicle = vehicles.size && [row.baseVehicle, row.vehicle].some(value => vehicles.has(String(value || '').replace(/호(?:차)?$/, '')));
      return inCenter && inVehicle ? 2 : inVehicle ? 3 : inCenter ? 4 : 5;
    };
    return (rows || []).map((row, index) => ({row, index, score: score(row)}))
      .filter(item => item.row.customerRegistryStatus !== 'DELETED')
      .sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.row);
  }

  function priorityRows(rows, selection = {}, {limit = 40} = {}) {
    return orderedRows(rows, selection).slice(0, Math.max(0, Math.min(1000, Number.isFinite(limit) ? Math.floor(limit) : 40)));
  }

  function create({readPage, authenticated = () => true, onChange = () => {}, pageSize = 250, maxPages = 4} = {}) {
    let records = new Map(), version = '', sourceVersion = '', cursor = null, stage = null;
    let sourceInitialized = false, generationNewCodes = new Set();
    const locationScopes = new Map(), liveNewCodes = new Set();
    let epoch = 0, controller = new AbortController(), pending = null, pendingOwner = -1, active = true;
    let status = 'idle', errorCode = '', complete = false;

    function summary() {
      return Object.freeze({status, version, sourceVersion, cursor, complete, count: records.size,
        active: [...records.values()].filter(row => row.lifecycle === 'ACTIVE').length,
        deleted: [...records.values()].filter(row => row.lifecycle === 'DELETED').length,
        pendingPages: stage?.pages || 0, locationScopes: locationScopes.size, errorCode, retention: 'PAGE_MEMORY_ONLY', deletionPolicy: 'EXPLICIT_ONLY'});
    }
    const notify = () => { try { onChange(summary()); } catch (_) { /* A renderer cannot corrupt the registry checkpoint. */ } };

    function purge() {
      epoch++; controller.abort(); controller = new AbortController();
      records.clear(); stage = null; cursor = null; version = ''; sourceVersion = '';
      locationScopes.clear(); liveNewCodes.clear(); generationNewCodes.clear(); sourceInitialized = false;
      active = false; status = 'logged-out'; errorCode = ''; complete = false; notify();
    }

    function assertCurrent(owner, signal) {
      if (!authenticated()) { purge(); throw cancelled(); }
      if (owner !== epoch || signal.aborted || !active) throw cancelled();
    }

    async function validate(payload, requestedCursor) {
      if (payload?.ok === false) throw failure('CUSTOMER_REGISTRY_SOURCE_UNAVAILABLE');
      const page = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
      if (!page || page.contract !== 'customer-registry-v1' || !['FULL', 'DELTA', 'NOOP'].includes(page.mode) ||
        !validText(page.version, 256) || !page.version || typeof page.complete !== 'boolean' ||
        page.deletionPolicy !== 'EXPLICIT_ONLY' || !Array.isArray(page.rows) || page.rows.length > 1000 ||
        page.sourceVersion != null && !validText(page.sourceVersion, 256) ||
        page.nextCursor != null && (!validText(page.nextCursor, 4096) || !page.nextCursor) ||
        (page.afterCursor ?? null) !== requestedCursor ||
        !page.complete && (!page.nextCursor || page.nextCursor === requestedCursor) ||
        page.mode === 'NOOP' && (page.rows.length || !page.complete)) throw failure('CUSTOMER_REGISTRY_PAGE_INVALID');
      const seen = new Set(), rows = [];
      for (const row of page.rows) {
        if (!row || !code(row.customerCode) || seen.has(row.customerCode) || !['ACTIVE', 'DELETED'].includes(row.lifecycle) ||
          row.lifecycle === 'ACTIVE' && (!validText(row.customerName, 200) || !validText(row.basicAddress, 1000)) ||
          row.sourceUpdatedAt != null && !validText(row.sourceUpdatedAt, 100) ||
          row.addressHash != null && !hash(row.addressHash)) throw failure('CUSTOMER_REGISTRY_ROW_INVALID');
        seen.add(row.customerCode);
        const currentHash = row.lifecycle === 'ACTIVE' ? await addressHash(row.basicAddress) : '';
        if (row.lifecycle === 'ACTIVE' && row.addressHash != null && row.addressHash !== currentHash) throw failure('CUSTOMER_REGISTRY_ADDRESS_HASH_INVALID');
        const search = row.lifecycle === 'ACTIVE' ? await coordinateSearch(row.coordinateSearch ?? row.raw?.coordinateSearch, row.customerCode, currentHash) : undefined;
        // Never copy private detail fields, provider coordinates, visits, or notes from a bulk response.
        rows.push(Object.freeze({customerCode: row.customerCode, customerName: row.customerName || '', basicAddress: row.basicAddress || '',
          addressHash: currentHash, ...(search ? {coordinateSearch: search} : {}),
          sourceUpdatedAt: row.sourceUpdatedAt || '', lifecycle: row.lifecycle}));
      }
      return {...page, rows};
    }

    async function run(options, owner) {
      status = 'loading'; errorCode = ''; notify();
      const signal = controller.signal;
      try {
        if (typeof readPage !== 'function') throw failure('CUSTOMER_REGISTRY_READER_REQUIRED');
        const pageLimit = Math.max(1, Math.min(100, Number.isInteger(options.maxPages) ? options.maxPages : maxPages));
        for (let index = 0; index < pageLimit; index++) {
          const requestedCursor = stage ? stage.cursor : cursor;
          const payload = await readPage({cursor: requestedCursor, signal, selection: options.selection || {}, limit: Math.max(1, Math.min(1000, pageSize))});
          assertCurrent(owner, signal);
          const page = await validate(payload, requestedCursor);
          assertCurrent(owner, signal);
          if (stage && (stage.version !== page.version || stage.sourceVersion !== (page.sourceVersion || '') || stage.mode !== page.mode)) throw failure('CUSTOMER_REGISTRY_VERSION_CHANGED');
          if (!stage) stage = {
            records: new Map(records), version: page.version, sourceVersion: page.sourceVersion || '',
            mode: page.mode, cursor: requestedCursor, receipts: new Set(), customerCodes: new Set(), pages: 0
          };
          const receipt = JSON.stringify([page.version, requestedCursor, page.nextCursor ?? null]);
          if (stage.receipts.has(receipt)) throw failure('CUSTOMER_REGISTRY_CURSOR_REPEATED');
          stage.receipts.add(receipt); stage.pages++;
          for (const row of page.rows) {
            if (stage.customerCodes.has(row.customerCode)) throw failure('CUSTOMER_REGISTRY_ROW_INVALID');
            stage.customerCodes.add(row.customerCode);
            // An opaque version is an identity, not a sortable timestamp.
            if (page.version !== version) stage.records.set(row.customerCode, row);
          }
          if (stage.records.size > 100000) throw failure('CUSTOMER_REGISTRY_LIMIT_EXCEEDED');
          stage.cursor = page.nextCursor ?? null;
          if (!page.complete && stage.receipts.has(JSON.stringify([page.version, stage.cursor, requestedCursor]))) throw failure('CUSTOMER_REGISTRY_CURSOR_REPEATED');
          if (page.complete) {
            if (stage.version !== version) {
              generationNewCodes = new Set(sourceInitialized ? [...stage.records.values()].filter(row => row.lifecycle === 'ACTIVE' && !records.has(row.customerCode)).map(row => row.customerCode) : []);
              for (const customerCode of generationNewCodes) liveNewCodes.add(customerCode);
            }
            records = stage.records; version = stage.version; sourceVersion = stage.sourceVersion; cursor = stage.cursor;
            sourceInitialized = true;
            stage = null; complete = true; status = 'ready'; notify(); return summary();
          }
        }
        status = 'partial'; notify(); return summary();
      } catch (error) {
        if (owner !== epoch || signal.aborted || error?.name === 'AbortError') throw cancelled();
        // Retry starts from the last committed checkpoint, never a half-applied generation.
        stage = null; status = 'error'; errorCode = /^CUSTOMER_REGISTRY_[A-Z_]+$/.test(error?.code || '') ? error.code : 'CUSTOMER_REGISTRY_SOURCE_UNAVAILABLE'; notify();
        throw failure(errorCode);
      }
    }

    function sync(options = {}) {
      if (!authenticated()) { purge(); return Promise.resolve(summary()); }
      if (!active) return Promise.resolve(summary());
      if (pending && pendingOwner === epoch) return pending;
      const owner = epoch;
      const task = run(options, owner).finally(() => { if (pending === task) { pending = null; pendingOwner = -1; } });
      pending = task; pendingOwner = owner; return task;
    }

    function reconnect(options = {}) {
      epoch++; controller.abort(); controller = new AbortController(); stage = null; cursor = null;
      active = !!authenticated(); complete = false; status = active ? 'idle' : 'logged-out'; errorCode = '';
      return active ? sync(options) : Promise.resolve(summary());
    }

    function locationRows(rows, selection = {}, {limit = 40, extend = false} = {}) {
      if (!authenticated()) { if (active) purge(); return []; }
      if (!active) return [];
      const count = Math.max(0, Math.min(1000, Number.isFinite(limit) ? Math.floor(limit) : 40));
      if (!count) return [];
      const selected = selection.customerCode || selection.code || '';
      const scopeKey = JSON.stringify([normalize(selection.center || selection.centerFilter),
        [...new Set((selection.vehicles || []).map(value => String(value).replace(/호(?:차)?$/, '')))].sort()]);
      const candidates = [...new Map((rows || []).filter(row => code(row?.customerCode) && row.customerRegistryStatus !== 'DELETED' && records.get(row.customerCode)?.lifecycle !== 'DELETED').map(row => [row.customerCode, row])).values()];
      if (!candidates.length) return [];
      const approved = row => !!records.get(row.customerCode)?.coordinateSearch;
      const ordered = orderedRows(candidates, selection);
      const rank = row => row.customerCode === selected ? 0 : approved(row) ? 1 : liveNewCodes.has(row.customerCode) ? 2 : 3;
      ordered.sort((a, b) => rank(a) - rank(b));
      let scope = locationScopes.get(scopeKey);
      if (!scope) {
        scope = {eligible: new Set(ordered.slice(0, count).map(row => row.customerCode)), generations: new Set()};
        locationScopes.set(scopeKey, scope);
      }
      if (extend) for (const row of ordered.slice(0, count)) scope.eligible.add(row.customerCode);
      // A render after success may remove a candidate, but must never refill its slot.
      for (const row of ordered) if (row.customerCode === selected || approved(row)) scope.eligible.add(row.customerCode);
      if (!scope.generations.has(version)) {
        scope.generations.add(version);
        for (const row of ordered.filter(row => generationNewCodes.has(row.customerCode)).slice(0, count)) scope.eligible.add(row.customerCode);
      }
      return ordered.filter(row => scope.eligible.has(row.customerCode)).slice(0, count);
    }

    function merge(observedRows = []) {
      if (!authenticated()) { if (active) purge(); return []; }
      if (!active) return [];
      const merged = new Map();
      for (const observed of observedRows || []) {
        const customerCode = String(observed?.customerCode || observed?.code || observed?.id || '').trim();
        if (!code(customerCode)) continue;
        merged.set(customerCode, {...observed, customerCode, ...(observed.raw ? {raw: {...observed.raw}} : {})});
      }
      for (const record of records.values()) {
        const observed = merged.get(record.customerCode);
        if (record.lifecycle === 'DELETED') {
          if (observed) Object.assign(observed, {customerRegistryStatus: 'DELETED', customerLifecycle: 'DELETED', currentMasterStatus: 'DELETED'});
          continue;
        }
        const row = observed || {customerCode: record.customerCode, customerOnly: true, deliveryObserved: false,
          vehicle: '', baseVehicle: '', baseVehicleGroup: '', baseVehicleState: 'UNKNOWN', lastDeliveryDate: '',
          history: [], relations: [], deliveryCount90d: null, lat: null, lng: null, coordinateSource: '', coordinateStatus: 'MISSING'};
        const previousAddress = row.address || row.customerAddress || row.basicAddress || '';
        const previousHash = row.currentAddressHash || row.customerRegistryAddressHash || '';
        const changed = !!previousHash && previousHash !== record.addressHash || !!previousAddress && normalize(previousAddress) !== normalize(record.basicAddress);
        const evidenceHash = [row.coordinateAddressHash, row.raw?.coordinateAddressHash, row.originalAddressHash,
          row.raw?.originalAddressHash, row.addressHash, row.raw?.addressHash].find(hash) || '';
        const holdCoordinates = (evidenceHash && evidenceHash !== record.addressHash) ||
          (changed && (automatic(row) || evidenceHash !== record.addressHash));
        if (holdCoordinates) {
          row.coordinateEvidence = Object.freeze(row.coordinateEvidence && row.lat == null && row.lng == null ? {...row.coordinateEvidence} : {...row.coordinateEvidence, lat: row.lat, lng: row.lng,
            coordinateSource: row.coordinateSource || '', coordinateAccuracy: row.coordinateAccuracy || '', coordinateStatus: row.coordinateStatus || '',
            originalAddressHash: evidenceHash || '', currentAddressHash: previousHash || ''});
        }
        Object.assign(row, {customerName: record.customerName, name: record.customerName, address: record.basicAddress,
          customerAddress: record.basicAddress, basicAddress: record.basicAddress, currentAddressHash: record.addressHash,
          customerRegistryAddressHash: record.addressHash, customerRegistryStatus: 'ACTIVE', customerLifecycle: 'ACTIVE',
          customerRegistryVersion: version, customerRegistryUpdatedAt: record.sourceUpdatedAt, currentMasterStatus: 'FOUND'});
        row.raw = {...row.raw, customerCode: record.customerCode, customerName: record.customerName, name: record.customerName,
          address: record.basicAddress, customerAddress: record.basicAddress, basicAddress: record.basicAddress,
          currentAddressHash: record.addressHash, customerRegistryAddressHash: record.addressHash,
          ...(row.coordinateEvidence ? {coordinateEvidence: row.coordinateEvidence} : {})};
        if (record.coordinateSearch) {
          row.coordinateSearch = {...record.coordinateSearch}; row.raw.coordinateSearch = {...record.coordinateSearch};
        } else { delete row.coordinateSearch; delete row.raw.coordinateSearch; }
        if (holdCoordinates) {
          Object.assign(row, {lat: null, lng: null, latitude: null, longitude: null, coordinateSource: automatic(row) ? '' : row.coordinateSource, coordinateStatus: 'CONFLICT',
            coordinateAccuracy: '', addressLocationKey: '', addressChanged: true, resolutionStatus: 'ADDRESS_CHANGED_REVIEW_REQUIRED'});
        }
        merged.set(record.customerCode, row);
      }
      return [...merged.values()];
    }

    return Object.freeze({sync, reconnect, purge, merge, summary, priorityRows, locationRows});
  }
  root.MapCustomerRegistry = Object.freeze({create, priorityRows, addressHash});
})(typeof window === 'object' ? window : globalThis);
