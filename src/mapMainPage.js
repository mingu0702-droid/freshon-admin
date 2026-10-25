import path from 'node:path';

// One UI document for the main map and the existing review entry. No data or
// authentication contracts change here; legacy WMS links remain available.
export function mountMapMainPage(app, { publicDir, enabled }) {
  app.get(['/', '/index.html', '/daily-routes.html'], (req, res, next) => {
    if (!enabled() || req.query.tab === 'wms') return next();
    return res.sendFile(path.join(publicDir, 'map-phase2b-preview.html'));
  });
}
