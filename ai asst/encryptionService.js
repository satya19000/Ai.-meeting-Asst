// ── src/services/encryptionService.js ────────────────────────
const crypto    = require("crypto");
const ALGORITHM = "aes-256-gcm";

function encryptField(text) {
  if (!text) return null;
  const key     = Buffer.from(process.env.ENCRYPTION_KEY || "0".repeat(64), "hex");
  const iv      = crypto.randomBytes(16);
  const cipher  = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return [iv, tag, encrypted].map(b => b.toString("hex")).join(":");
}

function decryptField(enc) {
  if (!enc || !enc.includes(":")) return enc;
  try {
    const [ivHex, tagHex, encHex] = enc.split(":");
    const key     = Buffer.from(process.env.ENCRYPTION_KEY || "0".repeat(64), "hex");
    const iv      = Buffer.from(ivHex,  "hex");
    const tag     = Buffer.from(tagHex, "hex");
    const data    = Buffer.from(encHex, "hex");
    const d       = crypto.createDecipheriv(ALGORITHM, key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch { return null; }
}

module.exports = { encryptField, decryptField };
