// ═══════════════════════════════════════════════
//  middleware/auth.js  — JWT authentication
// ═══════════════════════════════════════════════
const jwt    = require("jsonwebtoken");
const db     = require("../config/db");
const redis  = require("../config/redis");

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = header.slice(7);

    // Check token blacklist (logout)
    const blacklisted = await redis.get(`bl:${token}`);
    if (blacklisted) {
      return res.status(401).json({ error: "Token revoked" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Load user
    const { rows } = await db.query(
      `SELECT id, org_id, full_name, email, role, is_active, preferences
       FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (!rows[0] || !rows[0].is_active) {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    req.user  = rows[0];
    req.token = token;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ─── Role guard ──────────────────────────────
const ROLE_HIERARCHY = { super_admin: 4, district_officer: 3, department_staff: 2, viewer: 1 };

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    const allowed = roles.some(r =>
      r === req.user.role || ROLE_HIERARCHY[req.user.role] > ROLE_HIERARCHY[r]
    );
    if (!allowed) return res.status(403).json({ error: "Insufficient permissions" });
    next();
  };
}

// ─── Same-org guard ──────────────────────────
function sameOrg(req, res, next) {
  if (req.user.role === "super_admin") return next();
  const orgParam = req.params.orgId || req.body.orgId;
  if (orgParam && orgParam !== req.user.org_id) {
    return res.status(403).json({ error: "Cross-org access denied" });
  }
  next();
}

// ─── Error Handler ───────────────────────────
function errorHandler(err, req, res, _next) {
  const logger = require("../config/logger");

  const status = err.status || err.statusCode || 500;
  const message = err.expose ? err.message : (status < 500 ? err.message : "Internal server error");

  if (status >= 500) logger.error(err);

  res.status(status).json({
    error:  message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
}

function notFound(req, res) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}

// ─── Validation helper ───────────────────────
const { validationResult } = require("express-validator");
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  next();
}

module.exports = { authenticate, authorize, sameOrg, errorHandler, notFound, validate };
