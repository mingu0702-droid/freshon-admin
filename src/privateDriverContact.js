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
const fail = (code, status = 503) => Object.assign(Error(code), { code, status });

// Use existing cached fixed-dispatch evidence or a stored dated route; no collection.
export function createDriverAssignmentReader({ readBaseVehicles, readStoredRoute } = {}) {
  return async ({ customerCode, vehicle, date, context }) => {
    if (context === 'BASE') {
      if (!readBaseVehicles) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
      const result = await readBaseVehicles([customerCode]);
      const row = result?.data?.find(row => row.customerCode === customerCode);
      if (!result?.ok || !row) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
      if (row.baseVehicleState === 'CONFLICT') throw fail('DRIVER_ASSIGNMENT_CONFLICT', 409);
      if (row.baseVehicleState !== 'VERIFIED_MASTER' || row.baseVehicleSource !== 'FIXED_DISPATCH_PRIMARY'
          || !/^[a-f0-9]{64}$/.test(row.baseVehicleVersion || '')
          || driverVehicle(row.baseVehicle) !== vehicle) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
      return { vehicle, basis: 'FIXED_DISPATCH_PRIMARY', version: row.baseVehicleVersion,
        checkedAt: row.baseVehicleCheckedAt || null, stale: row.baseVehicleStale !== false };
    }
    if (!readStoredRoute) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
    const route = await readStoredRoute(date, vehicle);
    if (!route || clean(route.date || route.deliveryDate) !== date || driverVehicle(route.vehicle) !== vehicle)
      throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
    const matches = (route.stops || []).filter(row => clean(row.customerCode || row.code) === customerCode);
    if (!matches.length) throw fail('DRIVER_ASSIGNMENT_NOT_FOUND', 404);
    const identities = new Set(matches.map(row => key(row.driverName || route.driverName)).filter(Boolean));
    const phones = new Set(matches.map(row => driverPhone(row.driverPhone || route.driverPhone)).filter(Boolean).map(value => value.replace(/\D/g, '')));
    if (identities.size > 1 || phones.size > 1) throw fail('DRIVER_ASSIGNMENT_CONFLICT', 409);
    const row = matches[0];
    return { vehicle, basis: 'DATED_ASSIGNMENT', date,
      driverName: clean(row.driverName || route.driverName),
      driverPhone: driverPhone(row.driverPhone || route.driverPhone), stale: false };
  };
}

export function createDriverContactReader({ readDriverMaster, readAssignment } = {}) {
  return async input => {
    const customerCode = clean(input.customerCode), vehicle = driverVehicle(input.vehicle), date = clean(input.date), context = clean(input.context);
    if (!/^[A-Z]\d+$/.test(customerCode) || !vehicle || !validDate(date) || !['BASE', 'DATE_ROUTE'].includes(context))
      throw fail('DRIVER_CONTACT_INVALID_INPUT', 400);
    if (!readAssignment || !readDriverMaster) throw fail('DRIVER_SOURCE_NOT_CONFIGURED');
    const identity = { customerCode, vehicle, date, context };
    const assignment = await readAssignment(identity);
    if (!assignment || driverVehicle(assignment.vehicle) !== vehicle) throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);
    const master = await readDriverMaster(date);
    if (!master || !Array.isArray(master.vehicles) || (!master.generatedAt && !master.sheetName))
      throw fail('DRIVER_SOURCE_UNAVAILABLE');
    const matching = master.vehicles.filter(row => driverVehicle(row.vehicle) === vehicle);
    if (matching.length > 1) throw fail('DRIVER_MASTER_CONFLICT', 409);
    const row = matching[0] || null;
    if (row?.conflict) throw fail('DRIVER_MASTER_CONFLICT', 409);
    const effectiveDate = validDate(row?.effectiveDate) ? row.effectiveDate : null;
    if (effectiveDate && effectiveDate > date) throw fail('DRIVER_EFFECTIVE_DATE_INVALID', 409);
    const assignedName = context === 'DATE_ROUTE' ? clean(assignment.driverName) : '';
    const masterName = clean(row?.driverName || row?.name);
    const name = context === 'DATE_ROUTE' ? assignedName : masterName;
    // A different historical driver's current phone is never substituted.
    const sameDriver = assignedName && key(assignedName) === key(masterName);
    const phone = context === 'DATE_ROUTE'
      ? driverPhone(assignment.driverPhone) || (sameDriver && effectiveDate ? driverPhone(row?.phone) : null)
      : driverPhone(row?.phone);
    return { ok: true, data: { driverName: name || null, phone: name ? phone : null },
      meta: { ...identity, state: name ? phone ? 'REGISTERED' : 'PHONE_UNREGISTERED' : 'UNREGISTERED',
        source: context === 'DATE_ROUTE' ? 'DATED_ASSIGNMENT' : 'DRIVER_MASTER',
        effectiveDate, checkedAt: master.generatedAt || null,
        assignmentVersion: assignment.version || null, assignmentCheckedAt: assignment.checkedAt || null,
        assignmentStale: assignment.stale === true, effectiveDateVerified: !!effectiveDate } };
  };
}

export function mountPrivateDriverContact({ app, requireStaff, readDriverMaster, readAssignment }) {
  const read = createDriverContactReader({ readDriverMaster, readAssignment });
  app.get('/api/map-phase2b/private/driver-contact', requireStaff, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const result = await read(req.query);
      return requireStaff(req, res, () => res.json(result));
    } catch (error) {
      const code = /^DRIVER_[A-Z_]+$/.test(error.code || '') ? error.code : 'DRIVER_SOURCE_UNAVAILABLE';
      return res.status([400, 404, 409].includes(error.status) ? error.status : 503).json({ ok: false, error: code });
    }
  });
}
