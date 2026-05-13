// src/services/auditService.js
const db = require("../config/db");

async function auditLog(userId, orgId, action, resource, resourceId, oldVal = null, newVal = null) {
  try {
    await db.query(
      `INSERT INTO audit_log
         (user_id, org_id, action, resource, resource_id, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        userId, orgId, action, resource, resourceId,
        oldVal ? JSON.stringify(oldVal) : null,
        newVal ? JSON.stringify(newVal) : null,
      ]
    );
  } catch { /* non-blocking */ }
}

module.exports = { auditLog };
