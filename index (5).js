/**
 * routes/search.js — Global full-text search
 *
 * GET /api/v1/search?q=&resource=&limit=
 */
const router = require("express").Router();
const { query } = require("express-validator");
const db    = require("../config/db");
const { authenticate, validate } = require("../middleware/auth");

router.get("/",
  authenticate,
  query("q").notEmpty().trim().isLength({ min: 2 }),
  query("resource").optional().isIn(["meetings","action_items","transcripts"]),
  query("limit").optional().isInt({ min: 1, max: 50 }),
  validate,
  async (req, res, next) => {
    try {
      const { q, resource, limit = 15 } = req.query;
      const orgId = req.user.org_id;

      // Build ts_query safely: join words with & for AND search, fallback to :* prefix
      const words   = q.trim().split(/\s+/).filter(Boolean);
      const tsQuery = words.map(w => w.replace(/['"\\:!|&()]/g, "") + ":*").join(" & ");
      if (!tsQuery) return res.status(400).json({ error: "Invalid search query" });

      // 1. Search main index (meetings, action items, MoM)
      const conditions = ["si.org_id = $1", "si.tsv @@ to_tsquery('english', $2)"];
      const params     = [orgId, tsQuery];
      let p = 3;

      if (resource) {
        conditions.push(`si.resource = $${p++}`);
        params.push(resource);
      }

      const { rows: indexed } = await db.query(
        `SELECT
           si.resource, si.resource_id,
           si.title,
           ts_headline('english', COALESCE(si.body,''), to_tsquery('english',$2),
             'MaxFragments=2,MaxWords=20,MinWords=5,StartSel="<mark>",StopSel="</mark>"') AS excerpt,
           ts_rank_cd(si.tsv, to_tsquery('english',$2), 32) AS rank,
           si.updated_at
         FROM search_index si
         WHERE ${conditions.join(" AND ")}
         ORDER BY rank DESC
         LIMIT $${p}`,
        [...params, parseInt(limit)]
      );

      // 2. Also search transcript text directly (live segments)
      const { rows: segRows } = await db.query(
        `SELECT
           'transcript_segment'::text AS resource,
           ts.id AS resource_id,
           ts.speaker_label           AS title,
           ts_headline('english', ts.text, to_tsquery('english',$2),
             'MaxFragments=1,MaxWords=25,MinWords=8,StartSel="<mark>",StopSel="</mark>"') AS excerpt,
           ts_rank_cd(to_tsvector('english', ts.text), to_tsquery('english',$2)) AS rank,
           ts.start_ms,
           m.id   AS meeting_id,
           m.title AS meeting_title,
           m.started_at AS meeting_date
         FROM transcript_segments ts
         JOIN meetings m ON m.id = ts.meeting_id
         WHERE m.org_id = $1
           AND to_tsvector('english', ts.text) @@ to_tsquery('english', $2)
         ORDER BY rank DESC
         LIMIT 5`,
        [orgId, tsQuery]
      );

      const combined = [...indexed, ...segRows]
        .sort((a, b) => parseFloat(b.rank) - parseFloat(a.rank))
        .slice(0, parseInt(limit));

      res.json({
        query:       q,
        total:       combined.length,
        results:     combined,
        ts_query:    tsQuery,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
