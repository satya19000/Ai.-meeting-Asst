/**
 * routes/actions.js
 *
 * GET    /api/v1/actions              — list with filters
 * POST   /api/v1/actions              — create manually
 * GET    /api/v1/actions/:id          — single action
 * PATCH  /api/v1/actions/:id          — update status/assignment
 * DELETE /api/v1/actions/:id          — delete
 * POST   /api/v1/actions/:id/remind   — queue reminder notification
 */
const router = require("express").Router();
const { body, param, query } = require("express-validator");
const db    = require("../config/db");
const { authenticate, authorize, validate } = require("../middleware/auth");
const { addToQueue } = require("../queues");

router.get("/",
  authenticate,
  query("status").optional().isIn(["pending","in_progress","done","overdue","cancelled"]),
  query("priority").optional().isIn(["low","medium","high","critical"]),
  validate,
  async (req, res, next) => {
    try {
      const { status, priority, assigned_to, meeting_id, overdue, limit = 50, offset = 0 } = req.query;
      const conditions = ["a.org_id = $1"];
      const params = [req.user.org_id];
      let p = 2;

      if (status)      { conditions.push(`a.status = $${p++}`);      params.push(status); }
      if (priority)    { conditions.push(`a.priority = $${p++}`);    params.push(priority); }
      if (assigned_to) { conditions.push(`a.assigned_to = $${p++}`); params.push(assigned_to); }
      if (meeting_id)  { conditions.push(`a.meeting_id = $${p++}`);  params.push(meeting_id); }
      if (overdue === "true") {
        conditions.push("a.due_date < CURRENT_DATE");
        conditions.push("a.status NOT IN ('done','cancelled')");
      }

      const { rows } = await db.query(
        `SELECT
           a.*,
           m.title   AS meeting_title,
           m.platform,
           m.started_at AS meeting_date,
           u.full_name  AS assigned_to_name,
           u.email      AS assigned_to_email
         FROM action_items a
         JOIN meetings m ON m.id = a.meeting_id
         LEFT JOIN users u ON u.id = a.assigned_to
         WHERE ${conditions.join(" AND ")}
         ORDER BY
           CASE a.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
           CASE a.status   WHEN 'overdue'  THEN 1 WHEN 'pending' THEN 2 WHEN 'in_progress' THEN 3 ELSE 4 END,
           a.due_date ASC NULLS LAST
         LIMIT $${p++} OFFSET $${p}`,
        [...params, parseInt(limit), parseInt(offset)]
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

router.post("/",
  authenticate,
  body("meeting_id").isUUID(),
  body("task").notEmpty().trim(),
  body("priority").optional().isIn(["low","medium","high","critical"]),
  body("due_date").optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const {
        meeting_id, task, task_telugu, description, assigned_to,
        assigned_name, department, priority = "medium", due_date, notes,
      } = req.body;

      const { rows: [meeting] } = await db.query(
        "SELECT id FROM meetings WHERE id = $1 AND org_id = $2",
        [meeting_id, req.user.org_id]
      );
      if (!meeting) return res.status(404).json({ error: "Meeting not found" });

      const { rows } = await db.query(
        `INSERT INTO action_items
           (meeting_id, org_id, created_by, task, task_telugu, description,
            assigned_to, assigned_name, department, priority, due_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [meeting_id, req.user.org_id, req.user.id,
         task, task_telugu, description,
         assigned_to || null, assigned_name, department,
         priority, due_date || null, notes]
      );
      req.app.locals.io?.to(`org:${req.user.org_id}`).emit("action:created", rows[0]);
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.get("/:id",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT a.*, m.title AS meeting_title, u.full_name AS assigned_to_name
         FROM action_items a
         JOIN meetings m ON m.id = a.meeting_id
         LEFT JOIN users u ON u.id = a.assigned_to
         WHERE a.id = $1 AND a.org_id = $2`,
        [req.params.id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Action not found" });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.patch("/:id",
  authenticate,
  param("id").isUUID(),
  body("status").optional().isIn(["pending","in_progress","done","overdue","cancelled"]),
  body("priority").optional().isIn(["low","medium","high","critical"]),
  body("due_date").optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const allowed = ["status","assigned_to","assigned_name","due_date",
                       "priority","notes","task","task_telugu","department"];
      const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
      );
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: "No valid fields" });
      }
      if (updates.status === "done") updates.completed_at = new Date().toISOString();

      const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
      const { rows } = await db.query(
        `UPDATE action_items SET ${sets}, updated_at = NOW()
         WHERE id = $1 AND org_id = $${Object.keys(updates).length + 2}
         RETURNING *`,
        [req.params.id, ...Object.values(updates), req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Action not found" });
      req.app.locals.io?.to(`org:${req.user.org_id}`).emit("action:updated", rows[0]);
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.delete("/:id",
  authenticate,
  authorize("district_officer", "super_admin"),
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await db.query(
        "DELETE FROM action_items WHERE id = $1 AND org_id = $2",
        [req.params.id, req.user.org_id]
      );
      res.json({ message: "Action deleted" });
    } catch (err) { next(err); }
  }
);

router.post("/:id/remind",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT a.*, u.email, u.full_name, u.telegram_chat_id, u.whatsapp_number
         FROM action_items a LEFT JOIN users u ON u.id = a.assigned_to
         WHERE a.id = $1 AND a.org_id = $2`,
        [req.params.id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Action not found" });

      await addToQueue("notifications", { type: "ACTION_REMINDER", action: rows[0] });
      await db.query(
        "UPDATE action_items SET reminder_sent = TRUE, reminder_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      res.json({ message: "Reminder queued" });
    } catch (err) { next(err); }
  }
);

module.exports = router;
