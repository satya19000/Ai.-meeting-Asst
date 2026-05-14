/**
 * queues/index.js  — Bull queue definitions + processors
 *
 * Queues:
 *   ai-pipeline   — transcription → summary → actions → MoM → export
 *   bot-worker    — Puppeteer bot join/record
 *   notifications — email / WhatsApp / Telegram / push
 *   exports       — PDF / DOCX / PPTX generation
 */

const Bull   = require("bull");
const redis  = require("../config/redis");
const logger = require("../config/logger");

const REDIS_OPTS = { createClient: () => redis.duplicate() };

// ─── Queue instances ─────────────────────────────────────────
const queues = {
  "ai-pipeline":   new Bull("ai-pipeline",   { redis: process.env.REDIS_URL }),
  "bot-worker":    new Bull("bot-worker",    { redis: process.env.REDIS_URL }),
  "notifications": new Bull("notifications", { redis: process.env.REDIS_URL }),
  "exports":       new Bull("exports",       { redis: process.env.REDIS_URL }),
};

async function addToQueue(queueName, data, opts = {}) {
  const q = queues[queueName];
  if (!q) throw new Error(`Unknown queue: ${queueName}`);
  return q.add(data, { removeOnComplete: 100, removeOnFail: 50, ...opts });
}

// ─── AI Pipeline Processor ───────────────────────────────────
function processAIPipeline(io) {
  const aiQueue = queues["ai-pipeline"];

  aiQueue.process("*", 3, async (job) => {
    const { type, meeting_id, org_id, requested_by } = job.data;
    const db     = require("../config/db");
    const axios  = require("axios");
    const AI_URL = process.env.AI_SERVICE_URL || "http://ai:8000";

    logger.info(`[AI Pipeline] ${type} for meeting ${meeting_id}`);

    switch (type) {
      // ── Full pipeline after meeting ends ──────────────────
      case "FULL_PIPELINE": {
        await job.progress(5);

        // 1. Fetch recording URL
        const { rows: [meeting] } = await db.query(
          "SELECT * FROM meetings WHERE id = $1", [meeting_id]
        );
        if (!meeting) throw new Error("Meeting not found");

        io?.to(`meeting:${meeting_id}`).emit("pipeline:progress", { stage: "transcription", pct: 10 });

        // 2. Transcribe
        const { data: transcriptResult } = await axios.post(`${AI_URL}/transcribe`, {
          meeting_id,
          audio_url:  meeting.recording_url,
          language:   meeting.transcript_lang || "mixed",
        });

        await job.progress(40);
        io?.to(`meeting:${meeting_id}`).emit("pipeline:progress", { stage: "summary", pct: 40 });

        // 3. Save transcript
        const { rows: [transcript] } = await db.query(
          `INSERT INTO transcripts (meeting_id, engine, language, full_text, word_count, confidence, is_final)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`,
          [meeting_id, transcriptResult.engine, transcriptResult.language,
           transcriptResult.full_text, transcriptResult.word_count, transcriptResult.confidence]
        );

        // Save segments
        for (const seg of transcriptResult.segments || []) {
          await db.query(
            `INSERT INTO transcript_segments
               (transcript_id, meeting_id, speaker_label, start_ms, end_ms, text, language, confidence, words)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [transcript.id, meeting_id, seg.speaker, seg.start_ms, seg.end_ms,
             seg.text, seg.language, seg.confidence, JSON.stringify(seg.words || [])]
          );
        }

        await job.progress(55);

        // 4. Generate summaries
        const { data: summaries } = await axios.post(`${AI_URL}/summarize`, {
          meeting_id,
          transcript_id: transcript.id,
          types: ["brief", "detailed", "bilingual"],
        });

        for (const s of summaries) {
          await db.query(
            `INSERT INTO summaries (meeting_id, type, language, content, content_telugu,
              token_count, quality_score, key_topics, key_persons, keywords, decisions)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [meeting_id, s.type, s.language, s.content, s.content_telugu,
             s.token_count, s.quality_score, s.key_topics, s.key_persons,
             s.keywords, s.decisions]
          );
        }

        await job.progress(70);
        io?.to(`meeting:${meeting_id}`).emit("pipeline:progress", { stage: "actions", pct: 70 });

        // 5. Extract action items
        const { data: actions } = await axios.post(`${AI_URL}/extract-actions`, {
          meeting_id,
          transcript_id: transcript.id,
        });

        for (const a of actions) {
          await db.query(
            `INSERT INTO action_items
               (meeting_id, org_id, task, task_telugu, assigned_name, department,
                priority, due_date, confidence)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [meeting_id, org_id, a.task, a.task_telugu, a.assigned_to,
             a.department, a.priority, a.due_date, a.confidence]
          );
        }

        await job.progress(82);
        io?.to(`meeting:${meeting_id}`).emit("pipeline:progress", { stage: "mom", pct: 82 });

        // 6. Generate MoM
        const { data: mom } = await axios.post(`${AI_URL}/generate-mom`, {
          meeting_id,
          transcript_id: transcript.id,
          include_telugu: true,
        });

        const { rows: [momRow] } = await db.query(
          `INSERT INTO minutes_of_meeting
             (meeting_id, generated_by, title, date_time, venue, chaired_by,
              agenda_items, discussion_points, decisions, action_items, content_telugu)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [meeting_id, requested_by, mom.title, mom.date_time, mom.venue, mom.chaired_by,
           JSON.stringify(mom.agenda_items), JSON.stringify(mom.discussion_points),
           JSON.stringify(mom.decisions), JSON.stringify(mom.action_items),
           JSON.stringify(mom.content_telugu)]
        );

        await job.progress(90);

        // 7. Generate PDF export
        await addToQueue("exports", {
          type: "MOM_PDF",
          mom_id: momRow.id,
          meeting_id,
          requested_by,
          org_id,
        });

        // 8. Mark meeting as done
        await db.query(
          "UPDATE meetings SET status = 'done', ai_processed = TRUE, ai_processed_at = NOW() WHERE id = $1",
          [meeting_id]
        );

        await job.progress(95);

        // 9. Send notifications
        await addToQueue("notifications", {
          type: "MEETING_PROCESSED",
          meeting_id,
          org_id,
          mom_id: momRow.id,
        });

        await job.progress(100);
        io?.to(`org:${org_id}`).emit("meeting:processed", { meeting_id, status: "done" });

        return { success: true, meeting_id };
      }

      case "GENERATE_SUMMARY": {
        const { summary_type } = job.data;
        const { rows: [t] } = await db.query(
          "SELECT * FROM transcripts WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1",
          [meeting_id]
        );
        if (!t) throw new Error("No transcript found");

        const { data: s } = await axios.post(`${AI_URL}/summarize`, {
          meeting_id,
          transcript_id: t.id,
          types: [summary_type],
        });

        const summary = s[0];
        const { rows: [row] } = await db.query(
          `INSERT INTO summaries (meeting_id, type, language, content, content_telugu, token_count)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (meeting_id, type) DO UPDATE
             SET content = EXCLUDED.content, updated_at = NOW()
           RETURNING *`,
          [meeting_id, summary.type, summary.language, summary.content, summary.content_telugu, summary.token_count]
        );
        io?.to(`meeting:${meeting_id}`).emit("summary:ready", row);
        return row;
      }

      case "GENERATE_MOM": {
        const { include_telugu } = job.data;
        const { rows: [t] } = await db.query(
          "SELECT * FROM transcripts WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1",
          [meeting_id]
        );
        if (!t) throw new Error("No transcript found");

        const { data: mom } = await axios.post(`${AI_URL}/generate-mom`, {
          meeting_id, transcript_id: t.id, include_telugu
        });

        const { rows: [row] } = await db.query(
          `INSERT INTO minutes_of_meeting (meeting_id, generated_by, title, date_time, venue, chaired_by,
             agenda_items, discussion_points, decisions, action_items)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [meeting_id, requested_by, mom.title, mom.date_time, mom.venue, mom.chaired_by,
           JSON.stringify(mom.agenda_items), JSON.stringify(mom.discussion_points),
           JSON.stringify(mom.decisions), JSON.stringify(mom.action_items)]
        );
        io?.to(`meeting:${meeting_id}`).emit("mom:ready", row);
        return row;
      }

      default:
        throw new Error(`Unknown pipeline type: ${type}`);
    }
  });

  aiQueue.on("completed", (job, result) => logger.info(`[AI Queue] Job ${job.id} completed`));
  aiQueue.on("failed", (job, err) => logger.error(`[AI Queue] Job ${job.id} failed:`, err.message));
}

// ─── Notification Processor ───────────────────────────────────
function processNotifications() {
  const notifQueue = queues["notifications"];
  const notifSvc   = require("../services/notificationService");

  notifQueue.process("*", 5, async (job) => {
    const { type } = job.data;

    switch (type) {
      case "MEETING_PROCESSED": {
        const { meeting_id, org_id, mom_id } = job.data;
        const db = require("../config/db");

        const { rows: users } = await db.query(
          `SELECT u.id, u.email, u.full_name, u.telegram_chat_id, u.whatsapp_number, u.preferences
           FROM users u WHERE u.org_id = $1 AND u.is_active = TRUE`,
          [org_id]
        );

        const { rows: [meeting] } = await db.query(
          "SELECT title, started_at, ended_at FROM meetings WHERE id = $1",
          [meeting_id]
        );

        for (const user of users) {
          const prefs = user.preferences?.notifications || {};

          if (prefs.email !== false) {
            await notifSvc.sendEmail({
              to:      user.email,
              subject: `MeetIQ: Meeting Summary Ready — ${meeting.title}`,
              html:    notifSvc.emailTemplate("meeting_processed", { user, meeting, mom_id }),
            }).catch(e => logger.error("Email failed:", e.message));
          }

          if (prefs.telegram && user.telegram_chat_id) {
            await notifSvc.sendTelegram(
              user.telegram_chat_id,
              `✅ *Meeting Processed*\n\n*${meeting.title}*\n\nSummary and MoM are ready. Open MeetIQ to view.`
            ).catch(e => logger.error("Telegram failed:", e.message));
          }

          if (prefs.whatsapp && user.whatsapp_number) {
            await notifSvc.sendWhatsApp(
              user.whatsapp_number,
              `MeetIQ: Meeting "${meeting.title}" has been processed. Your AI summary and Minutes of Meeting are ready.`
            ).catch(e => logger.error("WhatsApp failed:", e.message));
          }
        }
        break;
      }

      case "ACTION_REMINDER": {
        const { action } = job.data;
        if (action.email) {
          await notifSvc.sendEmail({
            to:      action.email,
            subject: `MeetIQ Reminder: Action Due Soon`,
            html:    notifSvc.emailTemplate("action_reminder", { action }),
          });
        }
        if (action.telegram_chat_id) {
          await notifSvc.sendTelegram(
            action.telegram_chat_id,
            `⏰ *Action Reminder*\n\n${action.task}\n*Due:* ${action.due_date}`
          );
        }
        break;
      }
    }
  });
}

// ─── Export Processor ────────────────────────────────────────
function processExports() {
  const exportQueue = queues["exports"];
  const exportSvc   = require("../services/exportService");

  exportQueue.process("*", 2, async (job) => {
    const { type, mom_id, meeting_id, format } = job.data;
    const db = require("../config/db");

    let fileBuffer, fileName, contentType;

    if (type === "MOM_PDF" || format === "pdf") {
      const { rows: [mom] } = await db.query(
        `SELECT mom.*, m.title, m.started_at, m.ended_at, m.venue, m.platform,
                (SELECT json_agg(row_to_json(p)) FROM meeting_participants p WHERE p.meeting_id = m.id) AS participants,
                (SELECT json_agg(row_to_json(a)) FROM action_items a WHERE a.meeting_id = m.id) AS actions
         FROM minutes_of_meeting mom JOIN meetings m ON m.id = mom.meeting_id
         WHERE mom.id = $1`,
        [mom_id || job.data.mom_id]
      );
      fileBuffer  = await exportSvc.generateMoMPDF(mom);
      fileName    = `mom_${meeting_id}_${Date.now()}.pdf`;
      contentType = "application/pdf";
    } else if (format === "docx") {
      fileBuffer  = await exportSvc.generateMoMDOCX(job.data);
      fileName    = `mom_${meeting_id}_${Date.now()}.docx`;
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (format === "pptx") {
      fileBuffer  = await exportSvc.generateMoMPPTX(job.data);
      fileName    = `mom_${meeting_id}_${Date.now()}.pptx`;
      contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }

    const s3Key = `exports/${meeting_id}/${fileName}`;
    const { uploadBuffer } = require("../config/s3");
    await uploadBuffer(s3Key, fileBuffer, contentType);

    // Update MoM with export URL
    if (format === "pdf" || type === "MOM_PDF") {
      await db.query("UPDATE minutes_of_meeting SET pdf_url = $1 WHERE id = $2", [s3Key, mom_id]);
    } else if (format === "docx") {
      await db.query("UPDATE minutes_of_meeting SET docx_url = $1 WHERE id = $2", [s3Key, mom_id]);
    }

    return { s3_key: s3Key, file_name: fileName };
  });
}

// ─── Init all processors ─────────────────────────────────────
function initQueues(io) {
  processAIPipeline(io);
  processNotifications();
  processExports();
  logger.info("✅  Queue processors initialized");
}

module.exports = { initQueues, addToQueue, queues };
