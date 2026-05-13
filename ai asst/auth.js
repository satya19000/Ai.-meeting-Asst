/**
 * routes/auth.js  — Authentication endpoints
 * POST /api/v1/auth/register
 * POST /api/v1/auth/login
 * POST /api/v1/auth/refresh
 * POST /api/v1/auth/logout
 * POST /api/v1/auth/2fa/setup
 * POST /api/v1/auth/2fa/verify
 * POST /api/v1/auth/forgot-password
 * POST /api/v1/auth/reset-password
 */

const router  = require("express").Router();
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const crypto  = require("crypto");
const speakeasy = require("speakeasy");
const qrcode  = require("qrcode");
const { body } = require("express-validator");

const db      = require("../config/db");
const redis   = require("../config/redis");
const { validate, authenticate } = require("../middleware/auth");
const { sendEmail } = require("../services/notificationService");

const SALT_ROUNDS = 12;
const JWT_EXPIRY  = "15m";
const REFRESH_EXPIRY = "7d";

// ─── Token helpers ────────────────────────────────────────────
function issueTokens(userId) {
  const access = jwt.sign(
    { sub: userId, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  const refresh = jwt.sign(
    { sub: userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRY }
  );
  return { access, refresh };
}

// ─── REGISTER ─────────────────────────────────────────────────
router.post("/register",
  body("email").isEmail().normalizeEmail(),
  body("password").isLength({ min: 8 }),
  body("full_name").notEmpty().trim(),
  validate,
  async (req, res, next) => {
    try {
      const { email, password, full_name, org_id, designation, department, phone } = req.body;

      const { rows: existing } = await db.query(
        "SELECT id FROM users WHERE email = $1", [email]
      );
      if (existing.length) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      const { rows } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, org_id, designation, department, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, email, full_name, role, org_id`,
        [email, hash, full_name, org_id || null, designation, department, phone]
      );

      const user = rows[0];
      const { access, refresh } = issueTokens(user.id);

      // Store refresh token hash
      const refreshHash = crypto.createHash("sha256").update(refresh).digest("hex");
      await db.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
        [user.id, refreshHash]
      );

      res.status(201).json({ user, access_token: access, refresh_token: refresh });
    } catch (err) { next(err); }
  }
);

// ─── LOGIN ────────────────────────────────────────────────────
router.post("/login",
  body("email").isEmail().normalizeEmail(),
  body("password").notEmpty(),
  validate,
  async (req, res, next) => {
    try {
      const { email, password, totp_code } = req.body;

      const { rows } = await db.query(
        `SELECT id, email, full_name, role, org_id, password_hash,
                two_fa_enabled, two_fa_secret, is_active, preferences
         FROM users WHERE email = $1`,
        [email]
      );

      const user = rows[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });

      // 2FA check
      if (user.two_fa_enabled) {
        if (!totp_code) {
          return res.status(200).json({ requires_2fa: true });
        }
        const ok = speakeasy.totp.verify({
          secret:   user.two_fa_secret,
          encoding: "base32",
          token:    totp_code,
          window:   1,
        });
        if (!ok) return res.status(401).json({ error: "Invalid 2FA code" });
      }

      // Update last login
      await db.query(
        "UPDATE users SET last_login_at = NOW() WHERE id = $1",
        [user.id]
      );

      const { access, refresh } = issueTokens(user.id);
      const refreshHash = crypto.createHash("sha256").update(refresh).digest("hex");
      await db.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
        [user.id, refreshHash, { ua: req.headers["user-agent"], ip: req.ip }]
      );

      const { password_hash, two_fa_secret, ...safeUser } = user;
      res.json({ user: safeUser, access_token: access, refresh_token: refresh });
    } catch (err) { next(err); }
  }
);

// ─── REFRESH ─────────────────────────────────────────────────
router.post("/refresh", async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: "Refresh token required" });

    const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const hash = crypto.createHash("sha256").update(refresh_token).digest("hex");

    const { rows } = await db.query(
      `SELECT * FROM refresh_tokens
       WHERE token_hash = $1 AND user_id = $2
         AND revoked_at IS NULL AND expires_at > NOW()`,
      [hash, payload.sub]
    );
    if (!rows[0]) return res.status(401).json({ error: "Invalid refresh token" });

    // Rotate: revoke old, issue new
    await db.query(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1",
      [rows[0].id]
    );

    const { access, refresh: newRefresh } = issueTokens(payload.sub);
    const newHash = crypto.createHash("sha256").update(newRefresh).digest("hex");
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [payload.sub, newHash]
    );

    res.json({ access_token: access, refresh_token: newRefresh });
  } catch (err) {
    if (err.name === "JsonWebTokenError") return res.status(401).json({ error: "Invalid token" });
    next(err);
  }
});

// ─── LOGOUT ──────────────────────────────────────────────────
router.post("/logout", authenticate, async (req, res, next) => {
  try {
    // Blacklist access token until expiry
    const decoded = jwt.decode(req.token);
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await redis.setex(`bl:${req.token}`, ttl, "1");

    // Revoke all refresh tokens for this session
    const { refresh_token } = req.body;
    if (refresh_token) {
      const hash = crypto.createHash("sha256").update(refresh_token).digest("hex");
      await db.query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1",
        [hash]
      );
    }

    res.json({ message: "Logged out successfully" });
  } catch (err) { next(err); }
});

// ─── 2FA SETUP ───────────────────────────────────────────────
router.post("/2fa/setup", authenticate, async (req, res, next) => {
  try {
    const secret = speakeasy.generateSecret({ name: `MeetIQ (${req.user.email})` });
    const qr = await qrcode.toDataURL(secret.otpauth_url);

    // Temporarily store secret (not enabled until verified)
    await redis.setex(`2fa_setup:${req.user.id}`, 600, secret.base32);

    res.json({ qr_code: qr, manual_key: secret.base32 });
  } catch (err) { next(err); }
});

router.post("/2fa/verify", authenticate, async (req, res, next) => {
  try {
    const { code } = req.body;
    const secret = await redis.get(`2fa_setup:${req.user.id}`);
    if (!secret) return res.status(400).json({ error: "2FA setup expired, restart" });

    const ok = speakeasy.totp.verify({ secret, encoding: "base32", token: code, window: 1 });
    if (!ok) return res.status(400).json({ error: "Invalid code" });

    await db.query(
      "UPDATE users SET two_fa_secret = $1, two_fa_enabled = TRUE WHERE id = $2",
      [secret, req.user.id]
    );
    await redis.del(`2fa_setup:${req.user.id}`);

    res.json({ message: "2FA enabled successfully" });
  } catch (err) { next(err); }
});

// ─── FORGOT / RESET PASSWORD ─────────────────────────────────
router.post("/forgot-password",
  body("email").isEmail().normalizeEmail(),
  validate,
  async (req, res, next) => {
    try {
      const { email } = req.body;
      const { rows } = await db.query("SELECT id, full_name FROM users WHERE email = $1", [email]);
      if (!rows[0]) return res.json({ message: "If that email exists, a link was sent." });

      const token = crypto.randomBytes(32).toString("hex");
      await redis.setex(`pwd_reset:${token}`, 3600, rows[0].id);

      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
      await sendEmail({
        to:      email,
        subject: "MeetIQ — Password Reset",
        html:    `<p>Hello ${rows[0].full_name},</p>
                  <p>Click <a href="${resetUrl}">here</a> to reset your password (valid 1 hour).</p>`,
      });

      res.json({ message: "If that email exists, a link was sent." });
    } catch (err) { next(err); }
  }
);

router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password?.length >= 8) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const userId = await redis.get(`pwd_reset:${token}`);
    if (!userId) return res.status(400).json({ error: "Token expired or invalid" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, userId]);
    await redis.del(`pwd_reset:${token}`);

    res.json({ message: "Password reset successfully" });
  } catch (err) { next(err); }
});

module.exports = router;
