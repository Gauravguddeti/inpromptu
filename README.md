# PromptCoach 🧠

> **Grammarly for AI Prompts** — a browser extension that makes you a better AI user, in real-time.

PromptCoach overlays a Grammarly-style analysis layer on top of every major AI chat interface (ChatGPT, Claude, Gemini, Perplexity). As you type a prompt, it:

- 🔴 **Underlines issues** — ambiguous phrasing, missing context, vague output format requests
- 💡 **Shows hover tooltips** — explains each issue + 2 ranked rewrite suggestions
- ✅ **Click-to-fix** — apply a suggestion for just that span, or improve the whole prompt
- 🧠 **Conversation context** — scans your chat history so suggestions are relevant to what you've already discussed
- 🔵 **In-page scan button** — appears inside the chatbar on every AI site (like Grammarly's icon)

---

## ✨ Features

| Feature | Status |
|---|---|
| Real-time prompt analysis (debounced 900ms) | ✅ Live |
| Red/Yellow/Blue severity underlines | ✅ Live |
| Hover tooltips with suggestions | ✅ Live |
| Click-to-replace span | ✅ Live |
| Improve entire prompt | ✅ Live |
| Conversation context scan (Claude, ChatGPT, Gemini) | ✅ Live |
| In-page scan button (Grammarly-style) | ✅ Live |
| User accounts + cloud memory | ✅ Live |
| Submit hook (auto-track prompts sent) | ✅ Live |

**Works on:** ChatGPT · Claude · Gemini · Perplexity

---

## 🏗️ Architecture

```
extension/          Chrome MV3 extension (Vite + React + TypeScript)
├── src/
│   ├── content/    Content script — overlay renderer, debounce engine, scan button
│   ├── popup/      Extension popup — Settings, Context, Memory, Account tabs
│   ├── adapters/   Site-specific DOM adapters (ChatGPT, Claude, Gemini, generic)
│   └── background/ Service worker — relays LLM requests, manages auth

backend/            Node.js / Express API (TypeScript)
├── src/
│   ├── routes/     /analyze  /improve  /context  /feedback  /memory  /auth
│   └── lib/        Gemini LLM client, Supabase DB, auth helpers
```

**Tech stack:** TypeScript · React · Vite · Chrome MV3 · Express · Google Gemini · Supabase

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- Chrome (or any Chromium browser)
- A [Google Gemini API key](https://aistudio.google.com/)
- A [Supabase](https://supabase.com/) project (free tier works)

### 1. Clone
```bash
git clone https://github.com/YOUR_USERNAME/promptcoach.git
cd promptcoach
```

### 2. Backend
```bash
cd backend
cp .env.example .env   # fill in your keys
npm install
npm run dev            # starts on http://localhost:3001
```

**Required `.env` variables:**
```
GEMINI_API_KEY=your_gemini_key
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_key
JWT_SECRET=any_random_string
PORT=3001
```

### 3. Extension
```bash
cd extension
npm install
npm run build          # outputs to extension/dist/
```

### 4. Load in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist/` folder

### 5. Use it
1. Open ChatGPT, Claude, or Gemini
2. Click the **PromptCoach** icon in your toolbar
3. Hit **Scan Chat** in the Context tab to give PromptCoach awareness of your conversation
4. Start typing a prompt — issues appear as coloured underlines

---

## 🧩 How It Works

### Prompt Analysis
The content script debounces your typing (900ms idle or sentence-end punctuation), sends the text to the backend `/analyze` endpoint, and receives a list of issue spans with severity + suggestions. The overlay renderer draws coloured underlines on top of the editor using an SVG overlay synced to text positions.

### Conversation Context
Each AI site has a multi-strategy DOM scraper:
- **ChatGPT** — `[data-message-author-role]` attributes
- **Gemini** — `<user-query>` / `<model-response>` custom elements
- **Claude** — largest scrollable container (full history) with content heuristics

Scanned context is summarised by the LLM and stored in `localStorage`, then attached to every analysis request so suggestions stay relevant to the ongoing conversation.

### In-Page Scan Button
A `requestAnimationFrame`-tracked `position: fixed` button appears inside the chatbar on every supported site (Grammarly-style, bottom-right corner of the editor). States: 🔴 stale → ⚫ scanning → 🟢 fresh.

---

## 📁 Project Structure

```
promptcoach/
├── extension/
│   ├── src/
│   │   ├── adapters/         # ChatGPT, Claude, Gemini, Generic adapters
│   │   ├── content/          # Content script entry, overlay, debounce, scan button
│   │   ├── popup/            # React popup (Settings, Context, Memory, Account)
│   │   ├── background/       # Service worker
│   │   └── manifest.ts       # Chrome MV3 manifest
│   ├── vite.config.ts
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── routes/           # Express route handlers
│   │   └── lib/              # DB, LLM, auth helpers
│   ├── .env.example
│   └── package.json
├── PRD.md                    # Full product requirements doc
└── README.md
```

---

## 🔐 Privacy

- Prompt text is sent to **your own backend** (self-hosted), not any third party
- Conversation context summaries are stored in `localStorage` on the AI site — never sent without your explicit scan action
- Memory/preferences stored in your own Supabase instance
- No data is ever sold or shared

---

## 🛣️ Roadmap

- [ ] Undo/redo for applied suggestions (Ctrl+Z)
- [ ] Perplexity adapter
- [ ] Team/shared memory
- [ ] Extension store release (Chrome Web Store)
- [ ] Firefox support

---

## 📄 License

MIT — see [LICENSE](LICENSE)

---

<p align="center">Built with ☕ and way too many hours debugging Chrome extension message channels</p>
