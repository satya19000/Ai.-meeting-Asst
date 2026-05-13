// src/socket/index.js — WebSocket event handler
const jwt    = require("jsonwebtoken");
const db     = require("../config/db");
const redis  = require("../config/redis");
const logger = require("../config/logger");

function socketHandler(io) {
  // ── Auth middleware for every socket connection ────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
                 || socket.handshake.query?.token;
      if (!token) return next(new Error("Authentication required"));

      const payload = jwt.verify(token, process.env.JWT_SECRET);

      // Check blacklist
      const blacklisted = await redis.get(`bl:${token}`);
      if (blacklisted) return next(new Error("Token revoked"));

      const { rows } = await db.query(
        "SELECT id, org_id, full_name, role FROM users WHERE id = $1 AND is_active = TRUE",
        [payload.sub]
      );
      if (!rows[0]) return next(new Error("User not found"));

      socket.user  = rows[0];
      socket.token = token;
      next();
    } catch (e) { next(new Error("Unauthorized")); }
  });

  io.on("connection", (socket) => {
    const user = socket.user;
    logger.info(`[WS] +  ${user.full_name} (${user.role}) — ${socket.id}`);

    // Auto-join org room
    socket.join(`org:${user.org_id}`);

    // ── Join a meeting room ──────────────────────────────────
    socket.on("join:meeting", async ({ meeting_id }) => {
      try {
        const { rows } = await db.query(
          "SELECT id FROM meetings WHERE id = $1 AND org_id = $2",
          [meeting_id, user.org_id]
        );
        if (!rows[0]) return socket.emit("error", { message: "Meeting not found" });

        socket.join(`meeting:${meeting_id}`);
        socket.emit("joined:meeting", { meeting_id });
        logger.debug(`[WS] ${user.full_name} joined meeting:${meeting_id}`);
      } catch (e) { socket.emit("error", { message: "Join failed" }); }
    });

    socket.on("leave:meeting", ({ meeting_id }) => {
      socket.leave(`meeting:${meeting_id}`);
    });

    // ── Bot relays live transcript segments ──────────────────
    // This channel is used by the bot worker via socket.io client
    socket.on("transcript:segment", async (data) => {
      // Only bot tokens or super_admin can push segments
      if (!["super_admin","department_staff"].includes(user.role)) return;

      const { meeting_id, segment } = data;
      if (!meeting_id || !segment) return;

      // Fan out to the meeting room
      io.to(`meeting:${meeting_id}`).emit("transcript:segment", segment);

      // Buffer in Redis for late-joiners (keep last 500 per meeting)
      await redis.lpush(`transcript:live:${meeting_id}`, JSON.stringify(segment));
      await redis.ltrim(`transcript:live:${meeting_id}`, 0, 499);
      await redis.expire(`transcript:live:${meeting_id}`, 86400);
    });

    // ── Catch-up: send buffered transcript on re-join ────────
    socket.on("transcript:catch-up", async ({ meeting_id }) => {
      try {
        const raw = await redis.lrange(`transcript:live:${meeting_id}`, 0, -1);
        const segments = raw.map(s => { try { return JSON.parse(s); } catch { return null; } })
                            .filter(Boolean)
                            .reverse(); // oldest first
        socket.emit("transcript:history", segments);
      } catch {}
    });

    // ── Typing / presence indicators (lightweight) ──────────
    socket.on("presence:ping", ({ meeting_id }) => {
      socket.to(`meeting:${meeting_id}`).emit("presence:user", {
        user_id:   user.id,
        full_name: user.full_name,
        role:      user.role,
        ts:        Date.now(),
      });
    });

    socket.on("disconnect", (reason) => {
      logger.info(`[WS] -  ${user.full_name} — ${reason}`);
    });

    socket.on("error", (e) => logger.error("[WS] error:", e.message));
  });
}

module.exports = socketHandler;
