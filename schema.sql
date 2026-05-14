/**
 * routes/transcripts.js
 *
 * GET  /api/v1/transcripts/:meeting_id          — full transcript for a meeting
 * GET  /api/v1/transcripts/:meeting_id/segments — paginated speaker segments
 * GET  /api/v1/transcripts/:meeting_id/raw      — raw transcript text download
 */
const router = require("express").Router();
const { param, query } = require("express-validator");
const db    = require("../config/db");
const { authenticate, validate } = require("../middleware/auth");

router.get("/:meeting_id",
  authenticate,
  param("meeting_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT t.*,
          (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.transcript_id = t.id) AS segment_count
         FROM transcripts t
         JOIN meetings m ON m.id = t.meeting_id
         WHERE t.meeting_id = $1 AND m.org_id = $2
         ORDER BY t.created_at DESC`,
        [req.params.meeting_id, req.user.org_id]
      );
      if (!rows.length) return res.status(404).json({ error: "No transcripts found" });
      res.json(rows);
    } catch (err) { next(err); }
  }
);

router.get("/:meeting_id/segments",
  authenticate,
  param("meeting_id").isUUID(),
  query("limit").optional().isInt({ min: 1, max: 500 }),
  query("offset").optional().isInt({ min: 0 }),
  query("speaker").optional().trim(),
  validate,
  async (req, res, next) => {
    try {
      const { limit = 100, offset = 0, speaker } = req.query;
      const conditions = ["ts.meeting_id = $1"];
      const params = [req.params.meeting_id];
      let p = 2;

      if (speaker) {
        conditions.push(`ts.speaker_label ILIKE $${p++}`);
        params.push(`%${speaker}%`);
      }

      const { rows } = await db.query(
        `SELECT ts.* FROM transcript_segments ts
         JOIN meetings m ON m.id = ts.meeting_id
         WHERE ${conditions.join(" AND ")} AND m.org_id = $${p++}
         ORDER BY ts.start_ms ASC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, req.user.org_id, parseInt(limit), parseInt(offset)]
      );
      res.json(rows);
    } catch (err) { next(err); }
  }
);

router.get("/:meeting_id/raw",
  authenticate,
  param("meeting_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT t.full_text, m.title
         FROM transcripts t
         JOIN meetings m ON m.id = t.meeting_id
         WHERE t.meeting_id = $1 AND m.org_id = $2 AND t.is_final = TRUE
         ORDER BY t.created_at DESC LIMIT 1`,
        [req.params.meeting_id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "No final transcript" });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="transcript_${req.params.meeting_id}.txt"`);
      res.send(rows[0].full_text || "");
    } catch (err) { next(err); }
  }
);

module.exports = router;
