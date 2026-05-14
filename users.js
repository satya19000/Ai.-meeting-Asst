// ════════════════════════════════════════════════════════════════
//  routes/bot.js  — Meeting Bot Control
// ════════════════════════════════════════════════════════════════
const router = require("express").Router();
const { body, param } = require("express-validator");
const db     = require("../config/db");
const redis  = require("../config/redis");
const { authenticate, authorize, validate } = require("../middleware/auth");
const { addToQueue } = require("../queues");

// Launch bot for a meeting
router.post("/launch",
  authenticate,
  authorize("district_officer", "super_admin", "department_staff"),
  body("meeting_id").isUUID(),
  body("bot_name").optional().trim(),
  validate,
  async (req, res, next) => {
    try {
      const {
        meeting_id, bot_name = "MeetIQ Recorder",
        record_audio = true, capture_screen = true,
        transcribe = true, language = "mixed",
        auto_generate_mom = true,
      } = req.body;

      // Verify meeting belongs to org
      const { rows } = await db.query(
        "SELECT * FROM meetings WHERE id = $1 AND org_id = $2",
        [meeting_id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Meeting not found" });

      // Create bot session record
      const { rows: session } = await db.query(
        `INSERT INTO bot_sessions (meeting_id, bot_name, status)
         VALUES ($1, $2, 'idle')
         RETURNING *`,
        [meeting_id, bot_name]
      );

      // Update meeting status
      await db.query(
        "UPDATE meetings SET status = 'joining' WHERE id = $1",
        [meeting_id]
      );

      // Queue bot job
      await addToQueue("bot-worker", {
        type: "JOIN_MEETING",
        session_id:  session[0].id,
        meeting_id,
        meeting_link: rows[0].meeting_link, // decrypted by worker
        config: { bot_name, record_audio, capture_screen, transcribe, language, auto_generate_mom },
      }, { attempts: 2, timeout: 300000 });

      req.app.locals.io?.to(`meeting:${meeting_id}`).emit("bot:launching", { session_id: session[0].id });

      res.json({ session: session[0], message: "Bot queued for launch" });
    } catch (err) { next(err); }
  }
);

// Get bot session status
router.get("/session/:session_id",
  authenticate,
  param("session_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM bot_sessions WHERE id = $1",
        [req.params.session_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Session not found" });

      // Get live metrics from Redis if active
      const metrics = await redis.get(`bot_metrics:${req.params.session_id}`);
      res.json({ ...rows[0], live_metrics: metrics ? JSON.parse(metrics) : null });
    } catch (err) { next(err); }
  }
);

// Terminate bot
router.post("/session/:session_id/terminate",
  authenticate,
  param("session_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await redis.publish("bot:commands", JSON.stringify({
        cmd: "TERMINATE",
        session_id: req.params.session_id,
      }));
      await db.query(
        "UPDATE bot_sessions SET status = 'ended', left_at = NOW() WHERE id = $1",
        [req.params.session_id]
      );
      res.json({ message: "Terminate signal sent" });
    } catch (err) { next(err); }
  }
);

module.exports = router;

// ════════════════════════════════════════════════════════════════
//  routes/actions.js  — Action items CRUD + reminders
// ════════════════════════════════════════════════════════════════
const actionsRouter = require("express").Router();

actionsRouter.get("/",
  authenticate,
  async (req, res, next) => {
    try {
      const { status, priority, assigned_to, meeting_id, overdue } = req.query;
      const conditions = ["a.org_id = $1"];
      const params = [req.user.org_id];
      let p = 2;

      if (status)      { conditions.push(`a.status = $${p++}`);      params.push(status); }
      if (priority)    { conditions.push(`a.priority = $${p++}`);    params.push(priority); }
      if (assigned_to) { conditions.push(`a.assigned_to = $${p++}`); params.push(assigned_to); }
      if (meeting_id)  { conditions.push(`a.meeting_id = $${p++}`);  params.push(meeting_id); }
      if (overdue === "true") conditions.push("a.due_date < CURRENT_DATE AND a.status NOT IN ('done','cancelled')");

      const { rows } = await db.query(
        `SELECT a.*, m.title AS meeting_title, m.platform,
                u.full_name AS assigned_to_name, u.email AS assigned_to_email
         FROM action_items a
         JOIN meetings m ON m.id = a.meeting_id
         LEFT JOIN users u ON u.id = a.assigned_to
         WHERE ${conditions.join(" AND ")}
         ORDER BY
           CASE a.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
           a.due_date ASC NULLS LAST`,
        params
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

actionsRouter.patch("/:id",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const allowed = ["status","assigned_to","assigned_name","due_date","priority","notes","task","department"];
      const updates = Object.fromEntries(
        Object.entries(req.body).filter(([k]) => allowed.includes(k))
      );

      if (updates.status === "done") updates.completed_at = new Date().toISOString();

      const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
      const vals = Object.values(updates);

      const { rows } = await db.query(
        `UPDATE action_items SET ${sets}, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, ...vals]
      );
      if (!rows[0]) return res.status(404).json({ error: "Action not found" });

      req.app.locals.io?.to(`org:${req.user.org_id}`).emit("action:updated", rows[0]);
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

actionsRouter.post("/:id/remind",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT a.*, u.email, u.full_name, u.telegram_chat_id, u.whatsapp_number
         FROM action_items a LEFT JOIN users u ON u.id = a.assigned_to
         WHERE a.id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Action not found" });

      await addToQueue("notifications", {
        type: "ACTION_REMINDER",
        action: rows[0],
        triggered_by: req.user.id,
      });

      await db.query(
        "UPDATE action_items SET reminder_sent = TRUE, reminder_at = NOW() WHERE id = $1",
        [req.params.id]
      );

      res.json({ message: "Reminder queued" });
    } catch (err) { next(err); }
  }
);

module.exports.actionsRouter = actionsRouter;


// ════════════════════════════════════════════════════════════════
//  routes/summaries.js
// ════════════════════════════════════════════════════════════════
const summaryRouter = require("express").Router();

summaryRouter.get("/meeting/:meeting_id",
  authenticate,
  param("meeting_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM summaries WHERE meeting_id = $1 ORDER BY created_at DESC",
        [req.params.meeting_id]
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

summaryRouter.post("/generate",
  authenticate,
  body("meeting_id").isUUID(),
  body("type").isIn(["brief","detailed","bilingual","telugu"]),
  validate,
  async (req, res, next) => {
    try {
      const { meeting_id, type, force_regenerate = false } = req.body;

      // Check if already exists
      if (!force_regenerate) {
        const { rows } = await db.query(
          "SELECT * FROM summaries WHERE meeting_id = $1 AND type = $2",
          [meeting_id, type]
        );
        if (rows[0]) return res.json(rows[0]);
      }

      // Queue AI summary job
      const job = await addToQueue("ai-pipeline", {
        type: "GENERATE_SUMMARY",
        meeting_id,
        summary_type: type,
        requested_by: req.user.id,
      });

      res.status(202).json({ message: "Summary generation queued", job_id: job.id });
    } catch (err) { next(err); }
  }
);

module.exports.summaryRouter = summaryRouter;


// ════════════════════════════════════════════════════════════════
//  routes/mom.js  — Minutes of Meeting
// ════════════════════════════════════════════════════════════════
const momRouter = require("express").Router();

momRouter.get("/:meeting_id",
  authenticate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT mom.*, m.title AS meeting_title, m.platform, m.started_at,
                u.full_name AS generated_by_name
         FROM minutes_of_meeting mom
         JOIN meetings m ON m.id = mom.meeting_id
         LEFT JOIN users u ON u.id = mom.generated_by
         WHERE mom.meeting_id = $1 AND m.org_id = $2
         ORDER BY mom.created_at DESC LIMIT 1`,
        [req.params.meeting_id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "MoM not generated yet" });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

momRouter.post("/generate",
  authenticate,
  body("meeting_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { meeting_id, include_telugu = true } = req.body;
      const job = await addToQueue("ai-pipeline", {
        type: "GENERATE_MOM",
        meeting_id,
        include_telugu,
        requested_by: req.user.id,
        org_id: req.user.org_id,
      });
      res.status(202).json({ message: "MoM generation queued", job_id: job.id });
    } catch (err) { next(err); }
  }
);

momRouter.post("/:mom_id/approve",
  authenticate,
  authorize("district_officer", "super_admin"),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE minutes_of_meeting
         SET is_approved = TRUE, approved_by = $1, approved_at = NOW()
         WHERE id = $2 RETURNING *`,
        [req.user.id, req.params.mom_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "MoM not found" });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

module.exports.momRouter = momRouter;


// ════════════════════════════════════════════════════════════════
//  routes/search.js  — Global full-text search
// ════════════════════════════════════════════════════════════════
const searchRouter = require("express").Router();

searchRouter.get("/",
  authenticate,
  async (req, res, next) => {
    try {
      const { q, resource, from, to, limit = 10 } = req.query;
      if (!q || q.trim().length < 2) {
        return res.status(400).json({ error: "Query must be at least 2 characters" });
      }

      const tsQuery = q.trim().split(/\s+/).join(" & ");
      const conditions = ["si.org_id = $1", "si.tsv @@ to_tsquery('english', $2)"];
      const params = [req.user.org_id, tsQuery];
      let p = 3;

      if (resource) { conditions.push(`si.resource = $${p++}`); params.push(resource); }

      const { rows } = await db.query(
        `SELECT
           si.resource, si.resource_id, si.title,
           ts_headline('english', si.body, to_tsquery('english', $2),
             'MaxFragments=2, MaxWords=15, MinWords=5') AS excerpt,
           ts_rank(si.tsv, to_tsquery('english', $2)) AS rank
         FROM search_index si
         WHERE ${conditions.join(" AND ")}
         ORDER BY rank DESC
         LIMIT $${p}`,
        [...params, parseInt(limit)]
      );

      // Also search transcripts
      const { rows: transcriptRows } = await db.query(
        `SELECT 'transcript_segment' AS resource, ts.id AS resource_id,
                ts.speaker_label AS title,
                ts_headline('english', ts.text, to_tsquery('english', $2),
                  'MaxFragments=1, MaxWords=20, MinWords=8') AS excerpt,
                ts_rank(to_tsvector('english', ts.text), to_tsquery('english', $2)) AS rank,
                m.title AS meeting_title, m.id AS meeting_id,
                ts.start_ms
         FROM transcript_segments ts
         JOIN meetings m ON m.id = ts.meeting_id
         WHERE m.org_id = $1
           AND to_tsvector('english', ts.text) @@ to_tsquery('english', $2)
         ORDER BY rank DESC
         LIMIT $3`,
        [req.user.org_id, tsQuery, 5]
      );

      res.json({
        query:   q,
        results: [...rows, ...transcriptRows].sort((a, b) => b.rank - a.rank).slice(0, parseInt(limit)),
        total:   rows.length + transcriptRows.length,
      });
    } catch (err) { next(err); }
  }
);

module.exports.searchRouter = searchRouter;


// ════════════════════════════════════════════════════════════════
//  routes/analytics.js  — Dashboard & reporting
// ════════════════════════════════════════════════════════════════
const analyticsRouter = require("express").Router();

analyticsRouter.get("/overview",
  authenticate,
  async (req, res, next) => {
    try {
      const orgId = req.user.org_id;
      const cacheKey = `analytics:overview:${orgId}`;
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

      const [
        { rows: [counts] },
        { rows: monthly },
        { rows: byPlatform },
        { rows: overdueActions },
        { rows: topOfficers },
      ] = await Promise.all([
        db.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'done')        AS total_meetings,
            COUNT(*) FILTER (WHERE status = 'live')        AS live_now,
            COUNT(*) FILTER (WHERE status = 'scheduled')   AS upcoming,
            COALESCE(SUM(duration_secs) FILTER (WHERE status = 'done'), 0) AS total_seconds,
            COUNT(*) FILTER (WHERE ai_processed = TRUE)    AS ai_processed
          FROM meetings WHERE org_id = $1`, [orgId]),

        db.query(`
          SELECT DATE_TRUNC('month', COALESCE(started_at, scheduled_at)) AS month,
                 COUNT(*) AS count,
                 COALESCE(SUM(duration_secs),0) AS seconds
          FROM meetings WHERE org_id = $1 AND status = 'done'
            AND started_at >= NOW() - INTERVAL '12 months'
          GROUP BY 1 ORDER BY 1`, [orgId]),

        db.query(`
          SELECT platform, COUNT(*) AS count
          FROM meetings WHERE org_id = $1 AND status != 'cancelled'
          GROUP BY platform ORDER BY count DESC`, [orgId]),

        db.query(`
          SELECT COUNT(*) AS overdue_count,
                 COUNT(*) FILTER (WHERE priority = 'critical') AS critical_overdue
          FROM action_items
          WHERE org_id = $1 AND status NOT IN ('done','cancelled')
            AND due_date < CURRENT_DATE`, [orgId]),

        db.query(`
          SELECT assigned_name AS officer,
                 COUNT(*) AS total_actions,
                 COUNT(*) FILTER (WHERE status = 'done') AS completed
          FROM action_items WHERE org_id = $1 AND assigned_name IS NOT NULL
          GROUP BY assigned_name ORDER BY total_actions DESC LIMIT 5`, [orgId]),
      ]);

      const result = {
        overview:      counts,
        monthly_trend: monthly,
        by_platform:   byPlatform,
        overdue:       overdueActions[0],
        top_officers:  topOfficers,
        generated_at:  new Date().toISOString(),
      };

      await redis.setex(cacheKey, 300, JSON.stringify(result)); // 5-min cache
      res.json(result);
    } catch (err) { next(err); }
  }
);

module.exports.analyticsRouter = analyticsRouter;
