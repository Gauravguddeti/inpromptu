/**
 * POST /feedback
 * ───────────────
 * Acceptance/rejection signal for evaluation loop per §10.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth } from '../lib/auth';
import { db } from '../lib/db';

const router = Router();

const FeedbackSchema = z.object({
  suggestionId: z.string(),
  accepted: z.boolean(),
  category: z.string(),
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = FeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const { suggestionId, accepted, category } = parsed.data;

  try {
    await db.query(
      `INSERT INTO feedback (user_id, suggestion_id, category, accepted)
       VALUES ($1, $2, $3, $4)`,
      [req.userId, suggestionId, category, accepted]
    );

    // If the suggestion was accepted, store it as a correction in memory
    if (accepted) {
      db.query(
        `INSERT INTO memories (user_id, kind, content)
         VALUES ($1, 'correction', $2)
         ON CONFLICT DO NOTHING`,
        [req.userId, `Accepted fix for category: ${category} (ID: ${suggestionId})`]
      ).catch(() => { /* non-critical */ });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback] Error:', err);
    res.status(500).json({ error: 'Failed to record feedback' });
  }
});

export default router;
