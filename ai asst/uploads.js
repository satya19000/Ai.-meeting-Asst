/**
 * routes/uploads.js — General file uploads
 *
 * POST /api/v1/uploads/avatar        — user profile picture
 * POST /api/v1/uploads/audio/:meeting_id — upload pre-recorded audio for AI processing
 */
const router  = require("express").Router();
const multer  = require("multer");
const path    = require("path");
const db      = require("../config/db");
const { authenticate } = require("../middleware/auth");
const { uploadBuffer } = require("../config/s3");
const { addToQueue }   = require("../queues");

const storage = multer.memoryStorage();

const imageUpload = multer({
  storage,
  limits:    { fileSize: 5 * 1024 * 1024 },       // 5MB
  fileFilter: (req, file, cb) => {
    const ok = [".jpg",".jpeg",".png",".webp"].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error("Images only"), ok);
  },
});

const audioUpload = multer({
  storage,
  limits:    { fileSize: 500 * 1024 * 1024 },     // 500MB
  fileFilter: (req, file, cb) => {
    const ok = [".mp3",".mp4",".m4a",".wav",".ogg",".mkv",".webm"].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error("Audio/video files only"), ok);
  },
});

// ─── Avatar upload ────────────────────────────────────────────
router.post("/avatar",
  authenticate,
  imageUpload.single("avatar"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const key = `avatars/${req.user.id}_${Date.now()}${path.extname(req.file.originalname)}`;
      await uploadBuffer(key, req.file.buffer, req.file.mimetype);

      await db.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [key, req.user.id]);

      res.json({ avatar_key: key, message: "Avatar updated" });
    } catch (err) { next(err); }
  }
);

// ─── Audio upload → trigger AI pipeline ──────────────────────
router.post("/audio/:meeting_id",
  authenticate,
  audioUpload.single("audio"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

      const { meeting_id } = req.params;

      // Verify meeting
      const { rows } = await db.query(
        "SELECT id, status FROM meetings WHERE id = $1 AND org_id = $2",
        [meeting_id, req.user.org_id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Meeting not found" });

      // Upload to S3
      const ext = path.extname(req.file.originalname) || ".mp3";
      const key = `recordings/${meeting_id}/upload_${Date.now()}${ext}`;
      await uploadBuffer(key, req.file.buffer, req.file.mimetype);

      // Link recording to meeting
      await db.query(
        "UPDATE meetings SET recording_url = $1, recording_size = $2, status = 'processing' WHERE id = $3",
        [key, req.file.size, meeting_id]
      );

      // Kick off full AI pipeline
      const job = await addToQueue("ai-pipeline", {
        type:         "FULL_PIPELINE",
        meeting_id,
        org_id:       req.user.org_id,
        triggered_by: req.user.id,
      }, { attempts: 3 });

      res.status(202).json({
        message:   "Audio uploaded — AI processing started",
        recording: key,
        job_id:    job.id,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;


// ── NOTE: webhooks.js is in a separate file below ────────────
