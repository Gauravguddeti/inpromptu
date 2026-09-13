/**
 * POST /context/scan
 * ───────────────────
 * Phase C: Receives a slice of conversation messages scraped from the DOM,
 * generates an 80-word context summary using the LLM, and returns it.
 * The summary is stored client-side in localStorage by session-context.ts.
 *
 * POST /context/update  (Phase B)
 * ─────────────────────
 * Incrementally updates the session summary when new prompts are tracked.
 * Re-runs summarization every 3 new prompts; otherwise returns the
 * existing summary with an incremented prompt count.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { runPlainPass } from '../lib/llm-router';
import { CONTEXT_SUMMARY_SYSTEM_PROMPT, SESSION_UPDATE_SYSTEM_PROMPT } from '../lib/prompts';
import { logger } from '../lib/logger';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(600),
});

const ScanSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(30),
  sourceUrl: z.string().optional(),
});

const UpdateSchema = z.object({
  newPrompts: z.array(z.string().max(2000)).min(1).max(5),
  currentSummary: z.string().max(500).default(''),
  promptCount: z.number().int().min(0).default(0),
  sessionId: z.string().max(64).optional(),
});

// ─── POST /context/scan  (Phase C) ────────────────────────────────────────────

router.post('/scan', async (req: Request, res: Response) => {
  const parsed = ScanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { messages, sourceUrl } = parsed.data;

  // Format conversation for LLM
  const conversationText = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n\n');

  const userMessage = `Here is the conversation to summarize:\n\n${conversationText}`;

  try {
    const summary = await runPlainPass(CONTEXT_SUMMARY_SYSTEM_PROMPT, userMessage);
    const cleaned = summary.trim().replace(/^["']|["']$/g, '');

    logger.info(
      `Context scan: ${messages.length} messages → ${cleaned.length} char summary`,
      'context'
    );

    res.json({
      summary: cleaned,
      messageCount: messages.length,
      sourceUrl: sourceUrl ?? 'unknown',
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.warn(`Context scan failed: ${error.message}`, 'context');
    res.status(500).json({ error: 'Context summarization failed. Please try again.' });
  }
});

// ─── POST /context/update  (Phase B) ──────────────────────────────────────────

router.post('/update', async (req: Request, res: Response) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { newPrompts, currentSummary, promptCount } = parsed.data;
  const newCount = promptCount + newPrompts.length;

  // Re-summarize every 3 prompts, or if no existing summary
  const shouldUpdate = !currentSummary || newPrompts.length >= 3;

  if (!shouldUpdate) {
    // Just return the existing summary with incremented count (no LLM call)
    res.json({ summary: currentSummary, promptCount: newCount });
    return;
  }

  const userMessage = [
    currentSummary ? `Current summary:\n${currentSummary}` : 'No existing summary yet.',
    '',
    `New prompts submitted by the user:\n${newPrompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
  ].join('\n');

  try {
    const updated = await runPlainPass(SESSION_UPDATE_SYSTEM_PROMPT, userMessage);
    const cleaned = updated.trim().replace(/^["']|["']$/g, '');

    logger.info(
      `Context updated: ${newPrompts.length} new prompts, count=${newCount}`,
      'context'
    );

    res.json({ summary: cleaned, promptCount: newCount });
  } catch (err: unknown) {
    const error = err as Error;
    logger.warn(`Context update failed: ${error.message}`, 'context');
    // Always fall back gracefully — return existing summary
    res.json({ summary: currentSummary, promptCount: newCount });
  }
});

export default router;
