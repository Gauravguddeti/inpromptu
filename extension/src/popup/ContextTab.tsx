/**
 * ContextTab — Popup tab for managing conversation context.
 *
 * Architecture (fixed):
 *  - Popup → chrome.tabs.sendMessage → content script: "read me the DOM messages"
 *  - Popup → chrome.runtime.sendMessage → service worker: "summarize these messages"
 *  - Two separate round trips, each simple and reliable.
 *
 * This avoids the fragile async double-hop that caused "Could not reach the page".
 */

import React, { useState, useEffect, useCallback } from 'react';
import { SessionContext, ConversationMessage } from '../types';

interface Props {
  isOnSupportedSite?: boolean;
}

type ScanState = 'idle' | 'scanning' | 'success' | 'error' | 'no-conversation';

// ─── Page-context functions (run via chrome.scripting.executeScript) ──────────
// These run directly in the tab's page, NOT in the extension context.
// Rules: no imports, no closures over external variables, must be serializable.

/** Scrapes conversation messages — 7-strategy waterfall, first non-empty result wins */
function scrapeConversationMessages(maxMessages: number): Array<{ role: 'user' | 'assistant'; content: string }> {
  type Msg = { role: 'user' | 'assistant'; content: string };

  function ex(el: Element): string {
    const b = el.querySelectorAll('p,li,pre,h1,h2,h3,h4');
    if (b.length) return Array.from(b).map(x => x.textContent?.trim() ?? '').filter(Boolean).join(' ').slice(0, 600);
    return (el.textContent ?? '').trim().slice(0, 600);
  }

  function byPos(a: Element, b: Element): number {
    return a.compareDocumentPosition(b) & 4 ? -1 : 1;
  }

  function sortExtract(human: Element[], ai: Element[]): Msg[] | null {
    const t = [
      ...human.map(el => ({ el, role: 'user' as const })),
      ...ai.map(el => ({ el, role: 'assistant' as const })),
    ].sort((a, b) => byPos(a.el, b.el));
    const r: Msg[] = [];
    for (const { el, role } of t) { const c = ex(el); if (c) r.push({ role, content: c }); }
    return r.length ? r : null;
  }

  // ── 1. data-message-author-role (ChatGPT + some Claude) ────────────────────
  const roleEls = Array.from(document.querySelectorAll('[data-message-author-role]'));
  if (roleEls.length) {
    const top = roleEls.filter(el => !el.parentElement?.closest('[data-message-author-role]'));
    const msgs: Msg[] = [];
    for (const el of top) {
      const r = el.getAttribute('data-message-author-role') ?? '';
      let role: 'user' | 'assistant';
      if (r === 'human' || r === 'user') role = 'user';
      else if (r === 'assistant') role = 'assistant';
      else continue;
      const c = ex(el); if (c) msgs.push({ role, content: c });
    }
    if (msgs.length) return msgs.slice(-maxMessages);
  }

  // ── 2. ChatGPT article-based ────────────────────────────────────────────────
  const arts = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
  if (arts.length) {
    const msgs: Msg[] = [];
    for (const a of arts) {
      const re = a.querySelector('[data-message-author-role]');
      const ra = re?.getAttribute('data-message-author-role') ?? '';
      const ti = a.getAttribute('data-testid') ?? '';
      let role: 'user' | 'assistant';
      if (ra === 'user' || ti.includes('user')) role = 'user';
      else if (ra === 'assistant' || ti.includes('assistant')) role = 'assistant';
      else continue;
      const c = ex(a); if (c) msgs.push({ role, content: c });
    }
    if (msgs.length) return msgs.slice(-maxMessages);
  }

  // ── 3. Gemini user-query / model-response ───────────────────────────────────
  const uq = Array.from(document.querySelectorAll('user-query'));
  const mr = Array.from(document.querySelectorAll('model-response'));
  if (uq.length || mr.length) {
    const all = [...uq, ...mr].sort(byPos);
    const msgs: Msg[] = [];
    for (const el of all) {
      const c = ex(el);
      if (c) msgs.push({ role: el.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant', content: c });
    }
    if (msgs.length) return msgs.slice(-maxMessages);
  }


  // ── 4. Claude: full history from largest scrollable container ───────────────
  const hn = location.hostname;
  if (hn.includes('claude') || hn.includes('anthropic')) {
    const scrollDivs = Array.from(document.querySelectorAll('div,main'))
      .filter(el => {
        const s = getComputedStyle(el as HTMLElement);
        const r = (el as HTMLElement).getBoundingClientRect();
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
               r.height > 300 && r.width > 300 && (el.textContent?.length ?? 0) > 500;
      })
      .sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0));
    const container = scrollDivs[0] as HTMLElement | undefined;
    if (container) {
      let blocks = Array.from(container.querySelectorAll(':scope > div'))
        .filter(el => (el.textContent ?? '').trim().length > 20 && (el as HTMLElement).offsetHeight > 0) as HTMLElement[];
      if (blocks.length < 2) {
        blocks = Array.from(container.querySelectorAll(':scope > div > div'))
          .filter(el => (el.textContent ?? '').trim().length > 20 && (el as HTMLElement).offsetHeight > 0) as HTMLElement[];
      }
      if (blocks.length >= 2) {
        const msgs: Msg[] = [];
        for (let i = 0; i < blocks.length; i++) {
          const el = blocks[i];
          const text = ex(el);
          if (!text) continue;
          const hasCode = el.querySelector('pre,code') !== null;
          const hasList = el.querySelector('ol,ul') !== null;
          const isLong  = text.length > 250;
          const alt: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
          const role: 'user' | 'assistant' =
            (hasCode || hasList || isLong) && alt === 'assistant' ? 'assistant' :
            !(hasCode || hasList || isLong) && alt === 'user' ? 'user' : alt;
          msgs.push({ role, content: text });
        }
        if (msgs.length) return msgs.slice(-maxMessages);
      }
    }
  }

  // ── 5. data-testid turn wrappers ────────────────────────────────────────────
  const hts = Array.from(document.querySelectorAll('[data-testid="human-turn"],[data-testid="human-turn-content"],[data-testid*="human"]'));
  const ats = Array.from(document.querySelectorAll('[data-testid="ai-turn"],[data-testid="ai-turn-content"],[data-testid*="assistant"]'));
  if (hts.length || ats.length) { const r = sortExtract(hts, ats); if (r) return r.slice(-maxMessages); }

  // ── 6. Class-name patterns ───────────────────────────────────────────────────
  const hcs = Array.from(document.querySelectorAll('.human-turn,[class*="HumanTurn"],[class*="UserMessage"],[class*="user-message"]'));
  const acs = Array.from(document.querySelectorAll('.claude-message,[class*="AssistantTurn"],[class*="AIMessage"],[class*="BotMessage"]'));
  if (hcs.length || acs.length) { const r = sortExtract(hcs, acs); if (r) return r.slice(-maxMessages); }

  // ── 7. Generic alternating fallback ──────────────────────────────────────────
  const main = document.querySelector('main,[role="main"],[class*="conversation"],[class*="chat-content"]') as HTMLElement | null;
  if (main) {
    const kids = Array.from(main.querySelectorAll(':scope > div'))
      .filter(el => (el.textContent ?? '').trim().length > 30 && (el as HTMLElement).getBoundingClientRect().height > 0) as HTMLElement[];
    if (kids.length >= 2) {
      const msgs: Msg[] = [];
      kids.forEach((el, i) => { const c = ex(el); if (c) msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: c }); });
      if (msgs.length) return msgs.slice(-maxMessages);
    }
  }

  return [];
}




/** Reads the session context object from localStorage */
function readContextFromLocalStorage(): { summary: string; promptCount: number; lastUpdatedAt: number; sourceUrl: string; scannedMessageCount: number } | null {
  try {
    const key = `pc_session_ctx_${location.hostname}`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Writes a new session context to localStorage */
function storeContextInLocalStorage(summary: string, scannedMessageCount: number, sourceUrl: string): void {
  try {
    const key = `pc_session_ctx_${location.hostname}`;
    const ctx = { summary, promptCount: 0, lastUpdatedAt: Date.now(), sourceUrl, scannedMessageCount };
    localStorage.setItem(key, JSON.stringify(ctx));
  } catch { /* quota exceeded — ignore */ }
}

/** Clears the session context from localStorage */
function clearContextInLocalStorage(): void {
  try {
    localStorage.removeItem(`pc_session_ctx_${location.hostname}`);
  } catch { /* ignore */ }
}

export function ContextTab({ isOnSupportedSite: _ }: Props) {
  const [sessionCtx, setSessionCtx] = useState<SessionContext | null>(null);
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // ── Load context from localStorage via executeScript ─────────────────────
  const loadContext = useCallback(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return;
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: readContextFromLocalStorage,
          args: [],
        },
        (results) => {
          if (chrome.runtime.lastError) return;
          setSessionCtx(results?.[0]?.result ?? null);
        }
      );
    });
  }, []);

  useEffect(() => {
    loadContext();
    const timer = setInterval(loadContext, 5000);
    return () => clearInterval(timer);
  }, [loadContext]);

  // ── Phase C: Scan Chat — uses executeScript (always fresh, bypasses stale content script)
  const handleScan = () => {
    setScanState('scanning');
    setErrorMsg('');

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        setScanState('error');
        setErrorMsg('No active tab found.');
        return;
      }

      // ── Step 1: Read DOM directly with executeScript ──────────────────────
      // This always runs fresh, regardless of whether content script is stale.
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: scrapeConversationMessages,
          args: [20],
        },
        (results) => {
          if (chrome.runtime.lastError) {
            setScanState('error');
            setErrorMsg(
              `Could not access the page: ${chrome.runtime.lastError.message}. ` +
              'Make sure you are on ChatGPT, Claude, or Gemini.'
            );
            return;
          }

          const messages: ConversationMessage[] = results?.[0]?.result ?? [];

          if (!messages.length) {
            setScanState('no-conversation');
            setErrorMsg(
              'No conversation messages found. Start a chat first, then scan.'
            );
            return;
          }

          // ── Step 2: Send to service worker → /context/scan ───────────────
          chrome.runtime.sendMessage(
            {
              type: 'SCAN_CONTEXT_REQUEST',
              payload: { messages, sourceUrl: tab.url ?? '' },
            },
            (swResp) => {
              if (chrome.runtime.lastError || !swResp?.payload?.summary) {
                setScanState('error');
                setErrorMsg('Summarization failed. Check if the backend is running (inpromptu-backend.onrender.com).');
                return;
              }

              const { summary, messageCount } = swResp.payload;

              // ── Step 3: Persist to localStorage via executeScript ──────────
              chrome.scripting.executeScript({
                target: { tabId: tab.id! },
                func: storeContextInLocalStorage,
                args: [summary, messageCount ?? messages.length, tab.url ?? ''],
              });

              setScanState('success');
              // Reload context display
              setTimeout(() => {
                chrome.scripting.executeScript(
                  {
                    target: { tabId: tab.id! },
                    func: readContextFromLocalStorage,
                    args: [],
                  },
                  (r) => {
                    if (!chrome.runtime.lastError && r?.[0]?.result) {
                      setSessionCtx(r[0].result);
                    }
                  }
                );
              }, 400);
            }
          );
        }
      );
    });
  };

  // ── Clear context ─────────────────────────────────────────────────────────
  const handleClear = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return;
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: clearContextInLocalStorage,
          args: [],
        },
        () => {
          setSessionCtx(null);
          setScanState('idle');
        }
      );
    });
  };

  const relativeTime = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerIcon}>🗪</span>
        <div>
          <div style={styles.headerTitle}>Conversation Context</div>
          <div style={styles.headerSub}>
            Help PromptCoach understand what you&apos;ve been discussing
          </div>
        </div>
      </div>

      {/* Context card */}
      {sessionCtx ? (
        <div style={styles.contextCard}>
          <div style={styles.contextCardHeader}>
            <span style={styles.contextBadge}>✓ Active</span>
            <span style={styles.contextMeta}>
              {relativeTime(sessionCtx.lastUpdatedAt)}
              {sessionCtx.promptCount > 0 && ` · ${sessionCtx.promptCount} prompts tracked`}
            </span>
          </div>
          <p style={styles.contextSummary}>{sessionCtx.summary}</p>
          <div style={styles.contextFooter}>
            <span style={styles.contextSite}>
              {sessionCtx.sourceUrl.replace(/^https?:\/\//, '').split('/')[0]}
            </span>
            <button style={styles.clearBtn} onClick={handleClear}>
              Clear
            </button>
          </div>
        </div>
      ) : (
        <div style={styles.emptyCard}>
          <div style={styles.emptyIcon}>💬</div>
          <div style={styles.emptyTitle}>No context set</div>
          <div style={styles.emptyDesc}>
            Scan the current conversation so PromptCoach can give suggestions that fit what
            you&apos;ve already discussed.
          </div>
        </div>
      )}

      {/* Scan button */}
      <button
        id="btn-scan-chat"
        style={{
          ...styles.scanBtn,
          ...(scanState === 'scanning' ? styles.scanBtnLoading : {}),
        }}
        onClick={handleScan}
        disabled={scanState === 'scanning'}
      >
        {scanState === 'scanning' ? (
          <>
            <span style={styles.spinner} /> Scanning…
          </>
        ) : sessionCtx ? (
          '🔄 Re-scan Conversation'
        ) : (
          '📸 Scan Chat'
        )}
      </button>

      {/* Status messages */}
      {scanState === 'success' && (
        <div style={styles.successMsg}>
          ✓ Context captured! Suggestions will now reflect your conversation.
        </div>
      )}
      {(scanState === 'error' || scanState === 'no-conversation') && errorMsg && (
        <div style={styles.errorMsg}>{errorMsg}</div>
      )}

      {/* Phase B info */}
      <div style={styles.infoBox}>
        <span style={styles.infoIcon}>⚡</span>
        <span style={styles.infoText}>
          After scanning, context auto-updates as you send new prompts.
          {sessionCtx?.promptCount ? ` ${sessionCtx.promptCount} prompts tracked.` : ''}
        </span>
      </div>

      {/* Supported sites */}
      <div style={styles.sitesSection}>
        <div style={styles.sitesTitle}>Works on</div>
        <div style={styles.sitesList}>
          {['ChatGPT', 'Claude', 'Gemini', 'Perplexity'].map((s) => (
            <span key={s} style={styles.siteBadge}>
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' },
  header: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  headerIcon: { fontSize: '22px', marginTop: '2px' },
  headerTitle: { fontSize: '13px', fontWeight: 700, color: 'rgba(255,255,255,0.9)' },
  headerSub: { fontSize: '11px', color: 'rgba(255,255,255,0.45)', marginTop: '2px', lineHeight: '1.4' },
  contextCard: {
    background: 'rgba(99,102,241,0.1)',
    border: '1px solid rgba(99,102,241,0.25)',
    borderRadius: '8px',
    padding: '10px 12px',
  },
  contextCardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' },
  contextBadge: { fontSize: '10px', fontWeight: 700, color: '#a5b4fc', textTransform: 'uppercase', letterSpacing: '0.05em' },
  contextMeta: { fontSize: '10px', color: 'rgba(255,255,255,0.35)' },
  contextSummary: { fontSize: '11.5px', color: 'rgba(255,255,255,0.75)', lineHeight: '1.55', margin: '0 0 8px 0' },
  contextFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  contextSite: { fontSize: '10px', color: 'rgba(255,255,255,0.3)' },
  clearBtn: { fontSize: '10px', color: 'rgba(239,68,68,0.7)', background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontFamily: 'inherit' },
  emptyCard: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px dashed rgba(255,255,255,0.1)',
    borderRadius: '8px',
    padding: '16px',
    textAlign: 'center',
  },
  emptyIcon: { fontSize: '24px', marginBottom: '6px' },
  emptyTitle: { fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.6)', marginBottom: '4px' },
  emptyDesc: { fontSize: '11px', color: 'rgba(255,255,255,0.35)', lineHeight: '1.5' },
  scanBtn: {
    width: '100%',
    padding: '10px',
    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    transition: 'opacity 0.15s',
  },
  scanBtnLoading: { opacity: 0.65, cursor: 'not-allowed' },
  spinner: {
    display: 'inline-block',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: 'white',
    animation: 'pc-spin 0.7s linear infinite',
  },
  successMsg: { fontSize: '11px', color: '#4ade80', background: 'rgba(74,222,128,0.08)', borderRadius: '6px', padding: '8px 10px', border: '1px solid rgba(74,222,128,0.15)' },
  errorMsg: { fontSize: '11px', color: '#f87171', background: 'rgba(248,113,113,0.08)', borderRadius: '6px', padding: '8px 10px', border: '1px solid rgba(248,113,113,0.15)' },
  infoBox: { display: 'flex', gap: '8px', alignItems: 'flex-start', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', padding: '8px 10px' },
  infoIcon: { fontSize: '12px', marginTop: '1px', flexShrink: 0 },
  infoText: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', lineHeight: '1.5' },
  sitesSection: { display: 'flex', alignItems: 'center', gap: '8px' },
  sitesTitle: { fontSize: '10px', color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap' },
  sitesList: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
  siteBadge: { fontSize: '10px', color: 'rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', padding: '2px 6px' },
};
