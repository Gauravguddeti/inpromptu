/**
 * LLM Provider Router
 * ────────────────────
 * Two-tier model routing per §5.1:
 *  - Fast pass: Groq (openai/gpt-oss-120b → gpt-oss-20b → qwen3.8-27b)
 *  - Deep pass: Gemini 2.0 Flash → fallback to Groq silently on rate-limit/error
 *
 * IMPORTANT: All fallback logic is handled HERE in the backend.
 * The client never sees errors from provider failures — they get results or silence.
 */

import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ─── Clients ──────────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');

// ─── Groq model cascade (best → fallback) ─────────────────────────────────────
// NOTE: openai/gpt-oss-* models have unreliable JSON mode — they frequently fail
// with json_validate_failed. Use qwen first since it consistently returns valid JSON.
const GROQ_MODELS = [
  'qwen/qwen3-5-32b',       // Primary — reliably produces valid JSON
  'qwen/qwen3.8-27b',       // Secondary fallback
  'openai/gpt-oss-20b',     // Tertiary (smaller, may work)
  'openai/gpt-oss-120b',    // Last resort (larger but JSON mode flaky)
];

// ─── Token budgets ─────────────────────────────────────────────────────────────

const FAST_PASS_MAX_TOKENS = 1000;  // Raised: concrete suggestions need more tokens
const DEEP_PASS_MAX_TOKENS = 2000;  // Raised: up to 8 issues with 3 suggestions each
const IMPROVE_MAX_TOKENS = 2000;    // Full rewrite

// ─── Fast-pass analysis (Groq) ────────────────────────────────────────────────

export async function runFastPass(
  systemPrompt: string,
  userMessage: string,
  _retryCount = 0
): Promise<string> {
  for (const model of GROQ_MODELS) {
    try {
      console.log(`[LLM] Fast pass with Groq model: ${model}`);
      const response = await groq.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: FAST_PASS_MAX_TOKENS,
        temperature: 0.1, // Low temp for deterministic JSON output
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content ?? '';
      if (content) return content;
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      if (error.status === 429 || error.status === 503) {
        // Rate limited or unavailable — try next model
        console.warn(`[LLM] Groq model ${model} rate-limited, trying next...`);
        continue;
      }
      console.error(`[LLM] Groq model ${model} error:`, error.message);
      // Try next model for any error
    }
  }

  throw new Error('All Groq models exhausted');
}

// ─── Plain-text pass (no JSON mode — for refinement calls) ───────────────────

export async function runPlainPass(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  // Use only the most reliable small model for speed — no JSON constraint needed
  const PLAIN_MODELS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];

  for (const model of PLAIN_MODELS) {
    try {
      const response = await groq.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 150,  // Refinement output should always be short
        temperature: 0.1,
        // No response_format: JSON — we want raw text
      });

      const content = response.choices[0]?.message?.content?.trim() ?? '';
      if (content) return content;
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      if (error.status === 429 || error.status === 503) continue;
      console.warn(`[LLM] Plain pass model ${model} error:`, error.message);
    }
  }

  throw new Error('All plain-pass models exhausted');
}



// ─── Deep-pass analysis (Gemini → Groq fallback) ─────────────────────────────

export async function runDeepPass(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  // Try Gemini first
  try {
    console.log('[LLM] Deep pass with Gemini Flash');
    const model = gemini.getGenerativeModel({
      model: 'gemini-2.5-flash-preview-05-20',
      generationConfig: {
        maxOutputTokens: DEEP_PASS_MAX_TOKENS,
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(userMessage);
    const text = result.response.text();
    if (text) {
      console.log('[LLM] Gemini deep pass succeeded');
      return text;
    }
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    // 429 = rate limit, 503 = overloaded — fall through to Groq silently
    if (error.status === 429 || error.status === 503 || error.status === 500) {
      console.warn('[LLM] Gemini unavailable, falling back to Groq silently:', error.message);
    } else {
      console.error('[LLM] Gemini error (non-rate-limit):', error.message);
    }
    // Fall through to Groq regardless of error type
  }

  // Groq fallback for deep pass — use the best model with higher token budget
  console.log('[LLM] Deep pass falling back to Groq');
  for (const model of GROQ_MODELS) {
    try {
      const response = await groq.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: DEEP_PASS_MAX_TOKENS,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content ?? '';
      if (content) {
        console.log(`[LLM] Groq fallback deep pass succeeded with ${model}`);
        return content;
      }
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      if (error.status === 429) continue;
      console.error(`[LLM] Groq fallback ${model} error:`, error.message);
    }
  }

  throw new Error('All LLM providers exhausted for deep pass');
}

// ─── Full prompt improvement (Gemini → Groq fallback) ─────────────────────────

export async function runImprovePass(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  // Try Gemini first (best quality for rewrites)
  try {
    console.log('[LLM] Improve pass with Gemini Flash');
    const model = gemini.getGenerativeModel({
      model: 'gemini-2.5-flash-preview-05-20',
      generationConfig: {
        maxOutputTokens: IMPROVE_MAX_TOKENS,
        temperature: 0.3,
        responseMimeType: 'application/json',
      },
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(userMessage);
    const text = result.response.text();
    if (text) return text;
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    console.warn('[LLM] Gemini improve pass failed, falling back to Groq:', error.message);
  }

  // Groq fallback
  for (const model of GROQ_MODELS) {
    try {
      const response = await groq.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: IMPROVE_MAX_TOKENS,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });
      const content = response.choices[0]?.message?.content ?? '';
      if (content) return content;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 429) continue;
    }
  }

  throw new Error('All LLM providers exhausted for improve pass');
}

// ─── Chunk pass (parallel fast passes for long prompts) ──────────────────────

export interface ChunkPassInput {
  systemPrompt: string;
  userMessage: string;
}

/**
 * Runs up to `maxConcurrent` fast-pass calls in parallel.
 * Returns array of raw JSON strings (one per chunk).
 * Failed chunks return null and are silently dropped.
 */
export async function runChunkPass(
  chunks: ChunkPassInput[],
  maxConcurrent = 3
): Promise<string[]> {
  const results: (string | null)[] = new Array(chunks.length).fill(null);

  // Process chunks in batches of maxConcurrent
  for (let i = 0; i < chunks.length; i += maxConcurrent) {
    const batch = chunks.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(
      batch.map(({ systemPrompt, userMessage }) =>
        runFastPass(systemPrompt, userMessage)
      )
    );

    batchResults.forEach((result, batchIdx) => {
      if (result.status === 'fulfilled' && result.value) {
        results[i + batchIdx] = result.value;
      } else if (result.status === 'rejected') {
        console.warn(`[LLM] Chunk ${i + batchIdx} failed:`, (result as PromiseRejectedResult).reason?.message);
      }
    });
  }

  return results.filter((r): r is string => r !== null);
}

