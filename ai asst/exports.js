/**
 * routes/exports.js
 *
 * GET  /api/v1/exports              — list my exports
 * POST /api/v1/exports              — request new export
 * GET  /api/v1/exports/:id/download — get signed download URL
 * DELETE /api/v1/exports/:id        — delete export record
 */
const router = require("express").Router();
const { body, param } = require("express-validator");
const db     = require("../config/db");
const { authenticate, validate } = require("../middleware/auth");
const { addToQueue } = require("../queues");
const { getPresignedUrl } = require("../config/s3");

router.get("/", authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT e.*, m.title AS meeting_title
       FROM exports e
       LEFT JOIN meetings m ON m.id = e.meeting_id
       WHERE e.requested_by = $1
       ORDER BY e.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/",
  authenticate,
  body("meeting_id").isUUID(),
  body("format").isIn(["pdf","docx","pptx","csv","json"]),
  validate,
  async (req, res, next) => {
    try {
      const { meeting_id, format, options = {} } = req.body;

      // Verify meeting belongs to org
      const { rows: meetings } = await db.query(
        "SELECT id FROM meetings WHERE id = $1 AND org_id = $2",
        [meeting_id, req.user.org_id]
      );
      if (!meetings[0]) return res.status(404).json({ error: "Meeting not found" });

      // Create export record
      const { rows } = await db.query(
        `INSERT INTO exports (meeting_id, requested_by, format, status, options)
         VALUES ($1,$2,$3,'queued',$4) RETURNING *`,
        [meeting_id, req.user.id, format, JSON.stringify(options)]
      );
      const exportRecord = rows[0];

      // Get MoM data for document exports
      let momData = {};
      if (["pdf","docx","pptx"].includes(format)) {
        const { rows: moms } = await db.query(
          `SELECT mom.*, m.title, m.started_at, m.ended_at, m.venue, m.platform,
                  (SELECT json_agg(row_to_json(p)) FROM meeting_participants p WHERE p.meeting_id = m.id) AS participants,
                  (SELECT json_agg(row_to_json(a)) FROM action_items a WHERE a.meeting_id = m.id) AS actions
           FROM minutes_of_meeting mom JOIN meetings m ON m.id = mom.meeting_id
           WHERE mom.meeting_id = $1 ORDER BY mom.created_at DESC LIMIT 1`,
          [meeting_id]
        );
        momData = moms[0] || {};
      }

      await addToQueue("exports", {
        type:         `MOM_${format.toUpperCase()}`,
        format,
        export_id:    exportRecord.id,
        mom_id:       momData.id,
        meeting_id,
        requested_by: req.user.id,
        ...momData,
      });

      res.status(202).json({ export: exportRecord, message: "Export queued" });
    } catch (err) { next(err); }
  }
);

router.get("/:id/download",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM exports WHERE id = $1 AND requested_by = $2",
        [req.params.id, req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Export not found" });
      if (rows[0].status !== "done" || !rows[0].file_url) {
        return res.status(202).json({ status: rows[0].status, message: "Export not ready yet" });
      }
      const url = await getPresignedUrl(rows[0].file_url, 3600);
      res.json({ download_url: url, format: rows[0].format, expires_in: 3600 });
    } catch (err) { next(err); }
  }
);

router.delete("/:id",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await db.query(
        "DELETE FROM exports WHERE id = $1 AND requested_by = $2",
        [req.params.id, req.user.id]
      );
      res.json({ message: "Export deleted" });
    } catch (err) { next(err); }
  }
);

module.exports = router;
