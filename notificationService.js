/**
 * routes/slides.js — Slide captures
 *
 * GET  /api/v1/slides/:meeting_id      — list all slides for a meeting
 * GET  /api/v1/slides/:meeting_id/:num — single slide with signed URL
 * POST /api/v1/slides/upload           — bot uploads screenshot (internal)
 */
const router = require("express").Router();
const { param } = require("express-validator");
const multer  = require("multer");
const db      = require("../config/db");
const redis   = require("../config/redis");
const { authenticate, validate } = require("../middleware/auth");
const { uploadBuffer, getPresignedUrl } = require("../config/s3");
const axios   = require("axios");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get("/:meeting_id",
  authenticate,
  param("meeting_id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT sc.* FROM slide_captures sc
         JOIN meetings m ON m.id = sc.meeting_id
         WHERE sc.meeting_id = $1 AND m.org_id = $2
         ORDER BY sc.slide_number ASC`,
        [req.params.meeting_id, req.user.org_id]
      );

      // Attach signed URLs
      const slides = await Promise.all(rows.map(async (s) => ({
        ...s,
        image_signed_url:     s.image_url     ? await getPresignedUrl(s.image_url)     : null,
        thumbnail_signed_url: s.thumbnail_url ? await getPresignedUrl(s.thumbnail_url) : null,
      })));

      res.json(slides);
    } catch (err) { next(err); }
  }
);

router.get("/:meeting_id/:slide_number",
  authenticate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT sc.* FROM slide_captures sc
         JOIN meetings m ON m.id = sc.meeting_id
         WHERE sc.meeting_id = $1 AND sc.slide_number = $2 AND m.org_id = $3`,
        [req.params.meeting_id, parseInt(req.params.slide_number), req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Slide not found" });

      const slide = {
        ...rows[0],
        image_signed_url: rows[0].image_url ? await getPresignedUrl(rows[0].image_url) : null,
      };
      res.json(slide);
    } catch (err) { next(err); }
  }
);

// Bot uploads screenshot — lightweight internal endpoint
router.post("/upload",
  upload.single("file"),
  async (req, res, next) => {
    try {
      const { session_id, slide_number, meeting_id } = req.body;
      if (!session_id || !req.file) return res.status(400).json({ error: "Missing session_id or file" });

      // Determine meeting_id from session if not supplied
      let mid = meeting_id;
      if (!mid) {
        const { rows } = await db.query("SELECT meeting_id FROM bot_sessions WHERE id = $1", [session_id]);
        if (!rows[0]) return res.status(404).json({ error: "Session not found" });
        mid = rows[0].meeting_id;
      }

      const num  = parseInt(slide_number) || 1;
      const key  = `slides/${mid}/${session_id}_${num}.png`;
      await uploadBuffer(key, req.file.buffer, "image/png");

      // OCR via AI service
      const b64 = req.file.buffer.toString("base64");
      let ocrResult = { ocr_text: null, ai_title: null, ai_notes: null, ai_notes_telugu: null };
      try {
        const { data } = await axios.post(
          `${process.env.AI_SERVICE_URL || "http://ai:8000"}/ocr`,
          { image_b64: b64, session_id, slide_num: num },
          { timeout: 30000 }
        );
        ocrResult = data;
      } catch (e) {
        console.error("[Slides] OCR error:", e.message);
      }

      // Save to DB (upsert by slide_number)
      const { rows } = await db.query(
        `INSERT INTO slide_captures
           (meeting_id, slide_number, image_url, ocr_text, ai_title, ai_notes, ai_notes_telugu)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [mid, num, key, ocrResult.ocr_text, ocrResult.ai_title, ocrResult.ai_notes, ocrResult.ai_notes_telugu]
      );

      // Update slide count
      await db.query(
        "UPDATE meetings SET slide_count = slide_count + 1 WHERE id = $1", [mid]
      );

      res.json({ success: true, slide_id: rows[0]?.id, key });
    } catch (err) { next(err); }
  }
);

module.exports = router;
