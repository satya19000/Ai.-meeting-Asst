// src/middleware/notFound.js
function notFound(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}
module.exports = { notFound };
