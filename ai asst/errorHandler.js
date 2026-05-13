// ═══════════════════════════════════════════════════════════
//  middleware/errorHandler.js
// ═══════════════════════════════════════════════════════════
const logger = require("../config/logger");

function errorHandler(err, req, res, _next) {
  const status  = err.status || err.statusCode || 500;
  const expose  = status < 500;
  const message = expose ? err.message : "Internal server error";

  if (status >= 500) {
    logger.error({
      message: err.message,
      stack:   err.stack,
      path:    req.path,
      method:  req.method,
      user:    req.user?.id,
    });
  }

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== "production" && {
      detail: err.message,
      stack:  err.stack?.split("\n").slice(0, 5),
    }),
  });
}

module.exports = { errorHandler };


// ═══════════════════════════════════════════════════════════
//  middleware/notFound.js
// ═══════════════════════════════════════════════════════════
function notFound(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

module.exports = { notFound };
