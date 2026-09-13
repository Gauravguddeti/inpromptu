/**
 * Debounce + Diff + Hash Engine
 * ──────────────────────────────
 * Core rate-limit protection layer:
 *  1. Buffers keystrokes; does NOT call backend per keystroke
 *  2. Fires 900ms after typing stops, or on sentence-end punctuation / paste
 *  3. Diffs current text against last-analyzed version (changed paragraph + context)
 *  4. Hashes paragraphs; reuses cached results
 *  5. Phase C/B: Reads session context from localStorage and attaches to every request
 */

import { SiteAdapter } from '../adapters/types';
import { OverlayRenderer } from './overlay-renderer';
import { ExtMessage, AnalyzeRequestPayload, AnalysisResult } from '../types';
import { hashString, computeParagraphDiff } from './utils';
import { pcLogger } from './logger';
import { getSessionContext } from './session-context';

const DEBOUNCE_MS = 900;
const SENTENCE_END_RE = /[.?!\n]/;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnalyzedText = '';
let lastAnalyzedHash = '';

export function initDebounceEngine(adapter: SiteAdapter, renderer: OverlayRenderer) {
  adapter.onTextChange((text: string) => {
    handleTextChange(text, adapter, renderer);
  });

  pcLogger.info(`Debounce engine initialized for adapter: ${adapter.name}`, 'debounce');
}

function handleTextChange(
  text: string,
  adapter: SiteAdapter,
  renderer: OverlayRenderer
) {
  if (!text.trim()) {
    renderer.clear();
    return;
  }

  const lastChar = text[text.length - 1];
  const isImmediateTrigger = SENTENCE_END_RE.test(lastChar);

  if (debounceTimer) clearTimeout(debounceTimer);

  if (isImmediateTrigger) {
    scheduleAnalysis(text, adapter, renderer);
  } else {
    debounceTimer = setTimeout(() => {
      scheduleAnalysis(text, adapter, renderer);
    }, DEBOUNCE_MS);
  }
}

async function scheduleAnalysis(
  text: string,
  adapter: SiteAdapter,
  renderer: OverlayRenderer
) {
  const currentHash = hashString(text.trim());

  if (currentHash === lastAnalyzedHash) {
    pcLogger.debug('Skipping — same hash as last analysis', 'debounce');
    return;
  }

  const diff = computeParagraphDiff(lastAnalyzedText, text);

  // Phase C/B: attach conversation context to every analysis call
  const sessionCtx = getSessionContext();

  const payload: AnalyzeRequestPayload = {
    text,
    changedSpan: diff.changedSpan,
    promptHash: currentHash,
    sessionContext: sessionCtx?.summary,
  };

  lastAnalyzedText = text;
  lastAnalyzedHash = currentHash;

  renderer.setAnalysisPending(true);
  renderer.setLoading(true);
  pcLogger.debug(
    `Sending analysis request (${text.length} chars${sessionCtx ? ', with context' : ''})`,
    'debounce'
  );

  try {
    const result = await sendToServiceWorker<AnalysisResult>(payload);
    if (result) {
      renderer.render(result, adapter);
    }
  } catch (err) {
    pcLogger.error(
      'Analysis request failed',
      'debounce',
      err instanceof Error ? err : new Error(String(err))
    );
    renderer.setAnalysisPending(false);
  } finally {
    renderer.setLoading(false);
  }
}

function sendToServiceWorker<T>(payload: AnalyzeRequestPayload): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const message: ExtMessage<AnalyzeRequestPayload> = {
      type: 'ANALYZE_REQUEST',
      payload,
      requestId: crypto.randomUUID(),
    };

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.type === 'ERROR') {
        reject(new Error(response.payload?.message ?? 'Service worker error'));
        return;
      }
      resolve(response?.payload ?? null);
    });
  });
}

