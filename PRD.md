# Inpromptu — "Grammarly for AI Prompts"
### Product Requirements & Implementation Plan (v1)

**Scope decided:** Browser extension → works on any AI chat site → cloud LLM (free tier) for analysis → cloud-synced memory (small backend + DB). Windows/desktop app is a Phase 3 goal, built once the extension core is proven.

---

## 1. Product Concept

A browser extension that overlays a Grammarly-style layer on top of any AI chat input (ChatGPT, Claude.ai, Gemini, Perplexity, etc.). As the user types a prompt, it:

- Underlines problematic spans (ambiguous, missing context, no output format, etc.)
- Shows a tooltip on hover explaining the issue and offering 1–3 rewrite suggestions
- Lets the user click a suggestion to replace just that span, or click **"Improve entire prompt"** for a full rewrite
- Learns and stores durable preferences (style, terminology, projects) in an account the user controls, viewable/editable/deletable at any time

This is **not** a rewrite-everything tool. Precision and user control are the core UX promise — same philosophy as Grammarly, applied to prompt quality instead of grammar.

---

## 2. Why This Is Harder Than Grammarly (read this first)

Before the architecture, three honest challenges to your framing:

1. **Grammar has one ground truth; prompt quality doesn't.** "Good response about this product" is vague, but *how* to fix it depends on intent the model has to infer. This means every suggestion is probabilistic, not deterministic — you're building a suggestion engine, not a rules engine. Budget for suggestions sometimes being wrong, and design the UX so a wrong suggestion costs the user nothing (one click to dismiss).
2. **The hardest engineering problem isn't the AI — it's the DOM.** ChatGPT, Claude.ai, and Gemini don't use plain `<textarea>` elements; they use rich-text editors (ProseMirror/contenteditable). Grammarly-style underlays require precisely mapping text offsets to screen positions inside someone else's editor, and that mapping breaks every time the site ships a UI update. This is the #1 risk to sequence early and de-risk first — not the LLM prompting.
3. **Real-time, per-keystroke analysis will exhaust free-tier limits almost immediately.** Free tiers are rate-limited to tens of requests/minute (see §7). You cannot call the LLM on every keystroke. Debouncing, diffing, and local pre-filtering aren't optimizations — they're the only way this works at all on free tiers.

Everything below is designed around these three constraints.

---

## 3. MVP Feature Set

**In scope for v1:**
- Injects into any page's active text-input element (generic contenteditable/textarea detector + specific adapters for ChatGPT, Claude.ai, Gemini, Perplexity)
- Debounced analysis (fires ~900ms after the user stops typing, or on sentence-end punctuation)
- Underlines with 3 severity colors (red = likely to cause failure, yellow = ambiguous, blue = style/structure suggestion)
- Hover tooltip: issue explanation + up to 2 ranked suggestions
- Click-to-replace for a single span
- "Improve entire prompt" button (full-prompt rewrite, shown as a diff, must be explicitly accepted)
- Account + cloud memory: sign in, view/edit/delete stored preferences and glossary terms, per-project memory toggle
- Settings: pause analysis, choose model speed vs quality, opt out of cloud memory entirely

**Explicitly out of scope for v1** (Phase 2+, see §12):
- Local/offline model inference
- Desktop app
- Team/shared memory
- Fine-tuned custom classifier (start with prompting only)

---

## 4. System Architecture

```
┌──────────────────────────── Browser ────────────────────────────┐
│                                                                   │
│  Content Script (injected into chat sites)                       │
│   ├─ Site Adapter (ChatGPT / Claude / Gemini / generic)          │
│   ├─ Text extraction + offset mapping                            │
│   ├─ Overlay renderer (underlines, tooltips)                     │
│   └─ Debounce + diff engine (only sends changed spans)           │
│                                                                   │
│  Extension Service Worker (background)                           │
│   ├─ Session/auth token cache                                    │
│   ├─ Request queue + rate limiter                                │
│   └─ Local cache (hash → last analysis result)                   │
│                                                                   │
│  Popup / Side Panel (React)                                      │
│   ├─ Settings                                                    │
│   └─ Memory manager (view/edit/delete)                           │
└─────────────────────────────┬─────────────────────────────────────┘
                               │ HTTPS (extension never holds the LLM key)
                               ▼
┌───────────────────────── Backend (yours) ─────────────────────────┐
│  Supabase (free tier): Auth + Postgres + pgvector + Edge Functions │
│   ├─ /analyze        → runs prompt analysis, returns issue spans   │
│   ├─ /improve-full    → full-prompt rewrite                        │
│   ├─ /memory (CRUD)   → user preferences, glossary, projects       │
│   └─ /feedback        → accept/reject logs for evaluation          │
│                                                                     │
│  Holds the LLM API keys (Gemini, Groq) — never shipped to client   │
└─────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌───────────────────────── LLM Providers ────────────────────────────┐
│  Gemini 2.0/2.5 Flash (free tier) — primary analysis + rewrites     │
│  Groq (Llama 3.3, free tier)       — fast, cheap triage pass        │
└──────────────────────────────────────────────────────────────────┘
```

**Why a backend at all, given "free tools only"?** You chose cloud-synced memory, which needs a database somewhere, and API keys must never live in a browser extension (any user can extract them from the extension bundle in seconds). Supabase's free tier covers Postgres, pgvector, Auth, and serverless functions in one place, so this doesn't need separate services.

---

## 5. Prompt Analysis Pipeline

### 5.1 Trigger logic (this is what saves your rate limit)
1. **Keystroke buffering**: content script buffers input locally, does *not* call the backend per keystroke.
2. **Debounce**: fire analysis 900ms after typing stops, or immediately on `.`, `?`, newline, or a paste event.
3. **Diffing**: before calling the backend, diff the current text against the last-analyzed version. Only the changed paragraph + one paragraph of surrounding context is sent, tagged with its offset — not the whole prompt every time.
4. **Cache**: hash each paragraph (e.g. SHA-1 of normalized text). If a paragraph's hash was analyzed before with no relevant context change, reuse the cached result instead of calling the LLM again.
5. **Two-tier model routing**:
   - **Fast pass** (Groq, Llama 3.3): cheap, quick pattern-level checks — vague adjectives ("good", "nice"), missing output format, no audience specified. Used for the live-typing underline pass.
   - **Deep pass** (Gemini Flash): full context-aware analysis — contradictions, missing constraints, hallucination-risk phrasing. Triggered on debounce-fire or explicit "Improve entire prompt".

### 5.2 Structured output contract
The LLM must return strict JSON — never prose — so the frontend can render underlines deterministically:

```json
{
  "issues": [
    {
      "span": { "start": 14, "end": 27 },
      "category": "vague_language",
      "severity": "yellow",
      "explanation": "\"good response\" doesn't specify tone, length, or what makes it good.",
      "suggestions": [
        "a concise, persuasive product description highlighting key benefits and differentiators",
        "a 3-sentence summary aimed at a technical buyer"
      ]
    }
  ],
  "overall_notes": "Missing target audience and output format."
}
```

Enforce this with: (a) a strict system prompt stating "respond with ONLY this JSON schema, no markdown fences, no commentary", (b) a JSON-schema validation step server-side with one retry on parse failure, (c) few-shot examples in the system prompt showing 2–3 correctly-tagged inputs/outputs.

### 5.3 Context injection (how "make it more technical" gets understood)
Each `/analyze` call sends:
- The current prompt text
- A short rolling summary of the last 2–3 turns in this session (not full history — token cost)
- Retrieved long-term memory: top-k relevant entries from the user's stored preferences/glossary via pgvector similarity search on the current prompt's embedding
- Active project context, if the user has tagged one (e.g. "AI voice-calling platform for businesses")

This keeps each request's token count controlled while still giving the model what it needs to resolve "the response" → their voice-calling project.

### 5.4 Category taxonomy to detect
Ambiguous instructions · missing context · conflicting/contradictory requirements · vague language · unclear objective · missing constraints · poor structure · redundant instructions · incorrect assumptions · missing output format · unspecified audience · unclear tone · hallucination-risk phrasing (e.g. "make up plausible numbers", "be creative with facts").

---

## 6. Highlighting & Replacement Mechanics

This is the highest-risk part of the build (see §2). Two cases:

**Case A — plain `<textarea>` or `<input>`:**
Straightforward. Use a mirrored, invisibly-positioned `<div>` with identical font/line-height/padding to compute exact pixel offsets for each character range, and draw underline `<span>` overlays on top. Replacement uses `setRangeText()` on the textarea directly.

**Case B — contenteditable rich editors (ChatGPT, Claude.ai use ProseMirror-style editors):**
- Cannot rely on raw character offsets alone — the DOM tree has nested nodes (paragraphs, formatting spans).
- Approach: walk the DOM with `document.createTreeWalker` to build a flat-text-to-DOM-node offset map every time content changes; use the `Range`/`Selection` API to both draw overlay decorations and perform replacements.
- Build one **adapter module per site** (ChatGPT adapter, Claude adapter, Gemini adapter) that knows that site's editor container selector and quirks, plus a **generic fallback adapter** using the TreeWalker approach for unknown sites.
- Expect to maintain these adapters over time as sites update their UI — isolate them behind a common interface (`getText()`, `getOffsetMap()`, `replaceRange()`) so a broken adapter doesn't take down the whole extension.

---

## 7. Model Strategy & Free-Tier Reality

| Provider | Free tier (typical, verify at signup) | Best for |
|---|---|---|
| **Google AI Studio (Gemini 2.0/2.5 Flash)** | ~10–30 RPM, up to ~1M token context, 500–1500 requests/day depending on model | Primary deep-analysis + full-prompt rewrite (frontier quality, generous context) |
| **Groq (Llama 3.3 70B)** | ~30 RPM, ~131K context, very low latency (~300 tok/s) | Fast triage pass for live-typing checks |
| **OpenRouter** | ~50 requests/day across free models | Backup/failover if Gemini or Groq rate-limits |

Notes to plan around:
- Free tiers **change without notice** and can rate-limit harder at peak times — build a provider-fallback chain (Gemini → Groq → OpenRouter) rather than hard-coding one.
- Most free tiers state that request data may be used to improve the provider's models. Since this tool will see real, possibly sensitive prompts, **surface this to users explicitly** in onboarding and offer a "don't send this project's prompts to third-party APIs" toggle (queues local-only heuristic checks instead, until Phase 2 adds local inference).

---

## 8. Memory Architecture

**Storage layers:**
1. **Session context** (in-memory, extension only): current prompt + last few turns. Never persisted.
2. **Long-term memory** (Supabase Postgres + pgvector): structured rows per user —
   - `preferences` (response format, tone, structuring habits)
   - `glossary` (recurring terminology/definitions)
   - `projects` (name, description, active constraints)
   - `corrections` (patterns the user has repeatedly accepted, used to auto-suggest similar fixes faster)
   Each row has an embedding column for semantic retrieval at analysis time.
3. **User control (required, not optional):** a Memory tab in the popup listing every stored item with edit/delete buttons, a "disable memory" master switch, and a "forget this project" action. Log nothing about memory writes without a visible entry the user can delete.

**Schema sketch:**
```sql
memories (
  id uuid primary key,
  user_id uuid references auth.users,
  project_id uuid null,
  kind text check (kind in ('preference','glossary','project','correction')),
  content text,
  embedding vector(768),
  created_at timestamptz default now(),
  last_used_at timestamptz
)
```

---

## 9. Backend & API Design

**Stack:** Supabase (Postgres + pgvector + Auth + Edge Functions, all free tier) — one platform instead of stitching together separate auth/db/hosting services.

**Endpoints:**
- `POST /analyze` — `{ text, changedSpan, sessionSummary, projectId }` → issue list (JSON contract in §5.2)
- `POST /improve-full` — `{ text, projectId }` → full rewritten prompt + rationale
- `GET/POST/DELETE /memory` — CRUD for the memory table, scoped to the authenticated user
- `POST /feedback` — `{ suggestionId, accepted: bool }` — used for the evaluation loop in §10

All endpoints require a Supabase auth JWT; the extension never talks to Gemini/Groq directly.

---

## 10. Evaluating "Did the Prompt Improve?"

Three signals, combined rather than relied on individually:
1. **Acceptance rate** — % of suggestions the user actually clicks vs. dismisses. This is your ground-truth signal over time; low acceptance on a category means that detector needs tuning.
2. **LLM-as-judge rubric** — before/after each accepted "Improve entire prompt", score both versions on a fixed rubric (specificity, output-format clarity, audience clarity, internal consistency) using the same model, and log the delta. Useful for regression testing when you change prompts.
3. **Downstream outcome (optional, later)** — if the user pastes the improved prompt into ChatGPT/Claude and it's visible in the page, you could (with explicit consent only) sample whether output length/structure matches the requested format. This is privacy-sensitive — treat as opt-in only, not default.

---

## 11. Security & Privacy

- LLM API keys live only in the backend; extension never receives them.
- Prompts are sent server-side only for analysis, never stored beyond what's needed for the current request unless the user's memory settings explicitly opt them into "learn from this."
- Explicit onboarding disclosure that free-tier LLM providers may use request content to improve their models; provide the local-heuristic-only fallback toggle for sensitive projects.
- Memory is fully visible/editable/deletable by the user at all times — no silent writes.
- Rate-limit per user server-side to prevent one user's runaway usage from exhausting your shared free-tier quota.
- Minimal host permissions in the manifest — request access to specific chat-site domains plus an "add a site" flow, not blanket `<all_urls>`, to keep Chrome Web Store review friction low and reduce the trust ask to users.

---

## 12. Roadmap

**Phase 1 — MVP (weeks 1–4)**
- Week 1: Extension skeleton (Manifest V3, content script injection, one working adapter — pick ChatGPT first since it's most-used), Supabase project + auth
- Week 2: Fast-pass analysis (Groq) + underline overlay for plain textarea sites; debounce/diff/cache logic
- Week 3: Contenteditable adapter for ChatGPT + Claude.ai; deep-pass analysis (Gemini) wired to `/analyze`; tooltip + replace UX
- Week 4: Memory CRUD UI, "Improve entire prompt" flow, onboarding + privacy disclosures, internal dogfooding

**Phase 2 (post-MVP)**
- Gemini/Perplexity adapters, provider fallback chain, feedback-driven evaluation dashboard, local-heuristic privacy mode (regex/rule-based checks with no network call, for the "don't send this project" toggle)

**Phase 3**
- Local/offline model option (transformers.js/WebLLM) for users who want zero cloud calls
- Windows desktop app — recommend **Tauri** over Electron (much smaller binaries, Rust backend, still lets you reuse the web UI/overlay logic you already built) once the extension's core detection/suggestion engine is proven
- Lightweight fine-tuned classifier to replace some LLM calls for common categories (cuts cost/latency further)
- Team/shared memory, prompt version history & analytics

---

## 13. What I Need From You

1. **A Google AI Studio API key** (free, no card) — https://aistudio.google.com
2. **A Groq API key** (free) — https://console.groq.com
3. **A Supabase account/project** (free tier) — https://supabase.com
4. **A product name** if "Inpromptu" isn't it, for the manifest/branding
5. **Priority order for site adapters** — my default assumption is ChatGPT → Claude.ai → Gemini → Perplexity; tell me if that should change
6. **A decision on the privacy disclosure wording/tone** before I draft onboarding copy, since it directly affects user trust

Once you confirm these (or hand the API keys to whichever coding agent builds this), the Phase 1 milestones in §12 are ready to hand off as build tickets — each week's scope is small enough to implement and test independently before moving to the next.