/**
 * GET/POST/DELETE /memory
 * ────────────────────────
 * Full CRUD for user memory entries per §9.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth } from '../lib/auth';
import { db } from '../lib/db';

const router = Router();

const CreateMemorySchema = z.object({
  kind: z.enum(['preference', 'glossary', 'project', 'correction']),
  content: z.string().min(1).max(2000),
  project_id: z.string().uuid().nullable().optional(),
});

const UpdateMemorySchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  disabled: z.boolean().optional(),
});

// GET /memory — list all memories for the user
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, user_id, project_id, kind, content, created_at, last_used_at, disabled
       FROM memories
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[memory GET] Error:', err);
    res.status(500).json({ error: 'Failed to fetch memories' });
  }
});

// POST /memory — create a new memory entry
router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = CreateMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { kind, content, project_id } = parsed.data;

  try {
    const result = await db.query(
      `INSERT INTO memories (user_id, project_id, kind, content)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.userId, project_id ?? null, kind, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[memory POST] Error:', err);
    res.status(500).json({ error: 'Failed to create memory' });
  }
});

// POST /memory/:id — update a memory entry
router.post('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const parsed = UpdateMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const { content, disabled } = parsed.data;

  try {
    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (content !== undefined) {
      updates.push(`content = $${paramIdx++}`);
      values.push(content);
    }
    if (disabled !== undefined) {
      updates.push(`disabled = $${paramIdx++}`);
      values.push(disabled);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id);
    values.push(req.userId);

    const result = await db.query(
      `UPDATE memories
       SET ${updates.join(', ')}
       WHERE id = $${paramIdx++} AND user_id = $${paramIdx}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[memory PATCH] Error:', err);
    res.status(500).json({ error: 'Failed to update memory' });
  }
});

// DELETE /memory/:id — delete a memory entry
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json({ deleted: id });
  } catch (err) {
    console.error('[memory DELETE] Error:', err);
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

export default router;
