// Map read/download boundary only. Collector, internal ingestion and existing
// administrator/authentication endpoints keep their independent authorization.
export const STAFF_MAP_READ_PATHS = Object.freeze([
  '/api/fixed-dispatch', '/api/fixed-dispatch/customer-search',
  '/api/monthly-dispatch-summary', '/api/monthly-dispatch-route',
  '/api/vehicle-driver-master', '/api/mobile/customer-search', '/api/daily-route',
  '/api/status', '/api/delivery-admin/status'
]);
export function isStaffMapReadPath(pathname) {
  let value;
  try { value = decodeURIComponent(pathname).toLowerCase(); } catch { return false; }
  if (/^\/api\/map-phase2b(?:\/|$)/.test(value)
    && !/^\/api\/map-phase2b\/(?:auth|admin)(?:\/|$)/.test(value)) return true;
  if (STAFF_MAP_READ_PATHS.includes(value.replace(/\/$/, ''))) return true;
  return /^\/(?:vehicle-data|new-area-data|admin-features)\.js\/?$/.test(value)
    || /\.(?:json|geojson|csv|tsv|xlsx?|zip)\/?$/.test(value) && !/^\/api\//.test(value);
}
export function mountMapStaffEntryGate(app, requireStaff) {
  if (typeof requireStaff !== 'function') throw Error('EXISTING_STAFF_AUTH_REQUIRED');
  app.use((req, res, next) => {
    if (!isStaffMapReadPath(req.path)) return next();
    return requireStaff(req, res, () => {
      // Revoke an in-flight JSON/download response after logout or expiry.
      const json = res.json.bind(res), send = res.send.bind(res);
      let checking = false;
      const checked = operation => {
        if (checking) return operation();
        checking = true;
        try { return requireStaff(req, res, operation); } finally { checking = false; }
      };
      res.json = value => checked(() => json(value));
      res.send = value => checked(() => send(value));
      next();
    });
  });
}
