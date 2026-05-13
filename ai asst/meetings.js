/**
 * routes/meetings.js  — Meeting management
 *
 * GET    /api/v1/meetings            — list (with filters)
 * POST   /api/v1/meetings            — create
 * GET    /api/v1/meetings/:id        — get one with full details
 * PUT    /api/v1/meetings/:id        — update
 * DELETE /api/v1/meetings/:id        — soft-delete
 * POST   /api/v1/meetings/:id/start  — mark as started
 * POST   /api/v1/meetings/:id/end    — mark as ended → trigger AI pipeline
 * GET    /api/v1/meetings/:id/status — live status (poll or WS)
 */

const router = require("express").Router();
const { body, query, param } = require("express-validator");
const db     = require("../config/db");
const redis  = require("../config/redis");
const { authenticate, authorize, validate } = require("../middleware/auth");
const { addToQueue } = require("../queues");
const { auditLog }   = require("../services/auditService");

// ─── List meetings ────────────────────────────────────────────
router.get("/",
  authenticate,
  query("status").optional().isIn(["scheduled","joining","live","processing","done","failed","cancelled"]),
  query("platform").optional().isIn(["zoom","google_meet","teams","webex","other"]),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("offset").optional().isInt({ min: 0 }),
  validate,
  async (req, res, next) => {
    try {
      const { status, platform, from, to, limit = 20, offset = 0 } = req.query;
      const orgId = req.user.org_id;

      const conditions = ["m.org_id = $1", "m.status != 'cancelled'"];
      const params = [orgId];
      let p = 2;

      if (status)   { conditions.push(`m.status = $${p++}`);   params.push(status); }
      if (platform) { conditions.push(`m.platform = $${p++}`); params.push(platform); }
      if (from)     { conditions.push(`m.scheduled_at >= $${p++}`); params.push(from); }
      if (to)       { conditions.push(`m.scheduled_at <= $${p++}`); params.push(to); }

      // Viewers only see non-private meetings
      if (req.user.role === "viewer") conditions.push("m.is_private = FALSE");

      const where = conditions.join(" AND ");
      const { rows: meetings } = await db.query(
        `SELECT m.*, u.full_name AS created_by_name,
                (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id AND a.status != 'done') AS pending_actions,
                (SELECT COUNT(*) FROM summaries s WHERE s.meeting_id = m.id) AS summary_count
         FROM meetings m
         JOIN users u ON u.id = m.created_by
         WHERE ${where}
         ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, parseInt(limit), parseInt(offset)]
      );

      const { rows: countRow } = await db.query(
        `SELECT COUNT(*) FROM meetings m WHERE ${where}`,
        params.slice(0, p - 3)
      );

      res.json({
        meetings,
        total:  parseInt(countRow[0].count),
        limit:  parseInt(limit),
        offset: parseInt(offset),
      });
    } catch (err) { next(err); }
  }
);

// ─── Create meeting ───────────────────────────────────────────
router.post("/",
  authenticate,
  authorize("district_officer", "super_admin", "department_staff"),
  body("title").notEmpty().trim().isLength({ max: 255 }),
  body("platform").isIn(["zoom","google_meet","teams","webex","other"]),
  body("scheduled_at").optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const {
        title, description, platform, meeting_link, meeting_id: mid,
        passcode, host_email, scheduled_at, venue, agenda, tags, is_private,
        bot_config = {}
      } = req.body;

      // Encrypt sensitive fields
      const { encryptField } = require("../services/encryptionService");
      const encLink    = meeting_link ? encryptField(meeting_link)    : null;
      const encPass    = passcode     ? encryptField(passcode)        : null;
      const encMid     = mid          ? encryptField(mid)             : null;
      const encEmail   = host_email   ? encryptField(host_email)      : null;

      const { rows } = await db.query(
        `INSERT INTO meetings
           (org_id, created_by, title, description, platform, meeting_link,
            meeting_id, passcode, host_email, scheduled_at, venue, agenda, tags, is_private)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          req.user.org_id, req.user.id, title, description, platform,
          encLink, encMid, encPass, encEmail,
          scheduled_at || null, venue,
          agenda || [], tags || [],
          is_private || false,
        ]
      );

      const meeting = rows[0];

      // Cache bot config
      if (Object.keys(bot_config).length) {
        await redis.set(
          `bot_config:${meeting.id}`,
          JSON.stringify({ ...bot_config, meeting_id: meeting.id }),
          "EX", 86400
        );
      }

      await auditLog(req.user.id, req.user.org_id, "MEETING_CREATED", "meetings", meeting.id, null, meeting);

      // Emit to connected org members
      req.app.locals.io?.to(`org:${req.user.org_id}`).emit("meeting:created", meeting);

      res.status(201).json(meeting);
    } catch (err) { next(err); }
  }
);

// ─── Get one meeting ──────────────────────────────────────────
router.get("/:id",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT m.*,
           u.full_name          AS created_by_name,
           u.email              AS created_by_email,
           bs.status            AS bot_status,
           bs.joined_at         AS bot_joined_at,
           bs.bytes_recorded    AS bot_bytes_recorded,
           (SELECT json_agg(row_to_json(p)) FROM meeting_participants p WHERE p.meeting_id = m.id) AS participants,
           (SELECT json_agg(row_to_json(a)) FROM action_items a WHERE a.meeting_id = m.id ORDER BY a.priority DESC) AS actions,
           (SELECT row_to_json(s) FROM summaries s WHERE s.meeting_id = m.id AND s.type = 'brief' LIMIT 1) AS brief_summary,
           (SELECT row_to_json(mom) FROM minutes_of_meeting mom WHERE mom.meeting_id = m.id LIMIT 1) AS mom,
           (SELECT COUNT(*) FROM slide_captures sc WHERE sc.meeting_id = m.id) AS slide_count
         FROM meetings m
         JOIN users u ON u.id = m.created_by
         LEFT JOIN LATERAL (
           SELECT * FROM bot_sessions WHERE meeting_id = m.id ORDER BY created_at DESC LIMIT 1
         ) bs ON TRUE
         WHERE m.id = $1 AND m.org_id = $2`,
        [req.params.id, req.user.org_id]
      );

      if (!rows[0]) return res.status(404).json({ error: "Meeting not found" });

      // Decrypt sensitive fields before returning
      const { decryptField } = require("../services/encryptionService");
      const m = rows[0];
      if (m.meeting_link) m.meeting_link = decryptField(m.meeting_link);
      if (m.passcode)     m.passcode     = decryptField(m.passcode);

      res.json(m);
    } catch (err) { next(err); }
  }
);

// ─── Update meeting ───────────────────────────────────────────
router.put("/:id",
  authenticate,
  authorize("district_officer", "super_admin", "department_staff"),
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const allowed = ["title","description","scheduled_at","venue","agenda","tags","is_private"];
      const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
      );
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      const sets  = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
      const vals  = Object.values(updates);

      const { rows } = await db.query(
        `UPDATE meetings SET ${sets}, updated_at = NOW()
         WHERE id = $1 AND org_id = $${vals.length + 2}
         RETURNING *`,
        [req.params.id, ...vals, req.user.org_id]
      );

      if (!rows[0]) return res.status(404).json({ error: "Meeting not found" });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ─── Start meeting (manual trigger) ──────────────────────────
router.post("/:id/start",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE meetings SET status = 'live', started_at = NOW()
         WHERE id = $1 AND org_id = $2
           AND status IN ('scheduled', 'joining')
         RETURNING *`,
        [req.params.id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Meeting not found or already started" });

      req.app.locals.io?.to(`meeting:${req.params.id}`).emit("meeting:started", rows[0]);
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ─── End meeting → triggers full AI pipeline ─────────────────
router.post("/:id/end",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE meetings SET status = 'processing', ended_at = NOW()
         WHERE id = $1 AND org_id = $2 AND status = 'live'
         RETURNING *`,
        [req.params.id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Meeting not found or not live" });

      const meeting = rows[0];

      // Queue AI processing pipeline:
      // 1. Transcribe audio  →  2. Generate summary  →  3. Extract actions  →  4. Create MoM  →  5. Notify
      await addToQueue("ai-pipeline", {
        type:       "FULL_PIPELINE",
        meeting_id: meeting.id,
        org_id:     req.user.org_id,
        triggered_by: req.user.id,
      }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });

      req.app.locals.io?.to(`org:${req.user.org_id}`).emit("meeting:ended", { id: meeting.id, status: "processing" });

      res.json({ meeting, message: "Meeting ended — AI processing started" });
    } catch (err) { next(err); }
  }
);

// ─── Delete meeting ───────────────────────────────────────────
router.delete("/:id",
  authenticate,
  authorize("super_admin", "district_officer"),
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await db.query(
        "UPDATE meetings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND org_id = $2",
        [req.params.id, req.user.org_id]
      );
      await auditLog(req.user.id, req.user.org_id, "MEETING_DELETED", "meetings", req.params.id);
      res.json({ message: "Meeting cancelled" });
    } catch (err) { next(err); }
  }
);

module.exports = router;
