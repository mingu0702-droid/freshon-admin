import crypto from "node:crypto";

// Public-view permission never grants access to credentials or raw source data.
export function sensitiveAuth(token, { allowLegacyQuery = false } = {}) {
  return (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    const supplied = req.get("x-admin-token") || (allowLegacyQuery ? req.query.token : "") || "";
    const a = Buffer.from(String(supplied)), b = Buffer.from(String(token || ""));
    if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: "AUTHENTICATION_REQUIRED" });
    }
    res.locals.sensitiveAuthenticated = true;
    return next();
  };
}

export function sensitiveKey(key) {
  return /password|passwd|pwd|rawmemo|message|memo|remark|access|securitykey|door|entrycode|phone|mobilephone|tel(?:ephone)?$|claim|comment|requesttext|detailaddress|비밀번호|비번|출입|보안키|요청사항|메모|특이사항|전화|연락처|클레임/i.test(String(key).replace(/[_\s-]/g, ""));
}

export function publicMapValue(value) {
  if (Array.isArray(value)) return value.map(publicMapValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveKey(key)).map(([key, item]) => [key, publicMapValue(item)]));
}

export function publicCustomerDetail(value = {}) {
  return Object.fromEntries(["customerCode", "customerName", "address", "vehicle", "status"].map(key => [key, value[key] ?? null]));
}

export function publicResponse(req, res, next) {
  if (!req.path.startsWith("/api/map-phase2b/preview/")) return next();
  const json = res.json.bind(res);
  res.json = value => json(publicMapValue(value));
  res.setHeader("Cache-Control", "no-store");
  next();
}

export function securityAudit(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  const started = new Date().toISOString();
  res.on("finish", () => console.info(JSON.stringify({ component: "security-access", timestamp: started,
    endpoint: req.path, status: res.statusCode, authenticated: !!res.locals.sensitiveAuthenticated,
    peerHash: crypto.createHash("sha256").update(String(req.ip || "")).digest("hex").slice(0, 20) })));
  next();
}
