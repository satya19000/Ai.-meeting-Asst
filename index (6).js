/**
 * routes/summaries.js
 *
 * GET  /api/v1/summaries/meeting/:meeting_id    — all summaries for a meeting
 * GET  /api/v1/summaries/:id                    — single summary by ID
 * POST /api/v1/summaries/generate               — generate on demand
 * DELETE /api/v1/summaries/:id                  — delete (admin)
 */
const router = require("express").Router();
const { body, param } = require("express-validator");
const db    = require("../config/db");
const { authenticate, authorize, validate } = require("../middleware/auth");
const { addToQueue } = require("../queues");

router.get("/meeting/:meeting_id",
  authenticate,
  param("meeting_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT s.* FROM summaries s
         JOIN meetings m ON m.id = s.meeting_id
         WHERE s.meeting_id = $1 AND m.org_id = $2
         ORDER BY s.type, s.created_at DESC`,
        [req.params.meeting_id, req.user.org_id]
      );
      res.json(rows);
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
        `SELECT s.* FROM summaries s
         JOIN meetings m ON m.id = s.meeting_id
         WHERE s.id = $1 AND m.org_id = $2`,
        [req.params.id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Summary not found" });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.post("/generate",
  authenticate,
  body("meeting_id").isUUID(),
  body("type").isIn(["brief","detailed","bilingual","telugu"]),
  validate,
  async (req, res, next) => {
    try {
      const { meeting_id, type, force_regenerate = false } = req.body;

      // Verify meeting is in org and has a transcript
      const { rows: meetings } = await db.query(
        "SELECT id FROM meetings WHERE id = $1 AND org_id = $2",
        [meeting_id, req.user.org_id]
      );
      if (!meetings[0]) return res.status(404).json({ error: "Meeting not found" });

      const { rows: transcripts } = await db.query(
        "SELECT id, full_text FROM transcripts WHERE meeting_id = $1 AND is_final = TRUE LIMIT 1",
        [meeting_id]
      );
      if (!transcripts[0]) return res.status(400).json({ error: "No final transcript found — cannot generate summary" });

      // Return existing unless forced
      if (!force_regenerate) {
        const { rows: existing } = await db.query(
          "SELECT * FROM summaries WHERE meeting_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1",
          [meeting_id, type]
        );
        if (existing[0]) return res.json({ summary: existing[0], cached: true });
      }

      const job = await addToQueue("ai-pipeline", {
        type:          "GENERATE_SUMMARY",
        meeting_id,
        summary_type:  type,
        full_text:     transcripts[0].full_text,
        requested_by:  req.user.id,
      }, { attempts: 2 });

      res.status(202).json({ message: "Summary generation queued", job_id: job.id });
    } catch (err) { next(err); }
  }
);

router.delete("/:id",
  authenticate,
  authorize("super_admin", "district_officer"),
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await db.query(
        `DELETE FROM summaries s USING meetings m
         WHERE s.id = $1 AND s.meeting_id = m.id AND m.org_id = $2`,
        [req.params.id, req.user.org_id]
      );
      res.json({ message: "Summary deleted" });
    } catch (err) { next(err); }
  }
);

module.exports = router;
