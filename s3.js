/**
 * MeetIQ AI — Express Application (src/app.js)
 * Entry: middleware → routes → WebSocket → queues → cron
 */
require("dotenv").config();
const express     = require("express");
const http        = require("http");
const cors        = require("cors");
const helmet      = require("helmet");
const compression = require("compression");
const morgan      = require("morgan");
const rateLimit   = require("express-rate-limit");
const { Server }  = require("socket.io");

const logger      = require("./config/logger");
const db          = require("./config/db");
const redis       = require("./config/redis");
const { initQueues }  = require("./queues");
const { initCron }    = require("./cron");
const socketHandler   = require("./socket");

const authRoutes        = require("./routes/auth");
const userRoutes        = require("./routes/users");
const meetingRoutes     = require("./routes/meetings");
const botRoutes         = require("./routes/bot");
const transcriptRoutes  = require("./routes/transcripts");
const summaryRoutes     = require("./routes/summaries");
const actionRoutes      = require("./routes/actions");
const slideRoutes       = require("./routes/slides");
const momRoutes         = require("./routes/mom");
const exportRoutes      = require("./routes/exports");
const searchRoutes      = require("./routes/search");
const notifRoutes       = require("./routes/notifications");
const analyticsRoutes   = require("./routes/analytics");
const uploadRoutes      = require("./routes/uploads");
const webhookRoutes     = require("./routes/webhooks");

const { errorHandler }  = require("./middleware/errorHandler");
const { notFound }      = require("./middleware/notFound");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:       { origin: process.env.FRONTEND_URL || "*", credentials: true },
  transports: ["websocket", "polling"],
});

app.set("trust proxy", 1);
app.locals.io = io;

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true, methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"] }));
app.use(compression());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(morgan("combined", { stream: { write: m => logger.http(m.trim()) } }));

app.use("/api", rateLimit({ windowMs: 15*60*1000, max: 500, standardHeaders: true, legacyHeaders: false }));
app.use("/api/v1/auth", rateLimit({ windowMs: 15*60*1000, max: 20 }));

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ok", service: "meetiq-api", version: "1.0.0", uptime: process.uptime() });
  } catch (err) { res.status(503).json({ status: "degraded", error: err.message }); }
});

const V1 = "/api/v1";
app.use(`${V1}/auth`,          authRoutes);
app.use(`${V1}/users`,         userRoutes);
app.use(`${V1}/meetings`,      meetingRoutes);
app.use(`${V1}/bot`,           botRoutes);
app.use(`${V1}/transcripts`,   transcriptRoutes);
app.use(`${V1}/summaries`,     summaryRoutes);
app.use(`${V1}/actions`,       actionRoutes);
app.use(`${V1}/slides`,        slideRoutes);
app.use(`${V1}/mom`,           momRoutes);
app.use(`${V1}/exports`,       exportRoutes);
app.use(`${V1}/search`,        searchRoutes);
app.use(`${V1}/notifications`, notifRoutes);
app.use(`${V1}/analytics`,     analyticsRoutes);
app.use(`${V1}/uploads`,       uploadRoutes);
app.use(`${V1}/webhooks`,      webhookRoutes);

app.use(notFound);
app.use(errorHandler);

socketHandler(io);

async function bootstrap() {
  await db.connect();
  logger.info("✅  PostgreSQL connected");
  await redis.ping();
  logger.info("✅  Redis connected");
  initQueues(io);
  logger.info("✅  Bull queues initialized");
  initCron();
  logger.info("✅  Cron jobs scheduled");
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => logger.info(`🚀  MeetIQ API → http://localhost:${PORT}`));
}

bootstrap().catch(err => { logger.error("Bootstrap failed:", err); process.exit(1); });

module.exports = app;
