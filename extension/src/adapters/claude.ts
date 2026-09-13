/**
 * Claude.ai Site Adapter
 * ──────────────────────
 * Claude uses a ProseMirror contenteditable editor, very similar to ChatGPT.
 * This adapter tries multiple known selectors in order and falls back gracefully.
 *
 * Selector strategy (in priority order):
 *  1. div.ProseMirror[contenteditable="true"]  — most specific
 *  2. [data-testid="chat-input"] [contenteditable]
 *  3. .composer [contenteditable="true"]
 *  4. fieldset [contenteditable="true"]
 *  5. div[contenteditable="true"] (last resort — still scoped to visible viewport)
 */

import { SiteAdapter, OffsetMapEntry } from './types';
import { buildOffsetMap, offsetsToRange } from './chatgpt';
import { ConversationMessage } from '../types';


const EDITOR_SELECTORS = [
  'div.ProseMirror[contenteditable="true"]',
  '[data-testid="chat-input"] [contenteditable="true"]',
  '.composer [contenteditable="true"]',
  'fieldset [contenteditable="true"]',
  'div[contenteditable="true"][class*="ProseMirror"]',
  'div[contenteditable="true"]',
];

export class ClaudeAdapter implements SiteAdapter {
  readonly name = 'Claude';

  private editor: HTMLElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private textChangeCallbacks: Array<(text: string) => void> = [];
  private submitCallbacks: Array<(text: string) => void> = [];
  private submitListener: ((e: Event) => void) | null = null;


  // ─── Editor detection ──────────────────────────────────────────────────────

  getEditorElement(): HTMLElement | null {
    if (this.editor && document.contains(this.editor)) {
      return this.editor;
    }

    for (const selector of EDITOR_SELECTORS) {
      const candidates = document.querySelectorAll<HTMLElement>(selector);
      for (const el of candidates) {
        // Skip hidden/zero-size elements
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0 || el.textContent) {
          this.editor = el;
          this.attachObserver();
          return el;
        }
      }
    }

    return null;
  }

  // ─── Text extraction ───────────────────────────────────────────────────────

  getText(): string {
    const el = this.getEditorElement();
    if (!el) return '';
    // innerText preserves newlines between paragraphs; textContent collapses them
    return el.innerText ?? el.textContent ?? '';
  }

  // ─── Offset map ────────────────────────────────────────────────────────────

  getOffsetMap(): OffsetMapEntry[] {
    const el = this.getEditorElement();
    if (!el) return [];
    return buildOffsetMap(el);
  }

  // ─── Replace range ─────────────────────────────────────────────────────────

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

    // Dispatch input event so Claude's React state updates
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('keydown', { bubbles: true, cancelable: true }));
  }

  setText(text: string): void {
    const el = this.getEditorElement();
    if (!el) return;
    el.textContent = text;
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

  // ─── Change listener ───────────────────────────────────────────────────────

  onTextChange(callback: (text: string) => void): void {
    this.textChangeCallbacks.push(callback);
    if (!this.mutationObserver) {
      this.getEditorElement();
    }
  }

  // ── Phase C: Conversation history ─────────────────────────────────────────────

  getConversationHistory(maxMessages = 10): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    // Claude renders human turns with data-message-author-role="human"
    // and assistant turns with data-message-author-role="assistant"
    const turns = document.querySelectorAll(
      '[data-message-author-role], .human-turn, .claude-message, [class*="ConversationItem"]'
    );

    turns.forEach((turn) => {
      let role: 'user' | 'assistant' = 'user';
      const attr = turn.getAttribute('data-message-author-role');
      if (attr === 'assistant' || turn.classList.contains('claude-message')) {
        role = 'assistant';
      } else if (attr === 'human' || turn.classList.contains('human-turn')) {
        role = 'user';
      } else {
        return; // unknown role — skip
      }

      const content = (turn.textContent ?? '').trim().slice(0, 500);
      if (content) messages.push({ role, content });
    });

    return messages.slice(-maxMessages);
  }

  // ── Phase B: Submit hook ────────────────────────────────────────────────

  onSubmit(callback: (promptText: string) => void): void {
    this.submitCallbacks.push(callback);
    if (this.submitListener) return;

    // Claude submits on Enter (without Shift)
    this.submitListener = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter' || ke.shiftKey) return;
      const text = this.getText().trim();
      if (!text) return;
      setTimeout(() => this.submitCallbacks.forEach((cb) => cb(text)), 50);
    };
    document.addEventListener('keydown', this.submitListener, { capture: true });

    // Send button: [aria-label="Send Message"] or data-testid="send-button"
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[aria-label*="Send"], [data-testid*="send"]')) return;
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

  // ─── Private ───────────────────────────────────────────────────────────────

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
