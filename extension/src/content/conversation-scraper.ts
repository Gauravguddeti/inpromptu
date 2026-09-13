/**
 * Multi-site conversation scraper — v4
 *
 * Waterfall (first non-empty wins):
 *  1. data-message-author-role       → ChatGPT
 *  2. article[data-testid]           → ChatGPT classic
 *  3. user-query / model-response    → Gemini
 *  4. Largest scrollable container   → Claude + any site (full history)
 *  5. data-testid turn wrappers      → Claude alt
 *  6. Class-name patterns            → Perplexity / older Claude
 *  7. main > div alternating         → Generic fallback
 */

import { ConversationMessage } from '../types';

export function scrapeConversationMessages(maxMessages = 40): ConversationMessage[] {
  const result =
    tryByRoleAttr()        ??
    tryByChatGPTArticles() ??
    tryByGemini()          ??
    tryByScrollContainer() ??   // ← key Claude fix: grabs FULL history
    tryByTestIds()         ??
    tryByClassPatterns()   ??
    tryByStructure();

  return (result ?? []).slice(-maxMessages);
}

// ─── 1. data-message-author-role (ChatGPT "user"/"assistant") ─────────────────

function tryByRoleAttr(): ConversationMessage[] | null {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>('[data-message-author-role]')
  );
  if (!all.length) return null;

  const top = all.filter(
    (el) => !el.parentElement?.closest('[data-message-author-role]')
  );
  if (!top.length) return null;

  const out: ConversationMessage[] = [];
  for (const el of top) {
    const raw = el.getAttribute('data-message-author-role') ?? '';
    let role: 'user' | 'assistant';
    if (raw === 'human' || raw === 'user') role = 'user';
    else if (raw === 'assistant') role = 'assistant';
    else continue;
    const content = extractText(el);
    if (content) out.push({ role, content });
  }
  return out.length ? out : null;
}

// ─── 2. ChatGPT article-based ─────────────────────────────────────────────────

function tryByChatGPTArticles(): ConversationMessage[] | null {
  const arts = Array.from(
    document.querySelectorAll<HTMLElement>('article[data-testid^="conversation-turn"]')
  );
  if (!arts.length) return null;

  const out: ConversationMessage[] = [];
  for (const art of arts) {
    const roleEl = art.querySelector<HTMLElement>('[data-message-author-role]');
    const roleAttr = roleEl?.getAttribute('data-message-author-role') ?? '';
    const testId = art.getAttribute('data-testid') ?? '';
    let role: 'user' | 'assistant';
    if (roleAttr === 'user' || testId.includes('user')) role = 'user';
    else if (roleAttr === 'assistant' || testId.includes('assistant')) role = 'assistant';
    else continue;
    const content = extractText(art);
    if (content) out.push({ role, content });
  }
  return out.length ? out : null;
}

// ─── 3. Gemini custom elements ────────────────────────────────────────────────

function tryByGemini(): ConversationMessage[] | null {
  const uq = Array.from(document.querySelectorAll('user-query'));
  const mr = Array.from(document.querySelectorAll('model-response'));
  if (!uq.length && !mr.length) return null;

  const sorted = [...uq, ...mr].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  const out: ConversationMessage[] = [];
  for (const el of sorted) {
    const isUser = el.tagName.toLowerCase() === 'user-query';
    const content = extractText(el as HTMLElement);
    if (content) out.push({ role: isUser ? 'user' : 'assistant', content });
  }
  return out.length ? out : null;
}

// ─── 4. Scrollable conversation container (Claude FULL history) ───────────────
//
// Claude does not use stable data-* attributes for message turns.
// Instead we find the LARGEST scrollable div on the page — this is the
// conversation container — then examine its direct-child blocks in order.
//
// Role classification for Claude:
//  - Short blocks (< 250 chars) that lack code/lists → likely user
//  - Long blocks OR blocks with code/lists → likely AI
//  - Alternating is also a useful heuristic as a tie-breaker

function tryByScrollContainer(): ConversationMessage[] | null {
  // Only activate on Claude (or similar sites without known selectors)
  const hostname = location.hostname;
  const isLikelyClaude =
    hostname.includes('claude') ||
    hostname.includes('anthropic');

  if (!isLikelyClaude) return null;

  // Find the largest scrollable container
  const container = findMainScrollContainer();
  if (!container) return null;

  // Get direct children with meaningful content
  // Use querySelectorAll with :scope > * to get only direct children
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>(':scope > div, :scope > article, :scope > section')
  ).filter((el) => {
    const text = (el.textContent ?? '').trim();
    const rect = el.getBoundingClientRect();
    return text.length > 20 && (rect.height > 0 || el.offsetHeight > 0);
  });

  if (blocks.length < 2) {
    // Try one level deeper if direct children are wrappers
    const inner = Array.from(
      container.querySelectorAll<HTMLElement>(':scope > div > div')
    ).filter((el) => {
      const text = (el.textContent ?? '').trim();
      return text.length > 20 && el.offsetHeight > 0;
    });
    if (inner.length >= 2) {
      return classifyClaudeBlocks(inner);
    }
    return null;
  }

  return classifyClaudeBlocks(blocks);
}

/**
 * Classify a list of block elements from Claude's conversation container.
 * Uses content heuristics + alternating pattern for role assignment.
 */
function classifyClaudeBlocks(blocks: HTMLElement[]): ConversationMessage[] | null {
  const out: ConversationMessage[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i];
    const text = extractText(el);
    if (!text) continue;

    // Heuristic: presence of code blocks, numbered lists, or >250 chars → AI
    const hasCode  = el.querySelector('pre, code') !== null;
    const hasList  = el.querySelector('ol, ul') !== null;
    const isLong   = text.length > 250;
    const looksLikeAI = hasCode || hasList || isLong;

    // Alternating position is a strong signal too
    // Even index (0, 2, 4...) is typically user; odd is AI
    const alternatingRole: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';

    let role: 'user' | 'assistant';
    if (looksLikeAI && alternatingRole === 'assistant') {
      role = 'assistant'; // Both heuristics agree
    } else if (!looksLikeAI && alternatingRole === 'user') {
      role = 'user'; // Both heuristics agree
    } else {
      role = alternatingRole; // Fall back to positional
    }

    out.push({ role, content: text });
  }

  return out.length >= 2 ? out : null;
}

/** Find the main conversation scrollable container on the page */
function findMainScrollContainer(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('div, main, section'))
    .filter((el) => {
      const style = getComputedStyle(el);
      const rect  = el.getBoundingClientRect();
      const overflowY = style.overflowY;
      return (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        rect.height > 300 &&
        rect.width  > 300 &&
        (el.textContent?.length ?? 0) > 500
      );
    });

  if (!all.length) return null;

  // Pick the one with the most text content (= the conversation, not a sidebar)
  return all.reduce((best, el) =>
    (el.textContent?.length ?? 0) > (best.textContent?.length ?? 0) ? el : best
  );
}

// ─── 5. data-testid turn wrappers ─────────────────────────────────────────────

function tryByTestIds(): ConversationMessage[] | null {
  const humanSel = [
    '[data-testid="human-turn"]',
    '[data-testid="human-turn-content"]',
    '[data-testid*="human"]',
  ].join(',');
  const aiSel = [
    '[data-testid="ai-turn"]',
    '[data-testid="ai-turn-content"]',
    '[data-testid*="assistant"]',
  ].join(',');

  const humanEls = Array.from(document.querySelectorAll<HTMLElement>(humanSel));
  const aiEls    = Array.from(document.querySelectorAll<HTMLElement>(aiSel));
  if (!humanEls.length && !aiEls.length) return null;

  return sortAndExtract(humanEls, aiEls);
}

// ─── 6. Class-name patterns ───────────────────────────────────────────────────

function tryByClassPatterns(): ConversationMessage[] | null {
  const humanSel = [
    '.human-turn',
    '[class*="HumanTurn"]',
    '[class*="human_turn"]',
    '[class*="UserMessage"]',
    '[class*="user-message"]',
  ].join(',');
  const aiSel = [
    '.claude-message',
    '[class*="AssistantTurn"]',
    '[class*="AIMessage"]',
    '[class*="ai-message"]',
    '[class*="BotMessage"]',
  ].join(',');

  const humanEls = Array.from(document.querySelectorAll<HTMLElement>(humanSel));
  const aiEls    = Array.from(document.querySelectorAll<HTMLElement>(aiSel));
  if (!humanEls.length && !aiEls.length) return null;

  return sortAndExtract(humanEls, aiEls);
}

// ─── 7. Generic structural fallback ──────────────────────────────────────────

function tryByStructure(): ConversationMessage[] | null {
  const container =
    document.querySelector<HTMLElement>('main') ||
    document.querySelector<HTMLElement>('[role="main"]') ||
    document.querySelector<HTMLElement>('[class*="conversation"]') ||
    document.querySelector<HTMLElement>('[class*="chat-content"]') ||
    document.querySelector<HTMLElement>('[class*="thread"]');

  if (!container) return null;

  const kids = Array.from(
    container.querySelectorAll<HTMLElement>(':scope > div')
  ).filter((el) => {
    const text = (el.textContent ?? '').trim();
    return text.length > 30 && el.getBoundingClientRect().height > 0;
  });

  if (kids.length < 2) return null;

  const out: ConversationMessage[] = [];
  kids.forEach((el, i) => {
    const content = extractText(el);
    if (content) out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content });
  });

  return out.length ? out : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sortAndExtract(
  humanEls: HTMLElement[],
  aiEls: HTMLElement[]
): ConversationMessage[] | null {
  type Tagged = { el: HTMLElement; role: 'user' | 'assistant' };
  const tagged: Tagged[] = [
    ...humanEls.map((el) => ({ el, role: 'user' as const })),
    ...aiEls.map((el) => ({ el, role: 'assistant' as const })),
  ].sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );

  const out: ConversationMessage[] = [];
  for (const { el, role } of tagged) {
    const content = extractText(el);
    if (content) out.push({ role, content });
  }
  return out.length ? out : null;
}

export function extractText(el: HTMLElement): string {
  const blocks = el.querySelectorAll('p, li, pre, h1, h2, h3, h4');
  if (blocks.length) {
    return Array.from(blocks)
      .map((b) => b.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .slice(0, 500); // 500 chars per message, balanced with more messages
  }
  return (el.textContent ?? '').trim().slice(0, 500);
}
