/**
 * Inpromptu Service Worker (background script)
 * ─────────────────────────────────────────────
 * Responsibilities:
 *  • Auth token cache (Supabase JWT)
 *  • Request queue + rate limiter
 *  • Local analysis cache (hash → result)
 *  • Routes messages from content script → backend API
 */

import {
  ExtMessage,
  AnalyzeRequestPayload,
  AnalysisResult,
  ImproveFullRequestPayload,
  ImproveFullResponse,
  FeedbackPayload,
  RefineRequestPayload,
  RefineResponse,
  ScanContextRequestPayload,
  ScanContextResponse,
  TrackPromptRequestPayload,
  TrackPromptResponse,
  AuthState,
  ExtensionSettings,
  DEFAULT_SETTINGS,
} from '../types';


// ─── Constants ────────────────────────────────────────────────────────────────

const BACKEND_URL = 'https://inpromptu-backend.onrender.com';

// ─── In-memory cache (analysis results) ──────────────────────────────────────

const analysisCache = new Map<string, AnalysisResult>();
const CACHE_MAX_SIZE = 100;

function cacheGet(hash: string): AnalysisResult | undefined {
  return analysisCache.get(hash);
}

function cacheSet(hash: string, result: AnalysisResult): void {
  if (analysisCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entry
    const firstKey = analysisCache.keys().next().value;
    if (firstKey) analysisCache.delete(firstKey);
  }
  analysisCache.set(hash, result);
}

// ─── Auth state (in-memory) ───────────────────────────────────────────────────

let authState: AuthState = {
  isAuthenticated: false,
  userId: null,
  email: null,
  accessToken: null,
};

// Restore auth from storage on startup
chrome.storage.local.get(['auth_state'], (result) => {
  if (result.auth_state) {
    authState = result.auth_state;
  }
});

function persistAuth(state: AuthState) {
  authState = state;
  chrome.storage.local.set({ auth_state: state });
}

// ─── Request rate limiter ─────────────────────────────────────────────────────

const requestQueue: Array<() => Promise<void>> = [];
let activeRequests = 0;
const MAX_CONCURRENT = 2;

async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const task = async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        activeRequests--;
        drainQueue();
      }
    };

    requestQueue.push(task);
    drainQueue();
  });
}

function drainQueue() {
  while (activeRequests < MAX_CONCURRENT && requestQueue.length > 0) {
    const task = requestQueue.shift();
    if (task) {
      activeRequests++;
      task();
    }
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiPost<T>(endpoint: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authState.accessToken) {
    headers['Authorization'] = `Bearer ${authState.accessToken}`;
  }

  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<T>;
}

async function apiGet<T>(endpoint: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (authState.accessToken) {
    headers['Authorization'] = `Bearer ${authState.accessToken}`;
  }

  const response = await fetch(`${BACKEND_URL}${endpoint}`, { headers });
  if (!response.ok) throw new Error(`API error ${response.status}`);
  return response.json() as Promise<T>;
}

async function apiDelete(endpoint: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (authState.accessToken) {
    headers['Authorization'] = `Bearer ${authState.accessToken}`;
  }
  await fetch(`${BACKEND_URL}${endpoint}`, { method: 'DELETE', headers });
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtMessage, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => {
        console.error('[Inpromptu SW] Error handling message:', err);
        sendResponse({ type: 'ERROR', payload: { message: err?.message ?? 'Unknown error' } });
      });

    return true; // keep channel open for async response
  }
);

async function handleMessage(message: ExtMessage): Promise<unknown> {
  switch (message.type) {
    // ── Auth ──────────────────────────────────────────────────────────────
    case 'GET_AUTH_STATE':
      return { type: 'AUTH_STATE_RESPONSE', payload: authState };

    case 'AUTH_STATE_CHANGE': {
      const newAuth = message.payload as AuthState;
      persistAuth(newAuth);
      return { type: 'AUTH_STATE_RESPONSE', payload: newAuth };
    }

    // ── Analysis ──────────────────────────────────────────────────────────
    case 'ANALYZE_REQUEST': {
      const payload = message.payload as AnalyzeRequestPayload;

      // Check cache first
      const cached = cacheGet(payload.promptHash);
      if (cached) {
        console.log('[Inpromptu SW] Cache hit for hash:', payload.promptHash);
        return { type: 'ANALYZE_RESPONSE', payload: cached };
      }

      // Get settings to check if analysis is enabled / privacy mode
      const settings = await getSettings();
      if (!settings.analysisEnabled) {
        return { type: 'ANALYZE_RESPONSE', payload: null };
      }

      const result = await enqueue(() =>
        apiPost<AnalysisResult>('/analyze', {
          text: payload.text,
          changedSpan: payload.changedSpan,
          sessionSummary: payload.sessionSummary,
          sessionContext: payload.sessionContext, // Phase C/B: conversation context
          projectId: payload.projectId ?? settings.activeProjectId,
          privacyMode: settings.privacyMode,
        })
      );

      cacheSet(payload.promptHash, result);
      return { type: 'ANALYZE_RESPONSE', payload: result };
    }

    // ── Phase C: Scan Chat (DOM conversation → summary) ───────────────────────
    case 'SCAN_CONTEXT_REQUEST': {
      const payload = message.payload as ScanContextRequestPayload;
      try {
        const result = await apiPost<ScanContextResponse>('/context/scan', payload);
        return { type: 'SCAN_CONTEXT_RESPONSE', payload: result };
      } catch (err) {
        return {
          type: 'SCAN_CONTEXT_RESPONSE',
          payload: { error: (err as Error).message, summary: '', messageCount: 0 },
        };
      }
    }

    // ── Phase B: Track Prompt (submit hook → incremental update) ─────────────
    case 'TRACK_PROMPT_REQUEST': {
      const payload = message.payload as TrackPromptRequestPayload;
      try {
        const result = await apiPost<TrackPromptResponse>('/context/update', {
          newPrompts: [payload.prompt],
          currentSummary: payload.currentSummary,
          promptCount: payload.promptCount,
          sessionId: payload.sessionId,
        });
        return { type: 'TRACK_PROMPT_RESPONSE', payload: result };
      } catch {
        // Non-critical — return unchanged summary
        return {
          type: 'TRACK_PROMPT_RESPONSE',
          payload: { summary: payload.currentSummary, promptCount: payload.promptCount + 1 },
        };
      }
    }

    // ── Improve full prompt ───────────────────────────────────────────────
    case 'IMPROVE_FULL_REQUEST': {
      const payload = message.payload as ImproveFullRequestPayload;
      const result = await enqueue(() =>
        apiPost<ImproveFullResponse>('/improve-full', payload)
      );
      return { type: 'IMPROVE_FULL_RESPONSE', payload: result };
    }

    // ── Refine suggestion (grammar integration) ───────────────────────────
    case 'REFINE_REQUEST': {
      const payload = message.payload as RefineRequestPayload;
      try {
        const result = await apiPost<RefineResponse>('/refine', payload);
        return { type: 'REFINE_RESPONSE', payload: result };
      } catch {
        // Always fall back to original suggestion — refine is non-critical
        return { type: 'REFINE_RESPONSE', payload: { refinedSuggestion: payload.suggestion } };
      }
    }

    // ── Memory CRUD ───────────────────────────────────────────────────────
    case 'GET_MEMORIES': {
      const memories = await apiGet('/memory');
      return { type: 'MEMORIES_RESPONSE', payload: memories };
    }

    case 'DELETE_MEMORY': {
      const { id } = message.payload as { id: string };
      await apiDelete(`/memory/${id}`);
      return { type: 'MEMORIES_RESPONSE', payload: { deleted: id } };
    }

    case 'UPDATE_MEMORY': {
      const mem = message.payload as { id: string; content: string };
      const updated = await apiPost(`/memory/${mem.id}`, { content: mem.content });
      return { type: 'MEMORIES_RESPONSE', payload: updated };
    }

    // ── Feedback ──────────────────────────────────────────────────────────
    case 'FEEDBACK': {
      const payload = message.payload as FeedbackPayload;
      await apiPost('/feedback', payload).catch(() => {
        // Feedback is non-critical; swallow errors silently
      });
      return { type: 'FEEDBACK', payload: { ok: true } };
    }

    default:
      return { type: 'ERROR', payload: { message: `Unknown message type: ${message.type}` } };
  }
}

// ─── Settings helper ──────────────────────────────────────────────────────────

async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...(result.settings ?? {}) });
    });
  });
}

// ─── Install / startup ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    console.log('[Inpromptu] Extension installed.');
  }
});

console.log('[Inpromptu] Service worker started.');
