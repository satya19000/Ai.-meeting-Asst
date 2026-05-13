/**
 * routes/mom.js — Minutes of Meeting
 *
 * GET  /api/v1/mom/:meeting_id         — get MoM for a meeting
 * POST /api/v1/mom/generate            — generate MoM (queued)
 * POST /api/v1/mom/:mom_id/approve     — approve (district_officer+)
 * GET  /api/v1/mom/:mom_id/export/:fmt — download PDF/DOCX/PPTX
 */
const router = require("express").Router();
const { body, param } = require("express-validator");
const db    = require("../config/db");
const { authenticate, authorize, validate } = require("../middleware/auth");
const { addToQueue } = require("../queues");
const { getPresignedUrl } = require("../config/s3");

router.get("/:meeting_id",
  authenticate,
  param("meeting_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT mom.*, m.title AS meeting_title, m.platform,
                m.started_at, m.ended_at, m.venue,
                u.full_name AS generated_by_name,
                a.full_name AS approved_by_name
         FROM minutes_of_meeting mom
         JOIN meetings m ON m.id = mom.meeting_id
         LEFT JOIN users u ON u.id = mom.generated_by
         LEFT JOIN users a ON a.id = mom.approved_by
         WHERE mom.meeting_id = $1 AND m.org_id = $2
         ORDER BY mom.created_at DESC LIMIT 1`,
        [req.params.meeting_id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "MoM not yet generated" });

      // Attach signed download URLs
      const mom = rows[0];
      if (mom.pdf_url)  mom.pdf_download_url  = await getPresignedUrl(mom.pdf_url,  7200);
      if (mom.docx_url) mom.docx_download_url = await getPresignedUrl(mom.docx_url, 7200);
      if (mom.pptx_url) mom.pptx_download_url = await getPresignedUrl(mom.pptx_url, 7200);

      res.json(mom);
    } catch (err) { next(err); }
  }
);

router.post("/generate",
  authenticate,
  body("meeting_id").isUUID(),
  body("include_telugu").optional().isBoolean(),
  validate,
  async (req, res, next) => {
    try {
      const { meeting_id, include_telugu = true } = req.body;

      // Verify meeting + transcript exist
      const { rows: meetings } = await db.query(
        "SELECT id FROM meetings WHERE id = $1 AND org_id = $2",
        [meeting_id, req.user.org_id]
      );
      if (!meetings[0]) return res.status(404).json({ error: "Meeting not found" });

      const { rows: transcripts } = await db.query(
        "SELECT id, full_text FROM transcripts WHERE meeting_id = $1 AND is_final = TRUE LIMIT 1",
        [meeting_id]
      );
      if (!transcripts[0]) return res.status(400).json({ error: "No transcript — cannot generate MoM" });

      const job = await addToQueue("ai-pipeline", {
        type:          "GENERATE_MOM",
        meeting_id,
        full_text:     transcripts[0].full_text,
        include_telugu,
        requested_by:  req.user.id,
        org_id:        req.user.org_id,
      }, { attempts: 2 });

      res.status(202).json({ message: "MoM generation queued", job_id: job.id });
    } catch (err) { next(err); }
  }
);

router.post("/:mom_id/approve",
  authenticate,
  authorize("district_officer", "super_admin"),
  param("mom_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE minutes_of_meeting mom
         SET is_approved = TRUE, approved_by = $1, approved_at = NOW()
         FROM meetings m
         WHERE mom.id = $2 AND mom.meeting_id = m.id AND m.org_id = $3
         RETURNING mom.*`,
        [req.user.id, req.params.mom_id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "MoM not found" });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// Request a specific export format
router.get("/:mom_id/export/:format",
  authenticate,
  param("mom_id").isUUID(),
  param("format").isIn(["pdf","docx","pptx"]),
  validate,
  async (req, res, next) => {
    try {
      const fmt = req.params.format;
      const { rows } = await db.query(
        `SELECT mom.*, m.title, m.started_at, m.org_id
         FROM minutes_of_meeting mom
         JOIN meetings m ON m.id = mom.meeting_id
         WHERE mom.id = $1 AND m.org_id = $2`,
        [req.params.mom_id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "MoM not found" });

      const urlField = `${fmt}_url`;
      if (rows[0][urlField]) {
        // Already exists — return signed URL
        const signedUrl = await getPresignedUrl(rows[0][urlField], 3600);
        return res.json({ download_url: signedUrl, format: fmt, cached: true });
      }

      // Queue export generation
      const job = await addToQueue("exports", {
        type:        `MOM_${fmt.toUpperCase()}`,
        format:      fmt,
        mom_id:      req.params.mom_id,
        meeting_id:  rows[0].meeting_id,
        requested_by: req.user.id,
        ...rows[0],
      });

      res.status(202).json({ message: `${fmt.toUpperCase()} export queued`, job_id: job.id });
    } catch (err) { next(err); }
  }
);

module.exports = router;
