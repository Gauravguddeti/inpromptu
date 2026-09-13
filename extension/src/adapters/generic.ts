/**
 * Generic TreeWalker Fallback Adapter
 * ─────────────────────────────────────
 * Handles:
 *  A) <textarea> / <input>  → mirrored-div technique for pixel offsets
 *  B) contenteditable        → TreeWalker + Range API (same as ChatGPT adapter)
 */

import { SiteAdapter, OffsetMapEntry } from './types';
import { buildOffsetMap, offsetsToRange } from './chatgpt';
import { ConversationMessage } from '../types';


export class GenericAdapter implements SiteAdapter {
  readonly name = 'Generic';

  private editor: HTMLElement | null = null;
  private mirror: HTMLElement | null = null;          // mirrored div for textarea
  private mutationObserver: MutationObserver | null = null;
  private inputHandler: (() => void) | null = null;
  private textChangeCallbacks: Array<(text: string) => void> = [];

  // ─── Editor detection ─────────────────────────────────────────────────────

  getEditorElement(): HTMLElement | null {
    if (this.editor && document.contains(this.editor)) return this.editor;

    // 1. Try focused element first
    const active = document.activeElement as HTMLElement | null;
    if (active && isEditableElement(active)) {
      this.editor = active;
      this.attachObserver();
      return active;
    }

    // 2. Prefer contenteditable over textarea (better overlay support)
    const ce = document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (ce) {
      this.editor = ce;
      this.attachObserver();
      return ce;
    }

    // 3. Fall back to textarea
    const ta = document.querySelector<HTMLTextAreaElement>('textarea');
    if (ta) {
      this.editor = ta;
      this.attachObserver();
      return ta;
    }

    return null;
  }

  // ─── Text extraction ──────────────────────────────────────────────────────

  getText(): string {
    const el = this.getEditorElement();
    if (!el) return '';
    if (isTextarea(el)) return (el as HTMLTextAreaElement).value;
    return el.innerText ?? el.textContent ?? '';
  }

  // ─── Offset map ───────────────────────────────────────────────────────────

  getOffsetMap(): OffsetMapEntry[] {
    const el = this.getEditorElement();
    if (!el) return [];

    if (isTextarea(el)) {
      // For textareas, we build a virtual offset map using the mirrored div.
      // The mirror makes text nodes measurable; we return a synthetic map
      // that the overlay renderer uses via getCharacterRects() instead.
      return this.buildTextareaOffsetMap(el as HTMLTextAreaElement);
    }

    return buildOffsetMap(el);
  }

  // ─── Replace range ────────────────────────────────────────────────────────

  replaceRange(start: number, end: number, replacement: string): void {
    const el = this.getEditorElement();
    if (!el) return;

    if (isTextarea(el)) {
      const ta = el as HTMLTextAreaElement;
      const val = ta.value;
      ta.value = val.slice(0, start) + replacement + val.slice(end);
      // Move cursor to end of replacement
      ta.selectionStart = ta.selectionEnd = start + replacement.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const map = buildOffsetMap(el);
    const range = offsetsToRange(map, start, end);
    if (!range) return;
    range.deleteContents();
    range.insertNode(document.createTextNode(replacement));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }

  setText(text: string): void {
    const el = this.getEditorElement();
    if (!el) return;
    if (isTextarea(el)) {
      const ta = el as HTMLTextAreaElement;
      ta.value = text;
      ta.selectionStart = ta.selectionEnd = text.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    }
  }

  // ─── Change listener ──────────────────────────────────────────────────────

  onTextChange(callback: (text: string) => void): void {
    this.textChangeCallbacks.push(callback);
    if (!this.mutationObserver && !this.inputHandler) {
      this.getEditorElement();
    }
  }

  /** Phase C: Generic sites don't have a known conversation structure. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getConversationHistory(_maxMessages?: number): ConversationMessage[] {
    return [];
  }

  /** Phase B: Generic sites — no submit hook (unknown form structure). */
  onSubmit(_callback: (promptText: string) => void): void {
    // No-op for generic adapter
  }

  destroy(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.inputHandler = null;
    this.textChangeCallbacks = [];
    this.mirror?.remove();
    this.mirror = null;
  }

  // ─── Textarea: mirrored div offset map ───────────────────────────────────
  //
  // Technique: create an invisible div that exactly mirrors the textarea's
  // font/size/padding. Inject the text as plain text nodes. Then use
  // Range.getClientRects() on text node sub-ranges to get pixel positions.

  private buildTextareaOffsetMap(ta: HTMLTextAreaElement): OffsetMapEntry[] {
    const mirror = this.ensureMirror(ta);
    if (!mirror) return [];

    const text = ta.value;
    mirror.textContent = text;

    // The mirror has exactly one text node spanning [0, text.length]
    const textNode = mirror.firstChild as Text | null;
    if (!textNode) return [];

    return [{ node: textNode, nodeStart: 0, nodeEnd: text.length }];
  }

  private ensureMirror(ta: HTMLTextAreaElement): HTMLElement | null {
    if (this.mirror && document.contains(this.mirror)) {
      // Always sync mirror size and text before returning
      const r = ta.getBoundingClientRect();
      this.mirror.style.left = `${r.left + window.scrollX}px`;
      this.mirror.style.top = `${r.top + window.scrollY}px`;
      this.mirror.style.width = `${r.width}px`;
      this.mirror.style.height = `${r.height}px`;
      return this.mirror;
    }

    const m = document.createElement('div');
    m.id = 'pc-textarea-mirror';

    // Copy all layout-affecting styles from the textarea
    const cs = window.getComputedStyle(ta);
    const props = [
      'font-family', 'font-size', 'font-weight', 'font-style',
      'letter-spacing', 'line-height', 'text-transform',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'box-sizing', 'word-wrap', 'overflow-wrap', 'white-space',
    ];
    const inlineStyles = props.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';');

    // BUG FIX: Use position:absolute (not fixed) so scrollX/scrollY offsets work correctly
    const rect = ta.getBoundingClientRect();
    m.style.cssText = `
      ${inlineStyles};
      position: absolute;
      left: ${rect.left + window.scrollX}px;
      top: ${rect.top + window.scrollY}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      overflow: hidden;
      visibility: hidden;
      pointer-events: none;
      white-space: pre-wrap;
      word-wrap: break-word;
      z-index: -9999;
    `;

    document.body.appendChild(m);
    this.mirror = m;

    // Sync mirror position/size on scroll and resize
    const syncPos = () => {
      if (!this.mirror || !this.editor) return;
      const r = this.editor.getBoundingClientRect();
      this.mirror.style.left = `${r.left + window.scrollX}px`;
      this.mirror.style.top = `${r.top + window.scrollY}px`;
      this.mirror.style.width = `${r.width}px`;
      this.mirror.style.height = `${r.height}px`;
    };
    window.addEventListener('scroll', syncPos, { passive: true });
    window.addEventListener('resize', syncPos, { passive: true });

    return m;
  }

  // ─── Observer attachment ──────────────────────────────────────────────────

  private attachObserver(): void {
    if ((this.mutationObserver || this.inputHandler) || !this.editor) return;

    let lastText = '';

    if (isTextarea(this.editor)) {
      const handler = () => {
        const text = (this.editor as HTMLTextAreaElement)?.value ?? '';
        if (text !== lastText) {
          lastText = text;
          this.textChangeCallbacks.forEach((cb) => cb(text));
        }
      };
      this.inputHandler = handler;
      this.editor.addEventListener('input', handler);
      this.editor.addEventListener('paste', () => setTimeout(handler, 0));
      return;
    }

    // contenteditable
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEditableElement(el: HTMLElement): boolean {
  return (
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'INPUT' ||
    el.getAttribute('contenteditable') === 'true'
  );
}

function isTextarea(el: HTMLElement): boolean {
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
}
