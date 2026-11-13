import {assertDeliverySourceObservation,sourceTaskDate} from './snapshotRefreshEvidence.js';
// Selected-customer employee projection. Phone fields never enter publicMapValue.
const clean = value => String(value ?? '').normalize('NFKC').trim();
const key = value => clean(value).replace(/\s+/g, '').toLowerCase();
export function driverVehicle(value) {
  const text = clean(value).replace(/(?:호차|호)$/, '');
  if (/^\d{1,5}$/.test(text)) return String(Number(text));
  return /^(?:용|척척)\d{1,5}$/.test(text) ? text : '';
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
export function driverPhone(value) {
  const text = clean(value), compact = text.replace(/[\s()-]/g, '');
  return /^(?:0\d{8,10}|\+82\d{8,10})$/.test(compact) ? text : null;
}
export function attachDatedStopDriver(stop, driver = {}) {
  stop.driverName = clean(driver.driverName);
  Object.defineProperty(stop, 'driverPhone', { value: driverPhone(driver.driverPhone), enumerable: false });
  return stop;
}
const fail = (code, status = 503) => Object.assign(Error(code), { code, status });

// Today's existing Delivery read is authoritative; failed proof never falls back.
export function createDatedDriverRouteReader({ today, readTodayStatus, readStoredRoute } = {}) {
  return async (date, vehicle) => {
    if (typeof today !== 'function') throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
    const current = today();
    if (!validDate(current) || !validDate(date) || date > current) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
    if (date !== current) {
      if (!readStoredRoute) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
      return readStoredRoute(date, vehicle);
    }
    if (!readTodayStatus) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
    let status;
    try { status = await readTodayStatus(date); }
    catch { throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE'); }
    try { assertDeliverySourceObservation(status?.sourceObservation, date); }
    catch { throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409); }
    if (status?.date !== date || !Array.isArray(status.vehicles)) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
    const matches = status.vehicles.filter(row => driverVehicle(row.vehicle) === vehicle);
    if (matches.length > 1) throw fail('DRIVER_ASSIGNMENT_CONFLICT', 409);
    const route = matches[0];
    if (!route) throw fail('DRIVER_ASSIGNMENT_NOT_FOUND', 404);
    if (route.date !== date || !Array.isArray(route.stops) || route.stops.some(row => driverVehicle(row.vehicle) !== vehicle))
      throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
    return { ...route, driverName: '', driverPhone: null, sourceRouteIdentityVerified: true, currentDeliveryVerified: true };
  };
}

// Use existing cached fixed-dispatch evidence or a stored dated route; no collection.
export function createDriverAssignmentReader({ readBaseVehicles, readStoredRoute } = {}) {
  return async ({ customerCode, vehicle, date, context }) => {
    if (context === 'BASE') {
      if (!readBaseVehicles) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
      const result = await readBaseVehicles([customerCode]);
      const rows = result?.data?.filter(row => row.customerCode === customerCode) || [];
      if (rows.length > 1) throw fail('DRIVER_ASSIGNMENT_CONFLICT', 409);
      const [row] = rows;
      if (!result?.ok || !row) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
      if (row.baseVehicleState === 'CONFLICT') throw fail('DRIVER_ASSIGNMENT_CONFLICT', 409);
      if (row.baseVehicleState !== 'VERIFIED_MASTER' || row.baseVehicleSource !== 'FIXED_DISPATCH_PRIMARY'
          || !/^[a-f0-9]{64}$/.test(row.baseVehicleVersion || '')
          || driverVehicle(row.baseVehicle) !== vehicle) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
      return { vehicle, center: row.baseVehicleGroup, basis: 'FIXED_DISPATCH_PRIMARY', version: row.baseVehicleVersion,
        checkedAt: row.baseVehicleCheckedAt || null, stale: row.baseVehicleStale !== false };
    }
    if (!readStoredRoute) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
    const route = await readStoredRoute(date, vehicle);
    if (!route || route.sourceRouteIdentityVerified===false || clean(route.date || route.deliveryDate) !== date || driverVehicle(route.vehicle) !== vehicle)
      throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
    const matches = (route.stops || []).filter(row => clean(row.customerCode || row.code) === customerCode);
    if (!matches.length) throw fail('DRIVER_ASSIGNMENT_NOT_FOUND', 404);
    const identities = new Set(matches.map(row => key(row.driverName || route.driverName)).filter(Boolean));
    const phones = new Set(matches.map(row => driverPhone(row.driverPhone || route.driverPhone)).filter(Boolean).map(value => value.replace(/\D/g, '')));
    if (identities.size > 1 || phones.size > 1) throw fail('DRIVER_ASSIGNMENT_CONFLICT', 409);
    const row = matches[0];
    return { vehicle, basis: 'DATED_ASSIGNMENT', date,
      currentDeliveryVerified: route.currentDeliveryVerified === true,
      driverName: clean(row.driverName || route.driverName),
      driverPhone: driverPhone(row.driverPhone || route.driverPhone), stale: false };
  };
}

export function createDriverContactReader({ readDriverMaster, readAssignment, datedIdentity, preferExactDatedContact = false } = {}) {
  return async (input, options = {}) => {
    const customerCode = clean(input.customerCode), vehicle = driverVehicle(input.vehicle), date = clean(input.date), context = clean(input.context);
    if (!/^[A-Z]\d+$/.test(customerCode) || !vehicle || !validDate(date) || !['BASE', 'DATE_ROUTE'].includes(context))
      throw fail('DRIVER_CONTACT_INVALID_INPUT', 400);
    if (!readAssignment || !readDriverMaster) throw fail('DRIVER_SOURCE_NOT_CONFIGURED');
    const extra = context === 'DATE_ROUTE' && datedIdentity ? datedIdentity(input) : {};
    const identity = { customerCode, vehicle, date, context, ...extra };
    const assignment = await readAssignment(identity, options);
    if (!assignment || driverVehicle(assignment.vehicle) !== vehicle) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
    const assignedName = context === 'DATE_ROUTE' ? clean(assignment.driverName) : '';
    const assignmentPhone = driverPhone(assignment.driverPhone);
    if (options.revalidate) await options.revalidate();
    if (preferExactDatedContact && context === 'DATE_ROUTE' && (!assignedName || assignmentPhone)) {
      return {ok:true,data:{driverName:assignedName || null,phone:assignedName ? assignmentPhone : null},
        meta:{...identity,state:assignedName ? 'REGISTERED' : 'UNREGISTERED',source:'DATED_ASSIGNMENT',
          effectiveDate:null,phoneBasis:assignedName ? 'DATED_ASSIGNMENT' : 'UNAVAILABLE',checkedAt:assignment.checkedAt || null,
          assignmentVersion:null,assignmentCheckedAt:assignment.checkedAt || null,
          assignmentStale:assignment.stale===true,effectiveDateVerified:false,
          ...(!assignedName?{driverEvidence:'UNCONFIRMED'}:{})}};
    }
    const master = await readDriverMaster(date, assignment);
    if (!master || !Array.isArray(master.vehicles) || (!master.generatedAt && !master.sheetName))
      throw fail('DRIVER_SOURCE_UNAVAILABLE');
    const matching = master.vehicles.filter(row => driverVehicle(row.vehicle) === vehicle);
    if (matching.length > 1) throw fail('DRIVER_MASTER_CONFLICT', 409);
    const row = matching[0] || null;
    if (row?.conflict) throw fail('DRIVER_MASTER_CONFLICT', 409);
    const effectiveDate = validDate(row?.effectiveDate) ? row.effectiveDate : null;
    if (effectiveDate && effectiveDate > date) throw fail('DRIVER_EFFECTIVE_DATE_INVALID', 409);
    const masterName = clean(row?.driverName || row?.name);
    const name = context === 'DATE_ROUTE' ? assignedName : masterName;
    // A different historical driver's current phone is never substituted.
    const sameDriver = assignedName && key(assignedName) === key(masterName);
    const currentSnapshot = assignment.currentDeliveryVerified === true
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(master.generatedAt || '')
      && sourceTaskDate(master.generatedAt) === date;
    const phone = context === 'DATE_ROUTE'
      ? assignmentPhone || (sameDriver && (effectiveDate || currentSnapshot) ? driverPhone(row?.phone) : null)
      : driverPhone(row?.phone);
    const masterSource=row?.source==='FRESHON_VEHICLE_REGISTRATION'?'FRESHON_VEHICLE_REGISTRATION':'DRIVER_MASTER';
    const phoneBasis = !name || !phone ? 'UNAVAILABLE' : context === 'BASE' ? masterSource
      : assignmentPhone ? 'DATED_ASSIGNMENT' : effectiveDate ? 'EFFECTIVE_DATED_MASTER' : 'CURRENT_DELIVERY_MATCHED_MASTER';
    return { ok: true, data: { driverName: name || null, phone: name ? phone : null },
      meta: { ...identity, state: name ? phone ? 'REGISTERED' : 'PHONE_UNREGISTERED' : 'UNREGISTERED',
        source: context === 'DATE_ROUTE' ? 'DATED_ASSIGNMENT' : masterSource,
        effectiveDate, phoneBasis, checkedAt: master.generatedAt || null,
        assignmentVersion: assignment.version || null, assignmentCheckedAt: assignment.checkedAt || null,
        assignmentStale: assignment.stale === true, effectiveDateVerified: !!effectiveDate } };
  };
}

export function mountPrivateDriverContact({ app, requireStaff, readDriverMaster, readAssignment, datedIdentity, preferExactDatedContact, enabled=()=>true, readiness, validateQuery }) {
  const read = createDriverContactReader({ readDriverMaster, readAssignment, datedIdentity, preferExactDatedContact });
  const ensureStaff = (req,res) => new Promise((resolve,reject) => {
    const end = () => { cleanup(); reject(fail('DRIVER_SESSION_CLOSED')); };
    const cleanup = () => { res.off('finish',end); res.off('close',end); };
    if (res.headersSent || res.destroyed) return end();
    res.once('finish',end);
    res.once('close',end);
    Promise.resolve().then(() => requireStaff(req,res,() => { cleanup(); resolve(); })).catch(error => {
      cleanup();
      reject(error);
    });
  });
  app.get('/api/map-phase2b/private/driver-contact', requireStaff, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if(enabled()!==true)return res.status(503).json({ok:false,error:'DRIVER_CONTACT_DISABLED'});
    const unavailable = readiness?.();
    if (unavailable) return res.status(503).json({ok:false,error:unavailable});
    try {
      validateQuery?.(req.query);
      const result = await read(req.query,{revalidate:datedIdentity ? () => ensureStaff(req,res) : undefined});
      return requireStaff(req, res, () => res.json(result));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const code = /^DRIVER_[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'DRIVER_SOURCE_UNAVAILABLE';
      return res.status([400, 404, 409].includes(error.status) ? error.status : 503).json({ ok: false, error: code });
    }
  });
}
