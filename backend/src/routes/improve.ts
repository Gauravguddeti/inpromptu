/**
 * POST /improve-full
 * ──────────────────
 * Full prompt rewrite endpoint per §9.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, requireAuth, checkRateLimit } from '../lib/auth';
import { runImprovePass } from '../lib/llm-router';
import { IMPROVE_SYSTEM_PROMPT } from '../lib/prompts';

const router = Router();

const ImproveSchema = z.object({
  text: z.string().min(1).max(8000),
  projectId: z.string().uuid().nullable().optional(),
});

// Simple diff generator between original and rewritten text
function computeDiff(original: string, rewritten: string) {
  const origWords = original.split(' ');
  const newWords = rewritten.split(' ');

  // Very simple word-level diff for Phase 1
  // Full Myers diff in Phase 2
  const diff: Array<{ type: 'equal' | 'insert' | 'delete'; value: string }> = [];

  if (original === rewritten) {
    diff.push({ type: 'equal', value: original });
  } else {
    diff.push({ type: 'delete', value: original });
    diff.push({ type: 'insert', value: rewritten });
  }

  return diff;
}

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const rl = checkRateLimit(req.userId!, 'improve');
  if (!rl.allowed) {
    res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rl.retryAfter });
    return;
  }

  const parsed = ImproveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { text } = parsed.data;

  try {
    const userMessage = `Improve this AI prompt:\n\n"${text}"`;
    const rawResult = await runImprovePass(IMPROVE_SYSTEM_PROMPT, userMessage);

    const cleaned = rawResult.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const result = JSON.parse(cleaned) as {
      rewritten: string;
      rationale: string;
      changes: Array<{ type: string; description: string }>;
    };

    const diff = computeDiff(text, result.rewritten);

    res.json({
      rewritten: result.rewritten,
      rationale: result.rationale,
      changes: result.changes ?? [],
      diff,
    });
  } catch (err: unknown) {
    const error = err as Error;
    console.error('[improve-full] Error:', error.message);
    res.status(500).json({ error: 'Improvement temporarily unavailable. Please try again.' });
  }
});

export default router;
