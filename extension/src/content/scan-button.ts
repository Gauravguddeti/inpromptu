/**
 * ScanButton — cross-site in-page scan button
 * ─────────────────────────────────────────────
 * Uses position:fixed + getBoundingClientRect() to track the chat editor.
 * This is more reliable than DOM injection (which fails when containers
 * have overflow:hidden or complex stacking contexts).
 *
 * Position: anchored to the RIGHT EDGE of the editor, vertically centred.
 * Falls back to bottom-left corner if no editor is found.
 */

import { getSessionContext } from './session-context';

export type ScanBtnState = 'stale' | 'scanning' | 'fresh';

const BTN_ID   = 'pc-scan-btn';
const TIP_ID   = 'pc-scan-tip';
const STYLE_ID = 'pc-scan-css';
const STALE_MS = 30 * 60 * 1000; // 30 min

export class ScanButton {
  private el:     HTMLButtonElement | null = null;
  private tipEl:  HTMLDivElement    | null = null;
  private state:  ScanBtnState = 'stale';
  private lastUrl = location.href;

  private editorEl:  HTMLElement | null = null;
  private rafId:     number | null = null;
  private urlTimer:  ReturnType<typeof setInterval> | null = null;
  private onScan:    (() => Promise<void>) | null = null;

  // ─── Public API ─────────────────────────────────────────────────────────────

  mount(onScan: () => Promise<void>, editorEl: HTMLElement | null): void {
    this.onScan   = onScan;
    this.editorEl = editorEl;

    // Remove stale DOM nodes
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(TIP_ID)?.remove();

    this.injectCSS();
    this.el    = this.buildButton();
    this.tipEl = this.buildTooltip();
    document.body.appendChild(this.tipEl);
    document.body.appendChild(this.el);

    this.updatePosition();
    this.startPositionLoop();
    this.refreshFromStorage();

    // Detect URL changes (conversation switch → go stale)
    this.urlTimer = setInterval(() => {
      if (location.href !== this.lastUrl) {
        this.lastUrl = location.href;
        this.setState('stale');
      } else {
        this.refreshFromStorage();
      }
    }, 2000);
  }

  unmount(): void {
    this.el?.remove();
    this.tipEl?.remove();
    this.el = this.tipEl = null;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    if (this.urlTimer) clearInterval(this.urlTimer);
  }

  setState(state: ScanBtnState): void {
    this.state = state;
    this.renderState();
  }

  // ─── Position tracking ───────────────────────────────────────────────────────

  /** Re-run every animation frame so the button tracks the editor on all sites */
  private startPositionLoop(): void {
    const loop = () => {
      this.updatePosition();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private updatePosition(): void {
    const btn = this.el;
    if (!btn) return;

    if (this.editorEl && document.body.contains(this.editorEl)) {
      const r = this.editorEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        // Grammarly-style: inside the editor, bottom-right corner
        // right  = distance from viewport-right to the editor's right edge + 8px inset
        // bottom = distance from viewport-bottom to the editor's bottom edge + 8px inset
        const right  = Math.max(8, window.innerWidth  - r.right  + 8);
        const bottom = Math.max(8, window.innerHeight - r.bottom + 8);

        btn.style.right  = `${right}px`;
        btn.style.bottom = `${bottom}px`;
        btn.style.top    = '';
        btn.style.left   = '';
        return;
      }
    }

    // Fallback: bottom-right corner of viewport
    btn.style.right  = '20px';
    btn.style.bottom = '100px';
    btn.style.top    = '';
    btn.style.left   = '';
  }

  // ─── Build DOM ───────────────────────────────────────────────────────────────

  private buildButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id   = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Inpromptu — scan conversation context');

    btn.addEventListener('mouseenter', () => this.showTip());
    btn.addEventListener('mouseleave', () => this.hideTip());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleClick();
    });

    this.renderState(btn);
    return btn;
  }

  private buildTooltip(): HTMLDivElement {
    const tip = document.createElement('div');
    tip.id = TIP_ID;
    return tip;
  }

  // ─── Interaction ─────────────────────────────────────────────────────────────

  private async handleClick(): Promise<void> {
    if (this.state === 'scanning') return;
    this.setState('scanning');
    try {
      await this.onScan?.();
      this.setState('fresh');
    } catch (err) {
      console.warn('[Inpromptu] Scan failed:', err);
      this.setState('stale');
    }
  }

  private refreshFromStorage(): void {
    if (this.state === 'scanning') return;
    const ctx = getSessionContext();
    if (!ctx) { this.setState('stale'); return; }
    const expired  = Date.now() - ctx.lastUpdatedAt > STALE_MS;
    const base     = location.origin + '/' + location.pathname.split('/').slice(1, 3).join('/');
    const mismatch = !ctx.sourceUrl.split('?')[0].startsWith(base);
    this.setState(expired || mismatch ? 'stale' : 'fresh');
  }

  // ─── Rendering ───────────────────────────────────────────────────────────────

  private renderState(btn: HTMLButtonElement = this.el!): void {
    if (!btn) return;
    btn.classList.remove('pc-stale', 'pc-scanning', 'pc-fresh');
    btn.classList.add(`pc-${this.state}`);

    if (this.state === 'scanning') {
      btn.innerHTML = '<span class="pc-ring"></span>';
    } else if (this.state === 'fresh') {
      btn.innerHTML = '<span class="pc-tick">✓</span>';
    } else {
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <circle cx="12" cy="12" r="9"/>
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 3v2m0 14v2M3 12h2m14 0h2"/>
      </svg>`;
    }
  }

  private showTip(): void {
    if (!this.el || !this.tipEl) return;
    const r = this.el.getBoundingClientRect();
    this.tipEl.style.top  = `${r.top + r.height / 2 - 14}px`;
    this.tipEl.style.left = `${r.right + 6}px`;
    this.tipEl.style.opacity = '1';
    this.tipEl.textContent =
      this.state === 'fresh'    ? '✓ Up to date — click to re-scan' :
      this.state === 'scanning' ? 'Scanning…' :
                                  'Scan conversation for context';
  }

  private hideTip(): void {
    if (this.tipEl) this.tipEl.style.opacity = '0';
  }

  // ─── CSS ─────────────────────────────────────────────────────────────────────

  private injectCSS(): void {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #pc-scan-btn {
        position: fixed;
        width: 30px; height: 30px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        padding: 0;
        outline: none;
        font-family: system-ui, sans-serif;
        transition: transform 0.18s cubic-bezier(.34,1.56,.64,1);
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }
      #pc-scan-btn:hover { transform: scale(1.2); }
      #pc-scan-btn:active { transform: scale(0.92); }

      #pc-scan-btn.pc-stale {
        background: linear-gradient(135deg,#f87171,#dc2626);
        animation: pc-pulse-r 2.5s ease-in-out infinite;
      }
      @keyframes pc-pulse-r {
        0%,100% { box-shadow: 0 0 0 0 rgba(220,38,38,.4); }
        50%      { box-shadow: 0 0 0 5px rgba(220,38,38,0); }
      }
      #pc-scan-btn.pc-scanning {
        background: linear-gradient(135deg,#6366f1,#8b5cf6);
        animation: pc-pulse-p 1.2s ease-in-out infinite;
      }
      @keyframes pc-pulse-p {
        0%,100% { box-shadow: 0 0 0 0 rgba(99,102,241,.5); }
        50%      { box-shadow: 0 0 0 5px rgba(99,102,241,0); }
      }
      #pc-scan-btn.pc-fresh {
        background: linear-gradient(135deg,#4ade80,#16a34a);
        box-shadow: 0 2px 8px rgba(22,163,74,.3);
      }

      .pc-ring {
        display: block; width:14px; height:14px;
        border: 2px solid rgba(255,255,255,.3);
        border-top-color:#fff; border-radius:50%;
        animation: pc-spin .75s linear infinite;
      }
      @keyframes pc-spin { to { transform: rotate(360deg); } }

      .pc-tick {
        font-weight:700; font-size:14px;
        animation: pc-pop .35s cubic-bezier(.34,1.56,.64,1) forwards;
      }
      @keyframes pc-pop {
        0%   { transform:scale(0) rotate(-30deg); opacity:0 }
        70%  { transform:scale(1.3) rotate(6deg); opacity:1 }
        100% { transform:scale(1) rotate(0); opacity:1 }
      }

      #pc-scan-tip {
        position: fixed;
        font-size: 11.5px; line-height: 1.4;
        background: rgba(10,10,20,.93);
        backdrop-filter: blur(8px);
        color: rgba(255,255,255,.92);
        padding: 5px 10px; border-radius: 7px;
        white-space: nowrap; pointer-events: none;
        opacity: 0; transition: opacity .15s;
        z-index: 2147483647;
        box-shadow: 0 2px 12px rgba(0,0,0,.3);
        border: 1px solid rgba(255,255,255,.08);
        font-family: system-ui, sans-serif;
      }
    `;
    document.head.appendChild(s);
  }
}
