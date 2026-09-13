/**
 * ChatGPT Site Adapter (Case B — ProseMirror/contenteditable)
 * ─────────────────────────────────────────────────────────────
 * ChatGPT uses a ProseMirror contenteditable editor.
 * This adapter uses TreeWalker to build a flat text→DOM offset map
 * and the Range/Selection API for replacements.
 *
 * Selector: div[contenteditable="true"][data-virtualkeyboard-content]
 * or the #prompt-textarea element (depending on ChatGPT version).
 *
 * If ChatGPT updates its UI and these selectors break, only this file
 * needs to change — the rest of the extension stays intact.
 */

import { SiteAdapter, OffsetMapEntry } from './types';
import { ConversationMessage } from '../types';


// Known selectors for ChatGPT's editor (try in order — newer UI first)
const EDITOR_SELECTORS = [
  '#prompt-textarea',                                         // Classic ChatGPT
  'div[contenteditable="true"][class*="ProseMirror"]',        // Newer ProseMirror variant
  'div[contenteditable="true"][data-virtualkeyboard-content]',// Mobile/keyboard variant
  'div.ProseMirror[contenteditable="true"]',                  // Strict ProseMirror class
  '[data-testid="composer-speech-button"] ~ div[contenteditable="true"]', // Sibling of speech btn
  'div[contenteditable="true"]',                              // Broad fallback
];

export class ChatGPTAdapter implements SiteAdapter {
  readonly name = 'ChatGPT';

  private editor: HTMLElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private textChangeCallbacks: Array<(text: string) => void> = [];
  private submitCallbacks: Array<(text: string) => void> = [];
  private submitListener: ((e: Event) => void) | null = null;

  getEditorElement(): HTMLElement | null {
    if (this.editor && document.contains(this.editor)) {
      return this.editor;
    }

    for (const selector of EDITOR_SELECTORS) {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        this.editor = el;
        this.attachObserver();
        return el;
      }
    }

    return null;
  }

  getText(): string {
    const el = this.getEditorElement();
    if (!el) return '';
    return el.innerText ?? el.textContent ?? '';
  }

  getOffsetMap(): OffsetMapEntry[] {
    const el = this.getEditorElement();
    if (!el) return [];
    return buildOffsetMap(el);
  }

  replaceRange(start: number, end: number, replacement: string): void {
    const el = this.getEditorElement();
    if (!el) return;

    const map = buildOffsetMap(el);
    const range = offsetsToRange(map, start, end);
    if (!range) return;

    range.deleteContents();
    range.insertNode(document.createTextNode(replacement));

    // Collapse selection to end of inserted text
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      const newRange = document.createRange();
      newRange.setStart(range.startContainer, range.startOffset + replacement.length);
      newRange.collapse(true);
      sel.addRange(newRange);
    }

    // Dispatch input event so ChatGPT's React state updates
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }

  setText(text: string): void {
    const el = this.getEditorElement();
    if (!el) return;
    // Clear all content, then insert new text as a single text node
    el.textContent = text;
    // Place cursor at end
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }

  onTextChange(callback: (text: string) => void): void {
    this.textChangeCallbacks.push(callback);
    if (!this.mutationObserver) {
      this.getEditorElement();
    }
  }

  // ── Phase C: Conversation history from DOM ────────────────────────────────

  getConversationHistory(maxMessages = 10): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    // ChatGPT renders each turn as an article[data-testid="conversation-turn-*"]
    const turns = document.querySelectorAll(
      'article[data-testid^="conversation-turn"], [data-message-author-role]'
    );

    if (!turns.length) {
      // Fallback: try the main thread container
      const thread = document.querySelector('main [class*="react-scroll"]');
      if (!thread) return [];
    }

    turns.forEach((turn) => {
      const role = turn.getAttribute('data-message-author-role') ??
        (turn.getAttribute('data-testid')?.includes('user') ? 'user' : 'assistant');

      const contentEl = turn.querySelector(
        '[class*="markdown"], [data-message-content], .whitespace-pre-wrap, p'
      );
      const content = (contentEl?.textContent ?? turn.textContent ?? '').trim();

      if (content && (role === 'user' || role === 'assistant')) {
        messages.push({ role: role as 'user' | 'assistant', content: content.slice(0, 500) });
      }
    });

    // Return last N turns
    return messages.slice(-maxMessages);
  }

  // ── Phase B: Submit hook ────────────────────────────────────────────────

  onSubmit(callback: (promptText: string) => void): void {
    this.submitCallbacks.push(callback);
    if (this.submitListener) return; // already attached

    // Listen for Enter key on the editor (ChatGPT submits on Enter)
    this.submitListener = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' || ke.shiftKey) return;
      // Short delay so the text is still readable before the editor clears
      const text = this.getText().trim();
      if (!text) return;
      setTimeout(() => this.submitCallbacks.forEach((cb) => cb(text)), 50);
    };

    document.addEventListener('keydown', this.submitListener, { capture: true });

    // Also watch for Send button clicks
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const isSendBtn = target.closest('[data-testid="send-button"], button[aria-label*="Send"]');
      if (!isSendBtn) return;
      const text = this.getText().trim();
      if (!text) return;
      setTimeout(() => this.submitCallbacks.forEach((cb) => cb(text)), 50);
    }, { capture: true });
  }

  destroy(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.textChangeCallbacks = [];
    this.submitCallbacks = [];
    if (this.submitListener) {
      document.removeEventListener('keydown', this.submitListener, { capture: true });
      this.submitListener = null;
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private attachObserver(): void {
    if (this.mutationObserver || !this.editor) return;

    let lastText = '';

    this.mutationObserver = new MutationObserver(() => {
      const text = this.getText();
      if (text !== lastText) {
        lastText = text;
        this.textChangeCallbacks.forEach((cb) => cb(text));
      }
    });

    this.mutationObserver.observe(this.editor, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }
}

// ─── TreeWalker offset map builder ────────────────────────────────────────────

export function buildOffsetMap(root: HTMLElement): OffsetMapEntry[] {
  const map: OffsetMapEntry[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);

  let offset = 0;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const len = node.textContent?.length ?? 0;
    map.push({
      node,
      nodeStart: offset,
      nodeEnd: offset + len,
    });
    offset += len;

    // Account for block-level elements adding a newline to innerText
    const parent = node.parentElement;
    if (parent && isBlockElement(parent) && parent.lastChild === node) {
      offset += 1; // simulate the newline innerText adds
    }
  }

  return map;
}

function isBlockElement(el: Element): boolean {
  const display = window.getComputedStyle(el).display;
  return display === 'block' || display === 'flex' || display === 'grid';
}

// ─── Range reconstruction from character offsets ──────────────────────────────

export function offsetsToRange(
  map: OffsetMapEntry[],
  start: number,
  end: number
): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (const entry of map) {
    if (!startNode && entry.nodeEnd > start) {
      startNode = entry.node;
      startOffset = start - entry.nodeStart;
    }
    if (!endNode && entry.nodeEnd >= end) {
      endNode = entry.node;
      endOffset = end - entry.nodeStart;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, Math.min(startOffset, startNode.length));
  range.setEnd(endNode, Math.min(endOffset, endNode.length));
  return range;
}
