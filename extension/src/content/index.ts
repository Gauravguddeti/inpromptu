/**
 * PromptCoach Content Script
 * ───────────────────────────
 * Boots adapters, overlay renderer, debounce engine, in-page scan button,
 * and handles message traffic from the popup/service-worker.
 */

import { initDebounceEngine } from './debounce-engine';
import { detectAdapter } from '../adapters';
import { OverlayRenderer } from './overlay-renderer';
import { ScanButton } from './scan-button';
import { scrapeConversationMessages } from './conversation-scraper';
import { pcLogger, installGlobalErrorHandlers } from './logger';
import {
  getSessionContext,
  getSessionId,
  clearSessionContext,
  storeScannedContext,
  updateTrackedContext,
} from './session-context';

installGlobalErrorHandlers();

let initialized = false;
let currentAdapter: ReturnType<typeof detectAdapter> = null;
let scanButton: ScanButton | null = null;

// ─── Message hub ─────────────────────────────────────────────────────────────
// Handles messages from popup or background script.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    // Popup reads conversation messages (via tabs.sendMessage — kept as fallback)
    case 'READ_CONVERSATION_HISTORY': {
      const maxMessages: number = msg.payload?.maxMessages ?? 20;
      const messages = scrapeConversationMessages(maxMessages);
      sendResponse({ payload: { messages } });
      return false;
    }

    // Popup stores a freshly generated summary
    case 'STORE_SESSION_CONTEXT': {
      const { summary, messageCount } = msg.payload ?? {};
      if (summary) storeScannedContext(summary, messageCount ?? 0);
      sendResponse({ payload: { ok: true } });
      return false;
    }

    // Popup reads current context from localStorage
    case 'GET_SESSION_CONTEXT': {
      sendResponse({ payload: getSessionContext() });
      return false;
    }

    // Popup clears context
    case 'CLEAR_SESSION_CONTEXT': {
      clearSessionContext();
      if (scanButton) scanButton.setState('stale');
      sendResponse({ payload: null });
      return false;
    }

    // Popup/background tells the in-page button to update its state
    case 'SET_SCAN_BTN_STATE': {
      if (scanButton && msg.payload?.state) {
        scanButton.setState(msg.payload.state);
      }
      return false;
    }

    default:
      return false;
  }
});

// ─── Core scan function (shared by scan button + submit hook) ─────────────────

async function performScan(): Promise<void> {
  const messages = scrapeConversationMessages(20);

  if (!messages.length) {
    throw new Error('No conversation messages found on this page. Start a chat first, then scan.');
  }

  const resp = await chrome.runtime.sendMessage({
    type: 'SCAN_CONTEXT_REQUEST',
    payload: { messages, sourceUrl: location.href },
  });

  if (!resp?.payload?.summary) {
    throw new Error(resp?.payload?.error ?? 'Summarization failed');
  }

  storeScannedContext(resp.payload.summary, resp.payload.messageCount ?? messages.length);
  pcLogger.info(`Context scanned: ${messages.length} messages → ${resp.payload.summary.length} chars`, 'scan');
}

// ─── Phase B: Submit hook ─────────────────────────────────────────────────────

function attachSubmitHook(adapter: NonNullable<ReturnType<typeof detectAdapter>>): void {
  adapter.onSubmit(async (promptText: string) => {
    const existing = getSessionContext();
    if (!existing) return; // Only track after a scan has been done first

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'TRACK_PROMPT_REQUEST',
        payload: {
          prompt: promptText,
          sessionId: getSessionId(),
          currentSummary: existing.summary,
          promptCount: existing.promptCount,
        },
      });

      if (resp?.payload?.summary) {
        updateTrackedContext(resp.payload.summary, resp.payload.promptCount);
        pcLogger.debug(`Context updated: count=${resp.payload.promptCount}`, 'submit-hook');
      }
    } catch (err) {
      pcLogger.debug(`Submit tracking silently failed: ${(err as Error).message}`, 'submit-hook');
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  if (initialized) return;

  const adapter = detectAdapter();
  if (!adapter) {
    pcLogger.warn('No adapter detected for this page', 'boot');
    return;
  }

  currentAdapter = adapter;

  // Core analysis overlay
  const renderer = new OverlayRenderer();
  initDebounceEngine(adapter, renderer);

  // Phase B: track submitted prompts
  attachSubmitHook(adapter);

  // In-page scan button — try to mount near editor, retry if not yet in DOM
  scanButton = new ScanButton();

  function mountScanButton() {
    const editorEl = adapter.getEditorElement();
    scanButton!.mount(performScan, editorEl);
  }

  // Try immediately, then retry at short intervals in case editor isn't ready
  mountScanButton();
  let retryCount = 0;
  const retryTimer = setInterval(() => {
    const editorEl = adapter.getEditorElement();
    if (editorEl || ++retryCount >= 10) {
      clearInterval(retryTimer);
      if (editorEl) {
        // Re-mount with the now-available editor
        scanButton!.unmount();
        scanButton!.mount(performScan, editorEl);
      }
    }
  }, 500);

  initialized = true;
  pcLogger.info(`Booted with adapter: ${adapter.name}`, 'boot');
}

boot();

// If editor not yet in DOM, retry on mutations
if (!initialized) {
  const observer = new MutationObserver(() => {
    boot();
    if (initialized) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

