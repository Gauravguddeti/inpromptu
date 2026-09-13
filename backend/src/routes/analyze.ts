/**
 * POST /analyze
 * ─────────────
 * Auth is OPTIONAL — unauthenticated requests get analysis without memory.
 * Authenticated users get memory context injected.
 *
 * Long-prompt support:
 *  - Prompts > CHUNK_THRESHOLD chars are split into overlapping paragraphs
 *  - Each chunk is analyzed in parallel (fast-pass)
 *  - Results are merged and deduplicated by span overlap
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { checkRateLimit } from '../lib/auth';
import { runFastPass, runDeepPass, runChunkPass } from '../lib/llm-router';
import { FAST_PASS_SYSTEM_PROMPT, DEEP_PASS_SYSTEM_PROMPT, makeChunkSystemPrompt } from '../lib/prompts';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import jwt from 'jsonwebtoken';

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const AnalyzeSchema = z.object({
  text: z.string().min(1).max(50000),
  changedSpan: z.object({ start: z.number(), end: z.number() }).optional(),
  sessionSummary: z.string().max(500).optional(),
  /** Phase C/B: 80-word summary of the conversation so far */
  sessionContext: z.string().max(600).optional(),
  projectId: z.string().uuid().nullable().optional(),
  privacyMode: z.boolean().optional().default(false),
});

// ─── Chunking config ──────────────────────────────────────────────────────────

const CHUNK_THRESHOLD = 2500;   // chars — below this, single request
const CHUNK_MAX_SIZE = 2500;    // chars per chunk
const CHUNK_OVERLAP_PARAS = 1;  // paragraphs of overlap at chunk boundaries

// ─── Optional auth extraction (doesn't block if missing) ─────────────────────

function extractUserId(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    const payload = jwt.decode(token) as jwt.JwtPayload | null;
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawIssue {
  span: { start: number; end: number };
  category: string;
  severity: string;
  explanation: string;
  suggestions: string[];
  id?: string;
}

// ─── JSON parsing with cleanup ────────────────────────────────────────────────

function parseAnalysisJSON(raw: string, charOffset = 0): {
  issues: Array<{
    id: string;
    span: { start: number; end: number };
    category: string;
    severity: string;
    explanation: string;
    suggestions: string[];
  }>;
  overall_notes: string;
} {
  // Strip markdown fences if model added them despite instructions
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');

  // Sometimes models wrap in extra object — extract first JSON object
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);

  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed.issues)) parsed.issues = [];

  // Validate + normalize each issue
  parsed.issues = parsed.issues
    .filter((issue: Record<string, unknown>) => {
      const span = issue.span as { start?: number; end?: number } | undefined;
      return typeof span?.start === 'number' && typeof span?.end === 'number';
    })
    .map((issue: Record<string, unknown>) => {
      const span = issue.span as { start: number; end: number };
      return {
        ...issue,
        id: uuidv4(),
        span: {
          start: span.start + charOffset,
          end: span.end + charOffset,
        },
        severity: normalizeSeverity(issue.severity as string),
        explanation: (issue.explanation as string | undefined) ?? (issue.category as string) ?? 'Issue detected',
        suggestions: Array.isArray(issue.suggestions)
          ? (issue.suggestions as unknown[])
              .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
              .slice(0, 3) // Up to 3 suggestions (deep pass allows 3)
          : [],
      };
    });

  return parsed;
}

function normalizeSeverity(s: string): 'red' | 'yellow' | 'blue' {
  if (s === 'red') return 'red';
  if (s === 'blue') return 'blue';
  return 'yellow';
}

// ─── Long-prompt chunking ─────────────────────────────────────────────────────

interface TextChunk {
  text: string;
  charOffset: number; // Position in original full text where this chunk starts
}

/**
 * Splits text into overlapping paragraph-based chunks.
 * Overlap = CHUNK_OVERLAP_PARAS paragraphs at chunk boundaries.
 */
function splitIntoChunks(text: string): TextChunk[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: TextChunk[] = [];

  let currentChunk = '';
  let currentOffset = 0;
  let paraOffset = 0;

  // Track offset of each paragraph in the original text
  const paraOffsets: number[] = [];
  let runningOffset = 0;
  for (const para of paragraphs) {
    paraOffsets.push(runningOffset);
    runningOffset += para.length + 2; // +2 for the \n\n separator
  }

  let i = 0;
  while (i < paragraphs.length) {
    const para = paragraphs[i];
    currentOffset = paraOffsets[i];

    if (!currentChunk) {
      currentChunk = para;
      paraOffset = paraOffsets[i];
    } else if ((currentChunk + '\n\n' + para).length <= CHUNK_MAX_SIZE) {
      currentChunk += '\n\n' + para;
    } else {
      // Emit current chunk
      chunks.push({ text: currentChunk, charOffset: paraOffset });

      // Start new chunk with overlap: rewind by CHUNK_OVERLAP_PARAS
      const overlapStart = Math.max(0, i - CHUNK_OVERLAP_PARAS);
      currentChunk = paragraphs.slice(overlapStart, i + 1).join('\n\n');
      paraOffset = paraOffsets[overlapStart];
    }
    i++;
  }

  // Emit final chunk
  if (currentChunk) {
    chunks.push({ text: currentChunk, charOffset: paraOffset });
  }

  return chunks;
}

// ─── Issue deduplication across chunks ───────────────────────────────────────

function deduplicateMergedIssues(issues: RawIssue[]): RawIssue[] {
  const ORDER: Record<string, number> = { red: 0, yellow: 1, blue: 2 };
  // Sort by severity (most severe first), then by span start
  const sorted = [...issues].sort((a, b) => {
    const sevDiff = (ORDER[a.severity] ?? 1) - (ORDER[b.severity] ?? 1);
    if (sevDiff !== 0) return sevDiff;
    return a.span.start - b.span.start;
  });

  const kept: RawIssue[] = [];
  for (const issue of sorted) {
    // Check if this issue overlaps with a higher-priority already-kept issue
    const isDuplicate = kept.some((existing) => {
      const overlapStart = Math.max(existing.span.start, issue.span.start);
      const overlapEnd = Math.min(existing.span.end, issue.span.end);
      const overlapLen = overlapEnd - overlapStart;
      const issueLen = issue.span.end - issue.span.start;
      // More than 50% overlap with a same-or-higher severity → deduplicate
      return (
        (ORDER[existing.severity] ?? 1) <= (ORDER[issue.severity] ?? 1) &&
        overlapLen > 0 &&
        overlapLen / Math.max(issueLen, 1) > 0.5
      );
    });

    if (!isDuplicate) kept.push(issue);
  }

  return kept;
}

// ─── Memory context ───────────────────────────────────────────────────────────

async function getMemoryContext(userId: string): Promise<string> {
  try {
    const result = await db.query(
      `SELECT kind, content FROM memories
       WHERE user_id = $1 AND disabled = FALSE
       ORDER BY last_used_at DESC NULLS LAST, created_at DESC
       LIMIT 5`,
      [userId]
    );
    if (result.rows.length === 0) return '';
    const entries = result.rows
      .map((r: { kind: string; content: string }) => `[${r.kind}] ${r.content}`)
      .join('\n');
    return `\nUser context from memory:\n${entries}\n`;
  } catch {
    return '';
  }
}

// ─── Route (no requireAuth — optional auth) ───────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const userId = extractUserId(req);

  const rateLimitKey = userId ?? (req.ip ?? 'anon');
  const rl = checkRateLimit(rateLimitKey, 'analyze');
  if (!rl.allowed) {
    res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rl.retryAfter });
    return;
  }

  const parsed = AnalyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { text, changedSpan, sessionSummary, sessionContext, privacyMode } = parsed.data;

  if (privacyMode) {
    res.json({ issues: [], overall_notes: 'Privacy mode active.', analyzed_at: Date.now() });
    return;
  }

  try {
    // Attach memory context if user is authenticated
    let memCtx = '';
    if (userId) {
      memCtx = await getMemoryContext(userId);
    }

    logger.info(`Analyzing prompt (${text.length} chars, user: ${userId ? 'auth' : 'anon'})`);

    let allIssues: RawIssue[] = [];
    let overallNotes = '';

    // Build a conversation context prefix (Phase C/B)
    // This is prepended to the user message so the LLM understands what was discussed before
    const ctxPrefix = sessionContext
      ? `CONVERSATION CONTEXT (what the user has been discussing):\n${sessionContext}\n\n`
      : '';

    // ── Path A: Short prompt (< CHUNK_THRESHOLD) — single request ─────────────
    if (text.length < CHUNK_THRESHOLD) {
      let userMessage = `${ctxPrefix}Analyze this AI prompt for quality issues:\n\n"${text}"`;
      if (sessionSummary) userMessage += `\n\nSession context: ${sessionSummary}`;
      if (changedSpan) userMessage += `\n\nChanged region: chars ${changedSpan.start}–${changedSpan.end}`;
      if (memCtx) userMessage += memCtx;

      const isShortPrompt = text.length < 200;
      let rawResult: string;

      if (isShortPrompt) {
        rawResult = await runFastPass(FAST_PASS_SYSTEM_PROMPT, userMessage);
      } else {
        rawResult = await runDeepPass(DEEP_PASS_SYSTEM_PROMPT, userMessage);
      }


      let analysisResult;
      try {
        analysisResult = parseAnalysisJSON(rawResult);
      } catch (parseErr) {
        logger.warn(`First JSON parse failed, retrying fast pass: ${(parseErr as Error).message}`);
        const retry = await runFastPass(FAST_PASS_SYSTEM_PROMPT, userMessage);
        analysisResult = parseAnalysisJSON(retry);
      }

      allIssues = analysisResult.issues;
      overallNotes = analysisResult.overall_notes ?? '';

    // ── Path B: Long prompt — chunked parallel analysis ───────────────────────
    } else {
      const chunks = splitIntoChunks(text);
      logger.info(`Long prompt: split into ${chunks.length} chunks for parallel analysis`);

      const chunkInputs = chunks.map((chunk, idx) => {
        const systemPrompt = makeChunkSystemPrompt(idx, chunks.length, chunk.charOffset);
        let userMessage = `Analyze this AI prompt segment for quality issues:\n\n"${chunk.text}"`;
        if (sessionSummary) userMessage += `\n\nFull prompt context: ${sessionSummary}`;
        if (memCtx) userMessage += memCtx;
        return { systemPrompt, userMessage, charOffset: chunk.charOffset };
      });

      const rawResults = await runChunkPass(
        chunkInputs.map(({ systemPrompt, userMessage }) => ({ systemPrompt, userMessage }))
      );

      // Parse results and correct offsets
      const notesArr: string[] = [];
      for (let i = 0; i < rawResults.length; i++) {
        try {
          const charOffset = chunkInputs[i]?.charOffset ?? 0;
          const chunkResult = parseAnalysisJSON(rawResults[i], charOffset);
          allIssues.push(...chunkResult.issues);
          if (chunkResult.overall_notes) notesArr.push(chunkResult.overall_notes);
        } catch (err) {
          logger.warn(`Failed to parse chunk ${i} result: ${(err as Error).message}`);
        }
      }

      // Merge and deduplicate overlapping issues across chunks
      allIssues = deduplicateMergedIssues(allIssues);
      overallNotes = notesArr.slice(0, 2).join(' ');
    }

    logger.info(`Analysis complete: ${allIssues.length} issues found`);

    res.json({
      issues: allIssues,
      overall_notes: overallNotes,
      analyzed_at: Date.now(),
    });
  } catch (err: unknown) {
    const error = err as Error;
    logger.error(`Analysis error: ${error.message}`);
    res.status(500).json({ error: 'Analysis temporarily unavailable. Please try again.' });
  }
});

export default router;
