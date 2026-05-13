/**
 * routes/notifications.js
 *
 * GET   /api/v1/notifications           — list my notifications
 * PATCH /api/v1/notifications/:id/read  — mark as read
 * POST  /api/v1/notifications/read-all  — mark all read
 * DELETE /api/v1/notifications/:id      — delete one
 * POST  /api/v1/notifications/push/subscribe   — save push subscription
 * DELETE /api/v1/notifications/push/unsubscribe — remove push subscription
 */
const router = require("express").Router();
const { param } = require("express-validator");
const db    = require("../config/db");
const redis = require("../config/redis");
const { authenticate, validate } = require("../middleware/auth");

router.get("/", authenticate, async (req, res, next) => {
  try {
    const { unread_only, limit = 30 } = req.query;
    const conditions = ["n.user_id = $1"];
    const params = [req.user.id];
    let p = 2;

    if (unread_only === "true") { conditions.push(`n.read_at IS NULL`); }

    const { rows } = await db.query(
      `SELECT n.*, m.title AS meeting_title
       FROM notifications n
       LEFT JOIN meetings m ON m.id = n.meeting_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY n.created_at DESC
       LIMIT $${p}`,
      [...params, parseInt(limit)]
    );

    // Unread count
    const { rows: [countRow] } = await db.query(
      "SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL",
      [req.user.id]
    );

    res.json({ notifications: rows, unread_count: parseInt(countRow.count) });
  } catch (err) { next(err); }
});

router.patch("/:id/read",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await db.query(
        "UPDATE notifications SET read_at = NOW(), status = 'read' WHERE id = $1 AND user_id = $2",
        [req.params.id, req.user.id]
      );
      res.json({ message: "Marked as read" });
    } catch (err) { next(err); }
  }
);

router.post("/read-all", authenticate, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      "UPDATE notifications SET read_at = NOW(), status = 'read' WHERE user_id = $1 AND read_at IS NULL",
      [req.user.id]
    );
    res.json({ marked: rowCount });
  } catch (err) { next(err); }
});

router.delete("/:id",
  authenticate,
  param("id").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      await db.query("DELETE FROM notifications WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
      res.json({ message: "Deleted" });
    } catch (err) { next(err); }
  }
);

// Push subscription management
router.post("/push/subscribe", authenticate, async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys) return res.status(400).json({ error: "Invalid push subscription" });

    const sub = JSON.stringify({ endpoint, keys });
    await redis.set(`push_sub:${req.user.id}`, sub, "EX", 30 * 86400); // 30 days

    res.json({ message: "Push subscription saved" });
  } catch (err) { next(err); }
});

router.delete("/push/unsubscribe", authenticate, async (req, res, next) => {
  try {
    await redis.del(`push_sub:${req.user.id}`);
    res.json({ message: "Push subscription removed" });
  } catch (err) { next(err); }
});

module.exports = router;
