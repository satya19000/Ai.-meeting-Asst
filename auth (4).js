// src/cron/index.js
const cron   = require("node-cron");
const db     = require("../config/db");
const logger = require("../config/logger");
const { addToQueue } = require("../queues");

function initCron() {
  // ── Daily 8 AM: send action reminders for items due today ─
  cron.schedule("0 8 * * *", async () => {
    logger.info("[Cron] Checking action reminders...");
    try {
      const { rows } = await db.query(`
        SELECT a.*, u.email, u.telegram_chat_id, u.whatsapp_number, u.full_name
        FROM action_items a
        LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.status NOT IN ('done','cancelled')
          AND a.due_date = CURRENT_DATE
          AND a.reminder_sent = FALSE`);

      for (const action of rows) {
        await addToQueue("notifications", { type: "ACTION_REMINDER", action });
      }
      logger.info(`[Cron] Queued ${rows.length} action reminders`);
    } catch (e) { logger.error("[Cron] Reminder error:", e.message); }
  }, { timezone: "Asia/Kolkata" });

  // ── Midnight: mark overdue actions ──────────────────────
  cron.schedule("0 0 * * *", async () => {
    try {
      const { rowCount } = await db.query(`
        UPDATE action_items SET status = 'overdue', updated_at = NOW()
        WHERE status = 'pending'
          AND due_date < CURRENT_DATE`);
      if (rowCount) logger.info(`[Cron] Marked ${rowCount} actions as overdue`);
    } catch (e) { logger.error("[Cron] Overdue mark error:", e.message); }
  }, { timezone: "Asia/Kolkata" });

  // ── Weekly Sunday 2 AM: clean expired refresh tokens ────
  cron.schedule("0 2 * * 0", async () => {
    try {
      const { rowCount } = await db.query(
        "DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL"
      );
      logger.info(`[Cron] Purged ${rowCount} stale refresh tokens`);
    } catch (e) { logger.error("[Cron] Token cleanup error:", e.message); }
  });

  // ── Daily 3 AM: clean stuck bot sessions (>6h active) ───
  cron.schedule("0 3 * * *", async () => {
    try {
      const { rowCount } = await db.query(`
        UPDATE bot_sessions SET status = 'ended', updated_at = NOW()
        WHERE status IN ('active','joining')
          AND updated_at < NOW() - INTERVAL '6 hours'`);
      if (rowCount) logger.info(`[Cron] Cleaned ${rowCount} stuck bot sessions`);
    } catch (e) { logger.error("[Cron] Bot cleanup error:", e.message); }
  });

  // ── Every 5 min: bust analytics cache (allow fresh fetch) ─
  // Cache is set with a 5-min TTL in analytics route — no explicit bust needed.

  logger.info("[Cron] ✅ All cron jobs scheduled (IST)");
}

module.exports = { initCron };
