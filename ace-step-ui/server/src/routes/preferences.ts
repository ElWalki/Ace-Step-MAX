import { Router, Response } from 'express';
import { pool } from '../db/pool.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// Ensure the preferences table exists (idempotent, runs once on module load)
pool.query(
  `CREATE TABLE IF NOT EXISTS user_preferences (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     data TEXT DEFAULT '{}',
     updated_at TEXT DEFAULT (datetime('now'))
   )`
);

// GET /api/preferences — return the current user's stored preferences (templates, settings, ...)
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT data FROM user_preferences WHERE user_id = $1',
      [req.user!.id]
    );
    let data: Record<string, unknown> = {};
    if (result.rows.length > 0 && result.rows[0].data) {
      try { data = JSON.parse(result.rows[0].data); } catch { data = {}; }
    }
    res.json({ data });
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/preferences — replace the current user's preferences blob
router.put('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = req.body?.data ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) {
      res.status(400).json({ error: 'data must be an object' });
      return;
    }
    const dataStr = JSON.stringify(data);
    await pool.query(
      `INSERT INTO user_preferences (user_id, data, updated_at)
       VALUES ($1, $2, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET data = $3, updated_at = datetime('now')`,
      [req.user!.id, dataStr, dataStr]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Save preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
