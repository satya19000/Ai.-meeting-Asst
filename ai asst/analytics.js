/**
 * routes/analytics.js — Dashboard & reporting metrics
 *
 * GET /api/v1/analytics/overview         — dashboard summary stats
 * GET /api/v1/analytics/meetings/trend   — monthly meeting volume
 * GET /api/v1/analytics/actions/summary  — action completion stats
 * GET /api/v1/analytics/officers         — per-officer action stats
 */
const router = require("express").Router();
const db     = require("../config/db");
const redis  = require("../config/redis");
const { authenticate, authorize } = require("../middleware/auth");

// ─── Overview (dashboard) ─────────────────────────────────────
router.get("/overview", authenticate, async (req, res, next) => {
  try {
    const orgId    = req.user.org_id;
    const cacheKey = `analytics:overview:${orgId}`;
    const cached   = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [
      { rows: [counts]     },
      { rows: monthly      },
      { rows: byPlatform   },
      { rows: [actionStats]},
      { rows: topOfficers  },
      { rows: recentMtgs   },
    ] = await Promise.all([
      // Core counts
      db.query(`
        SELECT
          COUNT(*)                                             FILTER (WHERE status != 'cancelled') AS total_meetings,
          COUNT(*)                                             FILTER (WHERE status = 'live')       AS live_now,
          COUNT(*)                                             FILTER (WHERE status = 'scheduled')  AS upcoming,
          COUNT(*)                                             FILTER (WHERE status = 'done')       AS completed,
          COUNT(*)                                             FILTER (WHERE ai_processed = TRUE)   AS ai_processed,
          COALESCE(SUM(duration_secs) FILTER (WHERE status = 'done'), 0)                           AS total_seconds,
          COALESCE(AVG(duration_secs) FILTER (WHERE status = 'done'), 0)::INTEGER                  AS avg_duration_secs
        FROM meetings WHERE org_id = $1`, [orgId]),

      // Monthly trend (last 12 months)
      db.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', COALESCE(started_at, scheduled_at)), 'Mon YYYY') AS month,
          DATE_TRUNC('month', COALESCE(started_at, scheduled_at))                       AS month_date,
          COUNT(*)                                                                       AS count,
          COALESCE(SUM(duration_secs), 0)                                               AS total_seconds,
          COUNT(*) FILTER (WHERE ai_processed = TRUE)                                   AS ai_processed
        FROM meetings
        WHERE org_id = $1
          AND COALESCE(started_at, scheduled_at) >= NOW() - INTERVAL '12 months'
          AND status != 'cancelled'
        GROUP BY 1, 2 ORDER BY 2`, [orgId]),

      // By platform
      db.query(`
        SELECT platform, COUNT(*) AS count,
               ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct
        FROM meetings WHERE org_id = $1 AND status != 'cancelled'
        GROUP BY platform ORDER BY count DESC`, [orgId]),

      // Action item stats
      db.query(`
        SELECT
          COUNT(*)                                                   AS total,
          COUNT(*) FILTER (WHERE status = 'done')                    AS completed,
          COUNT(*) FILTER (WHERE status IN ('pending','in_progress')) AS active,
          COUNT(*) FILTER (WHERE status = 'overdue'
                               OR (due_date < CURRENT_DATE AND status NOT IN ('done','cancelled'))) AS overdue,
          COUNT(*) FILTER (WHERE priority = 'critical' AND status NOT IN ('done','cancelled'))      AS critical_open,
          ROUND(COUNT(*) FILTER (WHERE status='done') * 100.0
                / NULLIF(COUNT(*),0), 1)                             AS completion_rate
        FROM action_items WHERE org_id = $1`, [orgId]),

      // Top officers by workload
      db.query(`
        SELECT
          COALESCE(u.full_name, a.assigned_name)        AS officer,
          COUNT(*)                                       AS total_actions,
          COUNT(*) FILTER (WHERE a.status = 'done')     AS completed,
          COUNT(*) FILTER (WHERE a.status IN ('pending','in_progress','overdue')) AS pending,
          ROUND(COUNT(*) FILTER (WHERE a.status='done') * 100.0 / NULLIF(COUNT(*),0),1) AS completion_rate
        FROM action_items a
        LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.org_id = $1 AND (u.full_name IS NOT NULL OR a.assigned_name IS NOT NULL)
        GROUP BY 1 ORDER BY total_actions DESC LIMIT 8`, [orgId]),

      // Recent meetings
      db.query(`
        SELECT id, title, platform, status, started_at, duration_secs, ai_processed
        FROM meetings WHERE org_id = $1 AND status != 'cancelled'
        ORDER BY COALESCE(started_at, scheduled_at) DESC LIMIT 5`, [orgId]),
    ]);

    const result = {
      overview:      counts,
      monthly_trend: monthly,
      by_platform:   byPlatform,
      action_stats:  actionStats,
      top_officers:  topOfficers,
      recent_meetings: recentMtgs,
      generated_at:  new Date().toISOString(),
    };

    await redis.setex(cacheKey, 300, JSON.stringify(result)); // 5-min cache
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Action completion trend ──────────────────────────────────
router.get("/actions/summary", authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') AS month,
        COUNT(*)                                              AS created,
        COUNT(*) FILTER (WHERE status = 'done')              AS completed,
        COUNT(*) FILTER (WHERE status = 'overdue'
          OR (due_date < CURRENT_DATE AND status NOT IN ('done','cancelled'))) AS overdue
      FROM action_items
      WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)`,
      [req.user.org_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── Per-officer breakdown ────────────────────────────────────
router.get("/officers", authenticate, authorize("district_officer","super_admin"), async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(u.full_name, a.assigned_name)          AS officer,
        a.department,
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE a.status = 'done')        AS done,
        COUNT(*) FILTER (WHERE a.status = 'overdue'
          OR (a.due_date < CURRENT_DATE AND a.status NOT IN ('done','cancelled'))) AS overdue,
        COUNT(*) FILTER (WHERE a.priority IN ('high','critical')
          AND a.status NOT IN ('done','cancelled'))       AS high_priority_open,
        MIN(a.due_date) FILTER (WHERE a.status NOT IN ('done','cancelled')) AS next_due_date
      FROM action_items a
      LEFT JOIN users u ON u.id = a.assigned_to
      WHERE a.org_id = $1
      GROUP BY 1, 2 ORDER BY overdue DESC, total DESC`,
      [req.user.org_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
