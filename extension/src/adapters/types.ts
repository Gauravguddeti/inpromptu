import { ConversationMessage } from '../types';

export interface OffsetMapEntry {
  node: Text;
  nodeStart: number;
  nodeEnd: number;
}

export interface SiteAdapter {
  /** Human-readable name for debugging */
  name: string;

  getEditorElement(): HTMLElement | null;
  getText(): string;
  getOffsetMap(): OffsetMapEntry[];
  replaceRange(start: number, end: number, replacement: string): void;
  setText(text: string): void;
  onTextChange(callback: (text: string) => void): void;

  /**
   * Phase C: Read the last `maxMessages` conversation turns from the page DOM.
   * Returns user+assistant pairs in chronological order.
   * Returns [] if not supported or conversation not found.
   */
  getConversationHistory(maxMessages?: number): ConversationMessage[];

  /**
   * Phase B: Register a callback that fires when the user submits a prompt
   * (clicks Send or presses Enter on the chat form).
   * The callback receives the submitted prompt text.
   * Used to incrementally track prompts for session context.
   */
  onSubmit(callback: (promptText: string) => void): void;

  destroy(): void;
}
