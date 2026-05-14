/**
 * routes/bot.js
 *
 * POST /api/v1/bot/launch                       — queue bot for a meeting
 * GET  /api/v1/bot/session/:session_id          — session status + live metrics
 * POST /api/v1/bot/session/:session_id/terminate— stop bot
 * GET  /api/v1/bot/sessions?meeting_id=         — list sessions for a meeting
 */
const router = require("express").Router();
const { body, param } = require("express-validator");
const db      = require("../config/db");
const redis   = require("../config/redis");
const { authenticate, authorize, validate } = require("../middleware/auth");
const { addToQueue } = require("../queues");
const { decryptField } = require("../services/encryptionService");

// ─── Launch bot ───────────────────────────────────────────────
router.post("/launch",
  authenticate,
  authorize("district_officer", "super_admin", "department_staff"),
  body("meeting_id").isUUID(),
  body("record_audio").optional().isBoolean(),
  body("capture_screen").optional().isBoolean(),
  body("transcribe").optional().isBoolean(),
  validate,
  async (req, res, next) => {
    try {
      const {
        meeting_id,
        bot_name       = "MeetIQ Recorder",
        record_audio   = true,
        capture_screen = true,
        transcribe     = true,
        language       = "mixed",
        auto_generate_mom = true,
      } = req.body;

      // Verify meeting belongs to this org
      const { rows } = await db.query(
        "SELECT * FROM meetings WHERE id = $1 AND org_id = $2 AND status NOT IN ('done','cancelled','failed')",
        [meeting_id, req.user.org_id]
      );
      if (!rows[0]) {
        return res.status(404).json({ error: "Meeting not found or not in a joinable state" });
      }

      const meeting = rows[0];

      // Prevent duplicate active bots for same meeting
      const { rows: activeSessions } = await db.query(
        "SELECT id FROM bot_sessions WHERE meeting_id = $1 AND status IN ('joining','active')",
        [meeting_id]
      );
      if (activeSessions.length) {
        return res.status(409).json({ error: "Bot already active for this meeting", session_id: activeSessions[0].id });
      }

      // Create bot session record
      const { rows: [session] } = await db.query(
        `INSERT INTO bot_sessions (meeting_id, bot_name, status)
         VALUES ($1, $2, 'idle')
         RETURNING *`,
        [meeting_id, bot_name]
      );

      // Decrypt meeting credentials for the bot
      const decryptedLink = meeting.meeting_link ? decryptField(meeting.meeting_link) : null;
      if (!decryptedLink) {
        return res.status(400).json({ error: "Meeting link not set — add it before launching the bot" });
      }

      // Update meeting status to joining
      await db.query(
        "UPDATE meetings SET status = 'joining' WHERE id = $1",
        [meeting_id]
      );

      // Push bot job to Redis queue (bot/worker.js polls this)
      await redis.rpush("bot:job_queue", JSON.stringify({
        type:         "JOIN_MEETING",
        session_id:   session.id,
        meeting_id,
        meeting_link: decryptedLink,
        passcode:     meeting.passcode ? decryptField(meeting.passcode) : null,
        platform:     meeting.platform,
        config:       { bot_name, record_audio, capture_screen, transcribe, language, auto_generate_mom },
      }));

      // Emit to frontend
      req.app.locals.io?.to(`meeting:${meeting_id}`).emit("bot:launching", {
        session_id: session.id,
        bot_name,
      });

      res.status(201).json({
        session,
        message: "Bot queued for launch — will join shortly",
      });
    } catch (err) { next(err); }
  }
);

// ─── Session status ───────────────────────────────────────────
router.get("/session/:session_id",
  authenticate,
  param("session_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT bs.*, m.org_id
         FROM bot_sessions bs
         JOIN meetings m ON m.id = bs.meeting_id
         WHERE bs.id = $1`,
        [req.params.session_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Session not found" });
      if (rows[0].org_id !== req.user.org_id && req.user.role !== "super_admin") {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Overlay live metrics from Redis
      const metrics = await redis.get(`bot_metrics:${req.params.session_id}`);
      const { org_id, ...session } = rows[0];

      res.json({ ...session, live_metrics: metrics ? JSON.parse(metrics) : null });
    } catch (err) { next(err); }
  }
);

// ─── Terminate bot ────────────────────────────────────────────
router.post("/session/:session_id/terminate",
  authenticate,
  authorize("district_officer", "super_admin", "department_staff"),
  param("session_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      // Signal the bot worker via pub/sub
      await redis.publish("bot:commands", JSON.stringify({
        cmd:        "TERMINATE",
        session_id: req.params.session_id,
        reason:     req.body.reason || "user_request",
        by:         req.user.id,
      }));

      // Update DB
      await db.query(
        "UPDATE bot_sessions SET status = 'ended', left_at = NOW() WHERE id = $1",
        [req.params.session_id]
      );

      res.json({ message: "Terminate signal sent — bot will stop shortly" });
    } catch (err) { next(err); }
  }
);

// ─── List sessions for a meeting ─────────────────────────────
router.get("/sessions",
  authenticate,
  async (req, res, next) => {
    try {
      const { meeting_id } = req.query;
      if (!meeting_id) return res.status(400).json({ error: "meeting_id required" });

      const { rows } = await db.query(
        `SELECT bs.*
         FROM bot_sessions bs
         JOIN meetings m ON m.id = bs.meeting_id
         WHERE bs.meeting_id = $1 AND m.org_id = $2
         ORDER BY bs.created_at DESC`,
        [meeting_id, req.user.org_id]
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

module.exports = router;
