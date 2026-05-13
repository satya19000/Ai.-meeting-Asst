/**
 * routes/webhooks.js — Inbound webhooks from meeting platforms
 *
 * POST /api/v1/webhooks/zoom         — Zoom Event Subscriptions
 * POST /api/v1/webhooks/assemblyai   — AssemblyAI transcript ready
 * POST /api/v1/webhooks/deepgram     — Deepgram transcript ready
 */
const router  = require("express").Router();
const crypto  = require("crypto");
const db      = require("../config/db");
const { addToQueue } = require("../queues");
const logger  = require("../config/logger");

// Raw body needed for signature verification
const rawBody = require("express").raw({ type: "application/json" });

// ─── Zoom Webhooks ────────────────────────────────────────────
router.post("/zoom", rawBody, async (req, res, next) => {
  try {
    const signature = req.headers["x-zm-signature"];
    const ts        = req.headers["x-zm-request-timestamp"];
    const secret    = process.env.ZOOM_WEBHOOK_SECRET;

    // Validate signature
    if (secret) {
      const message = `v0:${ts}:${req.body.toString()}`;
      const expected = "v0=" + crypto.createHmac("sha256", secret).update(message).digest("hex");
      if (signature !== expected) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const event = JSON.parse(req.body.toString());
    logger.info(`[Webhook] Zoom event: ${event.event}`);

    switch (event.event) {
      // Zoom URL validation challenge
      case "endpoint.url_validation": {
        const hash = crypto.createHmac("sha256", secret || "")
          .update(event.payload.plainToken).digest("hex");
        return res.json({ plainToken: event.payload.plainToken, encryptedToken: hash });
      }

      case "meeting.ended": {
        const zoomMeetingId = event.payload?.object?.id;
        if (zoomMeetingId) {
          // Find matching meeting in DB by encrypted meeting_id field
          // (we can't decrypt here efficiently; use a lookup index instead)
          logger.info(`[Webhook] Zoom meeting ${zoomMeetingId} ended`);
        }
        break;
      }

      case "recording.completed": {
        const obj = event.payload?.object;
        if (obj?.recording_files?.length) {
          logger.info(`[Webhook] Zoom recording ready for ${obj.id}`);
          // Could trigger download + processing
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) { next(err); }
});

// ─── AssemblyAI Webhook ───────────────────────────────────────
router.post("/assemblyai", async (req, res, next) => {
  try {
    const { transcript_id, status, meeting_id } = req.body;
    logger.info(`[Webhook] AssemblyAI transcript ${transcript_id} — status: ${status}`);

    if (status === "completed" && meeting_id) {
      await addToQueue("ai-pipeline", {
        type:          "PROCESS_TRANSCRIPT_CALLBACK",
        transcript_id,
        meeting_id,
        engine:        "assemblyai",
      });
    }

    res.json({ received: true });
  } catch (err) { next(err); }
});

// ─── Deepgram Webhook ────────────────────────────────────────
router.post("/deepgram", async (req, res, next) => {
  try {
    const { meeting_id, channel, metadata } = req.body;
    logger.info(`[Webhook] Deepgram callback for meeting ${meeting_id}`);

    if (meeting_id && channel?.alternatives?.[0]?.transcript) {
      const text = channel.alternatives[0].transcript;
      const conf = channel.alternatives[0].confidence;

      // Save transcript
      await db.query(
        `INSERT INTO transcripts (meeting_id, engine, language, full_text, word_count, confidence, is_final)
         VALUES ($1,'deepgram','en',$2,$3,$4,TRUE)`,
        [meeting_id, text, text.split(" ").length, conf]
      );

      await addToQueue("ai-pipeline", {
        type: "FULL_PIPELINE",
        meeting_id,
        triggered_by: "webhook",
      });
    }

    res.json({ received: true });
  } catch (err) { next(err); }
});

module.exports = router;
