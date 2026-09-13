/**
 * session-context.ts
 * ──────────────────
 * Manages the per-tab session context in localStorage.
 *
 * Storage key: `pc_session_ctx_<tabHostname>`
 * e.g. `pc_session_ctx_chat.openai.com`
 *
 * Phase C: Written by ScanContextRequest flow (Scan Chat button).
 * Phase B: Updated incrementally by TrackPromptRequest flow (submit hook).
 * Phase D: Auto-refreshed on page load + merged with cloud storage.
 *
 * The context is included in every /analyze call via the debounce engine.
 */

import { SessionContext } from '../types';

const KEY_PREFIX = 'pc_session_ctx_';
const SESSION_ID_KEY = 'pc_session_id';

// ─── Session ID ────────────────────────────────────────────────────────────────

/** Returns a stable tab-scoped session ID (survives page refresh in same tab). */
export function getSessionId(): string {
  let id = sessionStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

// ─── Storage key ───────────────────────────────────────────────────────────────

function storageKey(): string {
  return `${KEY_PREFIX}${location.hostname}`;
}

// ─── Read / Write ──────────────────────────────────────────────────────────────

export function getSessionContext(): SessionContext | null {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    return JSON.parse(raw) as SessionContext;
  } catch {
    return null;
  }
}

export function setSessionContext(ctx: SessionContext): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(ctx));
  } catch {
    // localStorage quota exceeded — silently fail
  }
}

export function clearSessionContext(): void {
  localStorage.removeItem(storageKey());
}

// ─── Update helpers ────────────────────────────────────────────────────────────

/** Called by the Scan Chat flow to store a freshly generated summary. */
export function storeScannedContext(
  summary: string,
  scannedMessageCount: number
): SessionContext {
  const ctx: SessionContext = {
    summary,
    promptCount: 0,
    lastUpdatedAt: Date.now(),
    sourceUrl: location.href,
    scannedMessageCount,
  };
  setSessionContext(ctx);
  return ctx;
}

/** Called by the Phase B submit hook after a context update response. */
export function updateTrackedContext(summary: string, promptCount: number): SessionContext {
  const existing = getSessionContext();
  const ctx: SessionContext = {
    summary,
    promptCount,
    lastUpdatedAt: Date.now(),
    sourceUrl: location.href,
    scannedMessageCount: existing?.scannedMessageCount ?? 0,
  };
  setSessionContext(ctx);
  return ctx;
}
