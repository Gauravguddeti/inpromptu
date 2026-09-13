/**
 * POST /refine-suggestion
 * ───────────────────────
 * Given a full prompt text, a flagged span, and a raw suggestion,
 * returns a grammatically-integrated replacement that fits the span's
 * position without changing the surrounding sentence meaning.
 *
 * This is called client-side BEFORE applying any suggestion to the editor.
 * It's a fast call (< 500ms) using the smallest reliable Groq model.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { runPlainPass } from '../lib/llm-router';
import { REFINE_SUGGESTION_SYSTEM_PROMPT } from '../lib/prompts';
import { logger } from '../lib/logger';

const router = Router();

const RefineSchema = z.object({
  fullText: z.string().min(1).max(50000),
  spanStart: z.number().int().min(0),
  spanEnd: z.number().int().min(0),
  suggestion: z.string().min(1).max(500),
  category: z.string().optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = RefineSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { fullText, spanStart, spanEnd, suggestion, category } = parsed.data;

  // Clamp span
  const start = Math.max(0, Math.min(spanStart, fullText.length));
  const end = Math.max(start, Math.min(spanEnd, fullText.length));
  const originalSpan = fullText.slice(start, end);

  // If the suggestion IS the whole prompt replacement (whole-span, unclear_objective),
  // no refinement needed — just return as-is
  const spanFraction = (end - start) / fullText.length;
  const isWholePrompt = spanFraction > 0.55 && category === 'unclear_objective';
  if (isWholePrompt) {
    res.json({ refinedSuggestion: suggestion.trim() });
    return;
  }

  // Extract context window (up to 60 chars before and after the span)
  const contextBefore = fullText.slice(Math.max(0, start - 60), start);
  const contextAfter = fullText.slice(end, Math.min(fullText.length, end + 60));

  try {
    const userMessage = `Sentence context:
"${contextBefore}[SPAN]${contextAfter}"

Original text in [SPAN]: "${originalSpan}"
Suggested replacement: "${suggestion}"

Return ONLY the refined replacement text that fits grammatically in the [SPAN] position. No quotes, no explanation, nothing else.`;

    // Use a stripped-down system prompt — no JSON output, just raw text
    const rawRefined = await runPlainPass(REFINE_SUGGESTION_SYSTEM_PROMPT, userMessage);

    // Clean up any quotes or extra whitespace the model might add
    const refined = rawRefined
      .trim()
      .replace(/^["']|["']$/g, '')   // strip surrounding quotes
      .replace(/^(Here is|The refined|Result:|Output:).*/i, '') // strip prefixes
      .trim();

    logger.debug(`Refined suggestion: "${suggestion}" → "${refined}"`, 'refine');

    // Safety: if the refine call returned something empty or too long, fall back
    if (!refined || refined.length > suggestion.length * 3) {
      res.json({ refinedSuggestion: suggestion.trim() });
      return;
    }

    res.json({ refinedSuggestion: refined });
  } catch (err: unknown) {
    const error = err as Error;
    logger.warn(`Refine suggestion failed (using original): ${error.message}`, 'refine');
    // Always fall back gracefully — the original suggestion is better than nothing
    res.json({ refinedSuggestion: suggestion.trim() });
  }
});

export default router;
