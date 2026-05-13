// ═══════════════════════════════════════════════
//  config/db.js  — PostgreSQL connection pool
// ═══════════════════════════════════════════════
const { Pool } = require("pg");
const logger   = require("./logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:              20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

pool.on("error", (err) => logger.error("Unexpected PG error", err));

module.exports = {
  connect: async () => {
    const client = await pool.connect();
    client.release();
  },
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
