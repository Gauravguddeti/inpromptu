/**
 * Adapter Registry
 * ─────────────────
 * Detects the current site and returns the appropriate adapter.
 * Add new adapters here — the rest of the extension doesn't change.
 */

import { SiteAdapter } from './types';
import { ChatGPTAdapter } from './chatgpt';
import { ClaudeAdapter } from './claude';
import { GenericAdapter } from './generic';

const SITE_MAP: Array<{ match: (url: string) => boolean; Adapter: new () => SiteAdapter }> = [
  {
    match: (url) => /chatgpt\.com|chat\.openai\.com/.test(url),
    Adapter: ChatGPTAdapter,
  },
  {
    match: (url) => /claude\.ai/.test(url),
    Adapter: ClaudeAdapter,
  },
  // Gemini adapter — Phase 3 (different editor architecture)
  // {
  //   match: (url) => /gemini\\.google\.com/.test(url),
  //   Adapter: GeminiAdapter,
  // },
];

let activeAdapter: SiteAdapter | null = null;

export function detectAdapter(): SiteAdapter | null {
  const url = window.location.href;

  // Destroy previous adapter if switching sites (shouldn't happen normally)
  if (activeAdapter) {
    activeAdapter.destroy();
    activeAdapter = null;
  }

  for (const { match, Adapter } of SITE_MAP) {
    if (match(url)) {
      const adapter = new Adapter();
      if (adapter.getEditorElement()) {
        activeAdapter = adapter;
        return adapter;
      }
      // Editor not mounted yet — return the adapter anyway and let the
      // MutationObserver in index.ts retry
      activeAdapter = adapter;
      return adapter;
    }
  }

  // Fall back to generic adapter
  const generic = new GenericAdapter();
  activeAdapter = generic;
  return generic;
}

export * from './types';
