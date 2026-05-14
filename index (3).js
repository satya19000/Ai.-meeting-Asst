// src/config/redis.js
const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy: (t) => Math.min(t * 50, 2000),
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on("error",   (e) => console.error("[Redis]", e.message));
redis.on("connect", () =>  console.log("[Redis] connected"));

module.exports = redis;
