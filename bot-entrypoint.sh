/**
 * routes/users.js
 *
 * GET    /api/v1/users              — list org users  (admin)
 * GET    /api/v1/users/me           — my profile
 * PUT    /api/v1/users/me           — update my profile
 * PUT    /api/v1/users/me/password  — change password
 * PUT    /api/v1/users/me/preferences — save notification/theme prefs
 * GET    /api/v1/users/:id          — get user  (admin)
 * PUT    /api/v1/users/:id/role     — change role  (super_admin)
 * DELETE /api/v1/users/:id          — deactivate  (super_admin)
 */
const router = require("express").Router();
const bcrypt = require("bcrypt");
const { body, param } = require("express-validator");
const db = require("../config/db");
const { authenticate, authorize, validate } = require("../middleware/auth");
const { auditLog } = require("../services/auditService");

// ─── My Profile ───────────────────────────────────────────────
router.get("/me", authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, org_id, full_name, email, role, designation, department,
              phone, avatar_url, telegram_chat_id, whatsapp_number,
              is_active, last_login_at, email_verified, two_fa_enabled,
              preferences, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.put("/me",
  authenticate,
  body("full_name").optional().trim().isLength({ min: 2, max: 200 }),
  body("phone").optional().isMobilePhone(),
  body("designation").optional().trim(),
  body("department").optional().trim(),
  body("telegram_chat_id").optional().trim(),
  body("whatsapp_number").optional().trim(),
  validate,
  async (req, res, next) => {
    try {
      const allowed = ["full_name","designation","department","phone",
                       "avatar_url","telegram_chat_id","whatsapp_number"];
      const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
      );
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: "No valid fields" });
      }
      const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
      const { rows } = await db.query(
        `UPDATE users SET ${sets}, updated_at = NOW()
         WHERE id = $1
         RETURNING id, full_name, email, role, designation, department,
                   phone, avatar_url, telegram_chat_id, whatsapp_number, preferences`,
        [req.user.id, ...Object.values(updates)]
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.put("/me/password",
  authenticate,
  body("current_password").notEmpty(),
  body("new_password").isLength({ min: 8 }),
  validate,
  async (req, res, next) => {
    try {
      const { current_password, new_password } = req.body;
      const { rows } = await db.query(
        "SELECT password_hash FROM users WHERE id = $1", [req.user.id]
      );
      const valid = await bcrypt.compare(current_password, rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: "Current password incorrect" });

      const hash = await bcrypt.hash(new_password, 12);
      await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.id]);
      res.json({ message: "Password updated" });
    } catch (err) { next(err); }
  }
);

router.put("/me/preferences", authenticate, async (req, res, next) => {
  try {
    const safe = {
      language:      req.body.language      || "en",
      theme:         req.body.theme         || "dark",
      notifications: req.body.notifications || {},
      timezone:      req.body.timezone      || "Asia/Kolkata",
    };
    const { rows } = await db.query(
      `UPDATE users SET preferences = $1, updated_at = NOW()
       WHERE id = $2 RETURNING preferences`,
      [JSON.stringify(safe), req.user.id]
    );
    res.json({ preferences: rows[0].preferences });
  } catch (err) { next(err); }
});

// ─── List users (admin) ───────────────────────────────────────
router.get("/",
  authenticate,
  authorize("district_officer", "super_admin"),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT id, full_name, email, role, designation, department,
                phone, is_active, last_login_at, avatar_url, created_at
         FROM users WHERE org_id = $1
         ORDER BY
           CASE role WHEN 'super_admin' THEN 1 WHEN 'district_officer' THEN 2
                     WHEN 'department_staff' THEN 3 ELSE 4 END,
           full_name ASC`,
        [req.user.org_id]
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

// ─── Get user by ID ───────────────────────────────────────────
router.get("/:id",
  authenticate,
  authorize("district_officer", "super_admin"),
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT id, full_name, email, role, designation, department,
                phone, is_active, last_login_at, avatar_url, created_at
         FROM users WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "User not found" });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ─── Change role ──────────────────────────────────────────────
router.put("/:id/role",
  authenticate,
  authorize("super_admin"),
  param("id").isUUID(),
  body("role").isIn(["super_admin","district_officer","department_staff","viewer"]),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE users SET role = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3 RETURNING id, full_name, role`,
        [req.body.role, req.params.id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "User not found" });
      await auditLog(req.user.id, req.user.org_id, "USER_ROLE_CHANGED", "users", req.params.id, null, { role: req.body.role });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ─── Deactivate user ──────────────────────────────────────────
router.delete("/:id",
  authenticate,
  authorize("super_admin"),
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: "Cannot deactivate your own account" });
      }
      await db.query(
        "UPDATE users SET is_active = FALSE WHERE id = $1 AND org_id = $2",
        [req.params.id, req.user.org_id]
      );
      await auditLog(req.user.id, req.user.org_id, "USER_DEACTIVATED", "users", req.params.id);
      res.json({ message: "User deactivated" });
    } catch (err) { next(err); }
  }
);

module.exports = router;
