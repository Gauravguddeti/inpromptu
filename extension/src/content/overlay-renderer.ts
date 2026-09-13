/**
 * OverlayRenderer — Grammarly-style underlines + hover tooltips
 * ──────────────────────────────────────────────────────────────
 * Architecture:
 *  - Underlines: absolutely-positioned <span>s drawn using Range.getClientRects()
 *  - Tooltip: a single shared floating div that moves to the hovered span
 *  - Mouse tracking: mousemove on document detects hover over underline regions
 *  - Redraws on: analysis result change, scroll, resize
 *
 * Severity → color mapping (user spec):
 *  - red    → #ef4444 (critical, will cause failure)
 *  - yellow → #f97316 (orange: fixable/ignorable)
 *  - blue   → #3b82f6 (style suggestion)
 */

import { AnalysisResult, Issue, IssueSeverity } from '../types';
import { SiteAdapter, OffsetMapEntry } from '../adapters/types';
import { pcLogger } from './logger';

// ─── Color palette ────────────────────────────────────────────────────────────

// BUG FIX: Use functions with fallback so undefined severity never reaches CSS
function getSeverityColor(s: string): string {
  return { red: '#ef4444', yellow: '#f97316', blue: '#3b82f6' }[s] ?? '#f97316';
}
function getSeverityBg(s: string): string {
  return {
    red: 'rgba(239,68,68,0.1)',
    yellow: 'rgba(249,115,22,0.1)',
    blue: 'rgba(59,130,246,0.1)',
  }[s] ?? 'rgba(249,115,22,0.1)';
}
function getSeverityLabel(s: string): string {
  return { red: '🔴 Critical', yellow: '🟠 Fixable', blue: '💙 Suggestion' }[s] ?? '🟠 Fixable';
}
function getSeverityCssClass(s: string): string {
  return ['red', 'yellow', 'blue'].includes(s) ? s : 'yellow';
}

// ─── Injected styles ──────────────────────────────────────────────────────────

const STYLES = `
  .pc-underline {
    position: fixed;
    pointer-events: all;
    cursor: pointer;
    z-index: 2147483640;
    border-radius: 1px;
    transition: opacity 0.12s;
  }
  .pc-underline:hover { opacity: 0.7; }

  /* Dims underlines while a new analysis is in-flight */
  .pc-underline.pc-pending,
  .pc-additive-badge.pc-pending {
    opacity: 0.3 !important;
    transition: opacity 0.2s;
  }

  /* Wavy underline via border-bottom */
  .pc-underline-red {
    border-bottom: 2.5px solid #ef4444;
    background: rgba(239,68,68,0.04);
  }
  .pc-underline-yellow {
    border-bottom: 2.5px solid #f97316;
    background: rgba(249,115,22,0.04);
  }
  .pc-underline-blue {
    border-bottom: 2px dashed #3b82f6;
    background: rgba(59,130,246,0.04);
  }

  /* '+' badge for additive issues — positioned after last char */
  .pc-additive-badge {
    position: fixed;
    pointer-events: all;
    z-index: 2147483640;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-family: system-ui, sans-serif;
    user-select: none;
    transition: background 0.15s, transform 0.15s, opacity 0.12s;
    animation: pc-badge-pulse 2s ease-in-out infinite;
  }
  @keyframes pc-badge-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(96,165,250,0.4); }
    50%       { box-shadow: 0 0 0 4px rgba(96,165,250,0); }
  }

  /* ── Tooltip ── */
  #pc-tooltip {
    position: fixed;
    z-index: 2147483647;
    background: #1a1a24;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 0;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
    width: 300px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    pointer-events: all;
    opacity: 0;
    transform: translateY(4px) scale(0.97);
    transition: opacity 0.18s ease, transform 0.18s ease;
    overflow: hidden;
  }
  #pc-tooltip.pc-visible {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .pc-tooltip-header {
    padding: 10px 14px 8px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .pc-severity-badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 20px;
    letter-spacing: 0.03em;
  }

  .pc-close-btn {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: none;
    background: rgba(255,255,255,0.06);
    color: rgba(255,255,255,0.4);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    line-height: 1;
    transition: all 0.15s;
  }
  .pc-close-btn:hover { background: rgba(255,255,255,0.12); color: white; }

  .pc-tooltip-explanation {
    padding: 10px 14px;
    color: rgba(255,255,255,0.7);
    font-size: 12px;
    line-height: 1.5;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }

  .pc-suggestions-label {
    padding: 8px 14px 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.3);
  }

  .pc-suggestions { padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 4px; }

  .pc-suggestion-btn {
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 8px;
    color: rgba(255,255,255,0.85);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1.4;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .pc-suggestion-btn::before { content: '→'; color: rgba(255,255,255,0.3); flex-shrink: 0; font-size: 11px; margin-top: 1px; }
  .pc-suggestion-btn:hover {
    background: rgba(99,102,241,0.15);
    border-color: rgba(99,102,241,0.35);
    color: white;
  }
  .pc-suggestion-btn:hover::before { color: #818cf8; }

  .pc-tooltip-footer {
    padding: 8px 14px;
    border-top: 1px solid rgba(255,255,255,0.06);
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  .pc-ignore-btn {
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.08);
    background: transparent;
    color: rgba(255,255,255,0.35);
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .pc-ignore-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.6); }

  /* ── Loading dot ── */
  #pc-loader {
    position: fixed;
    bottom: 18px;
    right: 18px;
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(22,22,30,0.9);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 20px;
    padding: 5px 10px;
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    color: rgba(255,255,255,0.5);
    z-index: 2147483647;
    display: none;
    backdrop-filter: blur(8px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }
  #pc-loader.pc-loading { display: flex; }
  .pc-loader-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #6366f1;
    animation: pcPulse 1s ease-in-out infinite;
  }
  @keyframes pcPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.75); }
  }
`;

// ─── Underline record ─────────────────────────────────────────────────────────

interface UnderlineRecord {
  issue: Issue;
  elements: HTMLElement[];
  rects: DOMRect[];
}

// ─── OverlayRenderer ─────────────────────────────────────────────────────────

export class OverlayRenderer {
  private underlines: UnderlineRecord[] = [];
  private tooltip: HTMLElement | null = null;
  private loader: HTMLElement | null = null;
  private activeIssueId: string | null = null;
  private ignoredIssueIds = new Set<string>();
  private currentResult: AnalysisResult | null = null;
  private currentAdapter: SiteAdapter | null = null;

  // Timers
  private redrawTimer: ReturnType<typeof setTimeout> | null = null;
  // FIX: grace-period timer so mouse can travel from underline → tooltip without hiding
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  // Undo stack: stores full text state before each suggestion application
  private undoStack: string[] = [];
  private static readonly MAX_UNDO = 20;

  constructor() {
    this.injectStyles();
    this.createSentinel();   // Must be first so extension detection works
    this.createTooltip();
    this.createLoader();
    this.attachGlobalListeners();
    this.attachUndoHandler();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  render(result: AnalysisResult, adapter: SiteAdapter): void {
    this.currentResult = result;
    this.currentAdapter = adapter;

    pcLogger.info(
      `Rendering ${result.issues.length} issues`,
      'overlay-renderer'
    );

    // Fade out old underlines before drawing new ones
    this.fadeOutAndRedraw(adapter);
    this.broadcastIssueCounts(result);
  }

  /**
   * Dims existing underlines to signal a new analysis is in-flight.
   * Uses a CSS class instead of inline opacity so it doesn't fight
   * with the fade animation's inline opacity setting.
   */
  setAnalysisPending(isPending: boolean): void {
    // Cancel any pending fade timer — pending state is immediate
    if (!isPending) {
      // Restore: remove pending class
      this.underlines.forEach((u) =>
        u.elements.forEach((el) => el.classList.remove('pc-pending'))
      );
    } else {
      // Dim: add pending class (CSS handles opacity so no specificity fight)
      this.underlines.forEach((u) =>
        u.elements.forEach((el) => el.classList.add('pc-pending'))
      );
    }
  }

  clear(): void {
    this.removeAllUnderlines();
    this.hideTooltip();
    this.currentResult = null;
  }

  setLoading(isLoading: boolean): void {
    if (!this.loader) return;
    if (isLoading) {
      this.loader.classList.add('pc-loading');
    } else {
      this.loader.classList.remove('pc-loading');
    }
  }

  // ─── Sentinel div (extension detection hook) ──────────────────────────────

  private createSentinel(): void {
    if (document.getElementById('promptcoach-overlay')) return;
    const el = document.createElement('div');
    el.id = 'promptcoach-overlay';
    el.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:-1';
    document.body.appendChild(el);
  }

  // ─── Style injection ─────────────────────────────────────────────────────────

  private injectStyles(): void {
    if (document.getElementById('pc-styles')) return;
    const style = document.createElement('style');
    style.id = 'pc-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  // ─── Underline drawing ───────────────────────────────────────────────────────

  // ─── Overlap deduplication ────────────────────────────────────────────────────
  //
  // When a lower-severity span is fully nested inside a higher-severity span,
  // drop the inner one. The outer underline already draws attention to the region;
  // showing both creates visual noise (e.g., red covers the whole prompt AND
  // orange covers "good" inside it).

  private deduplicateIssues(issues: Issue[]): Issue[] {
    const ORDER: Record<string, number> = { red: 0, yellow: 1, blue: 2 };
    // Sort most-severe first
    const sorted = [...issues].sort(
      (a, b) => (ORDER[a.severity] ?? 1) - (ORDER[b.severity] ?? 1)
    );

    const kept: Issue[] = [];
    for (const issue of sorted) {
      const isContainedByHigherSeverity = kept.some(
        (existing) =>
          (ORDER[existing.severity] ?? 1) <= (ORDER[issue.severity] ?? 1) &&
          existing.span.start <= issue.span.start &&
          existing.span.end >= issue.span.end
      );
      if (!isContainedByHigherSeverity) {
        kept.push(issue);
      } else {
        pcLogger.debug(
          `Dropping nested issue ${issue.id} (${issue.severity} inside a higher-severity span)`,
          'dedup'
        );
      }
    }
    return kept;
  }

  /**
   * Fades out old underlines over 150ms, then draws new ones.
   *
   * FIX: Uses a generation counter so stale setTimeout callbacks from a previous
   * render cycle never fire after a newer render has already started.
   * This kills the "issues coming and going" and "stale red line" bugs.
   */
  private fadeGeneration = 0;

  private fadeOutAndRedraw(adapter: SiteAdapter): void {
    const myGen = ++this.fadeGeneration; // Claim this render's generation

    if (this.underlines.length === 0) {
      // Nothing to fade — draw immediately
      this.drawUnderlines(adapter);
      return;
    }

    // Dim existing underlines
    this.underlines.forEach((u) =>
      u.elements.forEach((el) => {
        el.style.transition = 'opacity 0.12s';
        el.style.opacity = '0';
      })
    );

    // After fade completes, only draw if no newer render superseded us
    setTimeout(() => {
      if (myGen !== this.fadeGeneration) return; // Stale — abort
      this.drawUnderlines(adapter);
    }, 130);
  }

  private drawUnderlines(adapter: SiteAdapter): void {
    this.removeAllUnderlines();

    if (!this.currentResult) return;

    const offsetMap = adapter.getOffsetMap();
    if (!offsetMap.length) {
      pcLogger.warn('Empty offset map — cannot draw underlines', 'overlay-renderer');
      return;
    }

    const totalTextLen = offsetMap[offsetMap.length - 1]?.nodeEnd ?? 0;

    // Remove lower-severity underlines fully nested inside higher-severity ones
    const issuesToDraw = this.deduplicateIssues(
      this.currentResult.issues.filter((i) => !this.ignoredIssueIds.has(i.id))
    );

    for (const issue of issuesToDraw) {
      try {
        // ── Additive whole-prompt issues → small '+' badge at end of text ──
        const spanLen = issue.span.end - issue.span.start;
        const isAdditive = OverlayRenderer.APPEND_CATEGORIES.has(issue.category);
        const isWholePrompt = totalTextLen > 0 && spanLen > totalTextLen * 0.55;

        if (isAdditive && isWholePrompt) {
          const record = this.renderAdditiveMarker(issue, offsetMap);
          if (record) this.underlines.push(record);
        } else {
          const record = this.drawIssueUnderline(issue, offsetMap);
          if (record) this.underlines.push(record);
        }
      } catch (err) {
        pcLogger.error(
          `Failed to draw underline for issue ${issue.id}`,
          'overlay-renderer',
          err instanceof Error ? err : new Error(String(err))
        );
      }
    }
  }

  private drawIssueUnderline(
    issue: Issue,
    offsetMap: OffsetMapEntry[]
  ): UnderlineRecord | null {
    // Clamp span to actual text length
    const maxOffset = offsetMap.length > 0 ? offsetMap[offsetMap.length - 1].nodeEnd : 0;
    const clampedStart = Math.min(issue.span.start, maxOffset);
    const clampedEnd = Math.min(issue.span.end, maxOffset);

    if (clampedStart >= clampedEnd) {
      pcLogger.warn(`Issue ${issue.id} has zero-width span after clamping (${clampedStart}-${clampedEnd}), skipping`, 'overlay-renderer');
      return null;
    }

    const range = this.buildRange(offsetMap, clampedStart, clampedEnd);
    if (!range) return null;

    let rects: DOMRect[];
    try {
      rects = Array.from(range.getClientRects());
    } catch {
      return null;
    }

    if (!rects.length) return null;

    const elements: HTMLElement[] = [];
    // BUG FIX: always use validated CSS class so unknown severity never breaks styles
    const cssClass = `pc-underline-${getSeverityCssClass(issue.severity)}`;
    const storedRects: DOMRect[] = [];

    for (const rect of rects) {
      if (rect.width < 2 || rect.height < 1) continue; // Skip degenerate rects

      const el = document.createElement('span');
      el.className = `pc-underline ${cssClass}`;
      // Use viewport-relative coords (position: fixed — NO scroll offset)
      el.style.cssText = `
        left: ${rect.left}px;
        top: ${rect.top}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
      `;

      el.dataset.issueId = issue.id;

      // Store a live-captured rect for tooltip positioning
      const capturedRect = rect;
      el.addEventListener('mouseenter', () => {
        // Re-measure fresh rect at hover time (handles page scroll since draw)
        const liveRect = el.getBoundingClientRect();
        this.showTooltip(issue, liveRect.width > 0 ? liveRect : capturedRect, el);
      });
      el.addEventListener('mouseleave', (e) => this.handleMouseLeave(e));

      document.body.appendChild(el);
      elements.push(el);
      storedRects.push(rect);
    }

    if (elements.length === 0) return null;
    return { issue, elements, rects: storedRects };
  }

  // ─── Additive marker ('+' badge at end of text) ────────────────────────────

  /**
   * Instead of underlining the whole prompt for additive issues
   * (missing_output_format, unspecified_audience, etc.), renders a small
   * blue '+' badge positioned right after the last character of the text.
   * Clicking/hovering opens the normal tooltip with "Add to prompt" suggestions.
   */
  private renderAdditiveMarker(
    issue: Issue,
    offsetMap: OffsetMapEntry[]
  ): UnderlineRecord | null {
    if (!offsetMap.length) return null;

    // Find the rect of the very last character in the text
    const lastEntry = offsetMap[offsetMap.length - 1];
    const lastCharStart = Math.max(0, lastEntry.nodeEnd - 1);
    const range = this.buildRange(offsetMap, lastCharStart, lastEntry.nodeEnd);
    if (!range) return null;

    let rects: DOMRect[];
    try {
      rects = Array.from(range.getClientRects());
    } catch {
      return null;
    }
    if (!rects.length) return null;

    const lastRect = rects[rects.length - 1];

    // Create the badge element
    const badge = document.createElement('span');
    badge.className = 'pc-additive-badge';
    badge.dataset.issueId = issue.id;
    badge.textContent = '+';
    badge.title = issue.explanation;

    // Position right after the last character, vertically centered on the line
    const badgeSize = 15;
    badge.style.cssText = `
      position: fixed;
      left: ${lastRect.right + 4}px;
      top: ${lastRect.top + (lastRect.height - badgeSize) / 2}px;
      width: ${badgeSize}px;
      height: ${badgeSize}px;
      border-radius: 50%;
      background: rgba(96, 165, 250, 0.12);
      border: 1.5px solid rgba(96, 165, 250, 0.7);
      color: #60a5fa;
      font-size: 10px;
      font-weight: 700;
      font-family: system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 999998;
      pointer-events: all;
      user-select: none;
      transition: background 0.15s, transform 0.15s;
      line-height: 1;
    `;

    badge.addEventListener('mouseenter', () => {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
      badge.style.background = 'rgba(96, 165, 250, 0.28)';
      badge.style.transform = 'scale(1.15)';
      const liveRect = badge.getBoundingClientRect();
      this.showTooltip(issue, liveRect, badge as unknown as HTMLElement);
    });

    badge.addEventListener('mouseleave', (e) => {
      badge.style.background = 'rgba(96, 165, 250, 0.12)';
      badge.style.transform = '';
      this.handleMouseLeave(e);
    });

    document.body.appendChild(badge);
    return { issue, elements: [badge as unknown as HTMLElement], rects };
  }

  // ─── Range builder from offset map ──────────────────────────────────────────

  private buildRange(
    map: OffsetMapEntry[],
    start: number,
    end: number
  ): Range | null {
    let startNode: Text | null = null;
    let startOff = 0;
    let endNode: Text | null = null;
    let endOff = 0;

    for (const entry of map) {
      if (!startNode && entry.nodeEnd > start) {
        startNode = entry.node;
        startOff = Math.min(start - entry.nodeStart, entry.node.length);
      }
      if (!endNode && entry.nodeEnd >= end) {
        endNode = entry.node;
        endOff = Math.min(end - entry.nodeStart, entry.node.length);
        break;
      }
    }

    if (!startNode || !endNode) return null;

    try {
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      return range;
    } catch {
      return null;
    }
  }

  // ─── Tooltip ─────────────────────────────────────────────────────────────────

  private createTooltip(): void {
    const el = document.createElement('div');
    el.id = 'pc-tooltip';
    el.setAttribute('role', 'tooltip');

    // Keep tooltip alive while mouse is inside it — cancel any pending hide
    el.addEventListener('mouseenter', () => {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      this.activeIssueId = el.dataset.issueId ?? null;
    });
    // Use scheduled hide (not immediate) so clicks on buttons can land first
    el.addEventListener('mouseleave', (e) => {
      const rel = e.relatedTarget as HTMLElement | null;
      // Moving to an underline? Don't hide (underline's mouseenter will re-show)
      if (rel?.dataset?.issueId) return;
      this.scheduleHide();
    });

    document.body.appendChild(el);
    this.tooltip = el;
  }

  private showTooltip(issue: Issue, triggerRect: DOMRect, _triggerEl: HTMLElement): void {
    if (!this.tooltip) return;

    // FIX: cancel any pending hide so tooltip doesn't vanish mid-travel
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    this.activeIssueId = issue.id;
    const tip = this.tooltip;
    tip.dataset.issueId = issue.id;

    // BUG FIX: use fallback functions — LLM can return unexpected severity values
    const color = getSeverityColor(issue.severity);
    const bg = getSeverityBg(issue.severity);
    const label = getSeverityLabel(issue.severity);

    // Build tooltip HTML — BUG FIX: filter out any undefined/empty suggestions
    const validSuggestions = (issue.suggestions ?? []).filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0
    );
    const suggestionsHtml = validSuggestions
      .slice(0, 2)
      .map(
        (s, i) => `
        <button class="pc-suggestion-btn" data-suggestion="${escapeHtml(s)}" data-issue-id="${issue.id}" data-suggestion-idx="${i}">
          ${escapeHtml(s)}
        </button>
      `
      )
      .join('');

    // BUG FIX: wrap entire innerHTML build in try/catch; escapeHtml handles undefined
    // Use correct label depending on whether this is an additive or corrective issue
    const isAdditive = OverlayRenderer.APPEND_CATEGORIES.has(issue.category);
    const suggestionsLabel = isAdditive ? 'Add to prompt' : 'Replace with';
    try {
      tip.innerHTML = `
        <div class="pc-tooltip-header">
          <span class="pc-severity-badge" style="background:${bg};color:${color};">${label}</span>
          <button class="pc-close-btn" data-close="true" title="Dismiss">✕</button>
        </div>
        <div class="pc-tooltip-explanation">${escapeHtml(issue.explanation ?? issue.category)}</div>
        ${suggestionsHtml ? `
          <div class="pc-suggestions-label">${suggestionsLabel}</div>
          <div class="pc-suggestions">${suggestionsHtml}</div>
        ` : ''}
        <div class="pc-tooltip-footer">
          <button class="pc-ignore-btn" data-ignore="${issue.id}">Ignore</button>
        </div>
      `;
    } catch (err) {
      pcLogger.error('Tooltip HTML build failed', 'showTooltip', err instanceof Error ? err : new Error(String(err)));
      return; // Don't try to position/show a broken tooltip
    }

    // Attach suggestion click handlers — async so we can call /refine before applying
    tip.querySelectorAll('.pc-suggestion-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const btnEl = e.currentTarget as HTMLButtonElement;
        const suggestion = btnEl.dataset.suggestion ?? '';
        const issueId = btnEl.dataset.issueId ?? '';
        // Show loading state on the button immediately
        btnEl.disabled = true;
        btnEl.textContent = 'Applying…';
        // Run async — fire and forget (event handler can't be async itself cleanly)
        void this.applySuggestion(issueId, suggestion);
      });
    });

    // Close button
    tip.querySelector('[data-close]')?.addEventListener('click', () => this.hideTooltip());

    // Ignore button
    tip.querySelector('[data-ignore]')?.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.ignore ?? '';
      this.ignoreIssue(id);
    });

    // Position the tooltip
    this.positionTooltip(triggerRect);

    // Show with animation
    requestAnimationFrame(() => {
      tip.classList.add('pc-visible');
    });
  }

  private positionTooltip(triggerRect: DOMRect): void {
    if (!this.tooltip) return;
    const tip = this.tooltip;

    const TIP_WIDTH = 300;
    const TIP_MARGIN = 10;
    const VIEWPORT_PADDING = 12;

    // CRITICAL FIX: Never set opacity via inline style.
    // Inline styles have higher specificity than class rules, so
    // setting opacity:0 inline means .pc-visible { opacity:1 } can NEVER override it.
    // Only set position properties here — let CSS classes handle opacity/transform.
    tip.style.left = '-9999px';
    tip.style.top = '-9999px';
    tip.style.width = `${TIP_WIDTH}px`;
    // Clear any stale inline opacity from previous incorrect calls
    tip.style.removeProperty('opacity');
    tip.style.removeProperty('transform');
    tip.style.removeProperty('pointer-events');

    // Force layout reflow so offsetHeight is accurate
    const tipHeight = tip.offsetHeight || 180;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Show above the underline (like Grammarly)
    let top = triggerRect.top - tipHeight - TIP_MARGIN;
    let left = triggerRect.left;

    // Clips top → show below
    if (top < VIEWPORT_PADDING) {
      top = triggerRect.bottom + TIP_MARGIN;
    }
    // Clamp right
    if (left + TIP_WIDTH > vw - VIEWPORT_PADDING) {
      left = vw - TIP_WIDTH - VIEWPORT_PADDING;
    }
    // Clamp left
    if (left < VIEWPORT_PADDING) {
      left = VIEWPORT_PADDING;
    }
    // Clamp bottom
    if (top + tipHeight > vh - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, vh - tipHeight - VIEWPORT_PADDING);
    }

    // Set ONLY position — CSS class .pc-visible controls opacity + transform
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.width = `${TIP_WIDTH}px`;
  }

  private hideTooltip(): void {
    if (!this.tooltip) return;
    this.tooltip.classList.remove('pc-visible');
    this.activeIssueId = null;
  }

  private scheduleHide(): void {
    // FIX: delay so mouse can travel from underline → tooltip without triggering hide
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hideTooltip();
    }, 220); // 220ms grace window
  }

  private handleMouseLeave(e: MouseEvent): void {
    // Don't hide if moving to the tooltip itself or another underline of the same issue
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (relatedTarget?.closest?.('#pc-tooltip')) return;
    if (relatedTarget?.dataset?.issueId === this.activeIssueId) return;
    // FIX: use scheduled hide instead of immediate hide
    this.scheduleHide();
  }

  // ─── Actions ─────────────────────────────────────────────────────────────────

  // Categories where the suggestion ADDS something missing (append to prompt end)
  // vs categories where the suggestion REPLACES the flagged span text
  private static readonly APPEND_CATEGORIES = new Set([
    'missing_output_format',
    'unspecified_audience',
    'missing_constraints',
    'missing_context',
    'unclear_tone',
    'poor_structure',
  ]);

  private async applySuggestion(issueId: string, suggestion: string): Promise<void> {
    const issue = this.currentResult?.issues.find((i) => i.id === issueId);
    if (!issue || !this.currentAdapter) return;

    try {
      const currentText = this.currentAdapter.getText();
      const start = issue.span.start;
      const end = Math.min(issue.span.end, currentText.length);
      const spanLength = end - start;
      const totalLength = currentText.length;

      // ── Determine mode: APPEND or REPLACE ────────────────────────────────────
      const isCategoryAppend = OverlayRenderer.APPEND_CATEGORIES.has(issue.category);
      const isWholePromptSpan = spanLength > totalLength * 0.55;
      const shouldAppend = isCategoryAppend && isWholePromptSpan;

      // ── Push undo state BEFORE making any change ──────────────────────────
      this.undoStack.push(currentText);
      if (this.undoStack.length > OverlayRenderer.MAX_UNDO) {
        this.undoStack.shift();
      }

      if (shouldAppend) {
        // ── APPEND MODE ──────────────────────────────────────────────────────
        // Add the suggestion at the END of the prompt as additional specification.
        let base = currentText.trimEnd();
        const startsLower = /^[a-z]/.test(suggestion.trim());
        const baseHasSentenceEnd = /[.!?]$/.test(base);

        let joiner: string;
        if (startsLower) {
          joiner = ' ';
        } else if (baseHasSentenceEnd) {
          joiner = '\n';
        } else {
          joiner = '. ';
        }

        const newText = base + joiner + suggestion.trim();
        this.currentAdapter.setText(newText);
        pcLogger.info(`Appended suggestion for issue ${issueId}: "${suggestion}"`, 'overlay-renderer');

      } else {
        // ── REPLACE MODE ─────────────────────────────────────────────────────
        // Refine the suggestion so it fits grammatically in the span's position.
        // This prevents whole-sentence replacements from breaking surrounding text.
        let refinedSuggestion = suggestion;

        try {
          // Race the refine call against a 400ms timeout so it never blocks UX
          const refinePromise = this.callRefine(currentText, start, end, suggestion, issue.category);
          const timeoutPromise = new Promise<string>((resolve) =>
            setTimeout(() => resolve(suggestion), 400)
          );
          refinedSuggestion = await Promise.race([refinePromise, timeoutPromise]);
        } catch {
          // Fall back to original — refinement is non-critical
          refinedSuggestion = suggestion;
        }

        const originalSpan = currentText.slice(start, end);

        // Smart punctuation preservation
        const trailingPunct = originalSpan.match(/([.!?])\s*$/);
        const suggestionHasPunct = /[.!?]\s*$/.test(refinedSuggestion);
        let smartSuggestion = refinedSuggestion.trimEnd();
        if (trailingPunct && !suggestionHasPunct) {
          smartSuggestion += trailingPunct[1];
        }

        // Ensure a single space between replacement and whatever follows
        const charAfter = currentText[end];
        if (
          charAfter &&
          charAfter !== ' ' &&
          charAfter !== '\n' &&
          !smartSuggestion.endsWith(' ') &&
          !smartSuggestion.endsWith('\n')
        ) {
          smartSuggestion += ' ';
        }

        this.currentAdapter.replaceRange(start, end, smartSuggestion);
        pcLogger.info(`Replaced span [${start}-${end}] for issue ${issueId}: "${smartSuggestion}"`, 'overlay-renderer');
      }

      // Send feedback to backend (best-effort)
      chrome.runtime.sendMessage({
        type: 'FEEDBACK',
        payload: { suggestionId: issueId, accepted: true, category: issue.category },
      }).catch(() => { /* ignore — feedback is non-critical */ });

      // Remove this underline and hide tooltip
      this.removeIssueUnderline(issueId);
      this.hideTooltip();

    } catch (err) {
      pcLogger.error(
        `Failed to apply suggestion for issue ${issueId}`,
        'overlay-renderer',

        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  // ─── Refine helper ────────────────────────────────────────────────────────────

  /**
   * Calls the /refine backend endpoint via the service worker to get a
   * grammatically-integrated version of the raw suggestion.
   * If it fails for any reason, returns the original suggestion unchanged.
   */
  private async callRefine(
    fullText: string,
    spanStart: number,
    spanEnd: number,
    suggestion: string,
    category: string
  ): Promise<string> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REFINE_REQUEST',
        payload: { fullText, spanStart, spanEnd, suggestion, category },
      });

      if (response?.type === 'REFINE_RESPONSE' && response.payload?.refinedSuggestion) {
        return response.payload.refinedSuggestion as string;
      }
    } catch (err) {
      pcLogger.debug(`Refine call failed, using original: ${(err as Error).message}`, 'overlay-renderer');
    }
    return suggestion;
  }

  private ignoreIssue(issueId: string): void {
    this.ignoredIssueIds.add(issueId);
    this.removeIssueUnderline(issueId);
    this.hideTooltip();

    // Send feedback
    const issue = this.currentResult?.issues.find((i) => i.id === issueId);
    if (issue) {
      chrome.runtime.sendMessage({
        type: 'FEEDBACK',
        payload: { suggestionId: issueId, accepted: false, category: issue.category },
      });
    }
  }

  private removeIssueUnderline(issueId: string): void {
    const record = this.underlines.find((u) => u.issue.id === issueId);
    if (!record) return;
    record.elements.forEach((el) => el.remove());
    this.underlines = this.underlines.filter((u) => u.issue.id !== issueId);
  }

  private removeAllUnderlines(): void {
    this.underlines.forEach((u) => u.elements.forEach((el) => el.remove()));
    this.underlines = [];
  }

  // ─── Loader ──────────────────────────────────────────────────────────────────

  private createLoader(): void {
    const el = document.createElement('div');
    el.id = 'pc-loader';
    el.innerHTML = '<div class="pc-loader-dot"></div><span>Analyzing…</span>';
    document.body.appendChild(el);
    this.loader = el;
  }

  // ─── Global listeners ─────────────────────────────────────────────────────────

  private attachGlobalListeners(): void {
    // Redraw underlines on scroll/resize (positions change)
    // NOTE: use drawUnderlines directly (not fadeOutAndRedraw) so we don't
    // trigger the fade animation on every scroll tick, and we bump
    // fadeGeneration to cancel any pending fade timer.
    const scheduleRedraw = () => {
      if (this.redrawTimer) clearTimeout(this.redrawTimer);
      this.redrawTimer = setTimeout(() => {
        if (this.currentResult && this.currentAdapter) {
          this.fadeGeneration++; // Cancel any pending fade timer
          this.drawUnderlines(this.currentAdapter);
        }
      }, 60);
    };

    window.addEventListener('scroll', scheduleRedraw, { passive: true });
    window.addEventListener('resize', scheduleRedraw, { passive: true });
  }

  // ─── Undo handler (Ctrl+Z / Cmd+Z) ───────────────────────────────────────────

  private attachUndoHandler(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Ctrl+Z (Win/Linux) or Cmd+Z (Mac) — not Ctrl+Shift+Z (redo)
      if (!((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey)) return;
      if (this.undoStack.length === 0) return;

      // Only intercept when the adapter's editor element is focused
      const editorEl = this.currentAdapter?.getEditorElement();
      if (!editorEl) return;
      const active = document.activeElement as HTMLElement | null;
      const isEditorFocused =
        active === editorEl ||
        editorEl.contains(active) ||
        active?.getAttribute('contenteditable') === 'true';
      if (!isEditorFocused) return;

      e.preventDefault();
      e.stopPropagation();

      const previousText = this.undoStack.pop()!;
      this.currentAdapter!.setText(previousText);

      // Clear underlines — debounce engine will re-analyze after delay
      this.removeAllUnderlines();
      this.hideTooltip();

      pcLogger.info(`Undo: restored ${previousText.length} chars (${this.undoStack.length} states left)`, 'undo');
    }, true); // capture phase so we run before the textarea's native handler
  }

  // ─── Issue counter broadcast ──────────────────────────────────────────────────

  private broadcastIssueCounts(result: AnalysisResult): void {
    const counts = { red: 0, orange: 0, blue: 0 };
    result.issues.forEach((i) => {
      if (i.severity === 'red') counts.red++;
      else if (i.severity === 'yellow') counts.orange++;
      else if (i.severity === 'blue') counts.blue++;
    });

    // Post to demo page if it's listening
    try {
      window.postMessage(
        { type: 'PROMPTCOACH_ISSUES', ...counts },
        '*'
      );
    } catch { /* ignore */ }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// BUG FIX: Handle undefined/null gracefully — the #1 crash cause
function escapeHtml(str: string | undefined | null): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
