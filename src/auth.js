import { config } from "./config.js";

export function requireAdmin(req, res, next) {
  if (!config.adminToken) {
    return res.status(500).json({ error: "ADMIN_TOKEN is not configured." });
  }
  const provided = req.get("x-admin-token") || req.query.token || "";
  if (provided !== config.adminToken) {
    return res.status(401).json({ error: "Admin token required." });
  }
  return next();
}

export function requireView(req, res, next) {
  if (config.publicView) return next();
  return requireAdmin(req, res, next);
}
