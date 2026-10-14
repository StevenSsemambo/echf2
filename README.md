# YoEcho — Netlify PWA Deployment Guide

## What's Inside This Package

```
yoecho-netlify/
├── public/                  ← Everything Netlify serves to users
│   ├── index.html           ← App entry point (PWA shell)
│   ├── app.jsx              ← Your full YoEcho app (modified)
│   ├── manifest.json        ← PWA manifest (install to home screen)
│   ├── sw.js                ← Service worker (offline support)
│   └── icons/               ← App icons
│       ├── icon-192.png
│       └── icon-512.png
├── netlify/
│   └── functions/
│       ├── chat.js          ← AI proxy: Gemini + Groq fallback (hides your keys)
│       └── db.js            ← Supabase sync proxy
├── netlify.toml             ← Netlify build config
└── README.md                ← This file
```

## AI Setup — Gemini (brain) + Groq (fallback)

`netlify/functions/chat.js` tries **Gemini** first. If Gemini fails, it falls back to **Groq**.
Each provider has an ordered list of models, because model names get retired often:

| Situation | What happens |
|-----------|--------------|
| Model retired / not found (404, 400) | Try the next model in that provider's list |
| Rate limit (429), bad key, timeout, 5xx, blocked/empty reply | Move to the next provider |
| Everything fails | Returns 503 (or 429) and the browser console prints the real reason |

Default models: Gemini `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-flash-latest` → `gemini-2.5-flash`;
Groq `openai/gpt-oss-120b` → `openai/gpt-oss-20b`.

### Keys
1. Gemini: https://aistudio.google.com/apikey  (no billing needed for the free tier)
2. Groq: https://console.groq.com/keys

### Netlify environment variables
| Name | Required | Notes |
|------|----------|-------|
| `GEMINI_API_KEY` | yes | |
| `GROQ_API_KEY` | yes | |
| `GEMINI_MODEL` | no | Comma-separated list, overrides defaults. Delete old values! |
| `GROQ_MODEL` | no | Comma-separated list, overrides defaults. Delete old values! |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | for cloud sync | used by `netlify/functions/db.js` |

Remove the old `OPENROUTER_API_KEY` — it is no longer used.
Environment variables only take effect after a **new deploy**.

### When a model stops working
Model names change. Check https://ai.google.dev/gemini-api/docs/deprecations and
https://console.groq.com/docs/deprecations, then update `GEMINI_MODEL` / `GROQ_MODEL` in Netlify and redeploy.
Open the browser console: a failure prints lines like `Gemini gemini-3.8-flash HTTP 404: ...`,
and a success prints `reply via gemini (model-name)`. The chat header also shows `AI · GEMINI` or `AI · GROQ`.

### Privacy note
Google's free Gemini tier may use prompts and replies to improve its models. YoEcho handles
personal journals and reflections, so tell users, or use a paid key before a public launch.

## Step-by-Step: Deploy to Netlify

### Step 1 — Upload Your Project
**Option A — Drag & Drop (easiest):**
1. Go to **https://app.netlify.com**
2. Sign up / log in (free)
3. Drag the entire `yoecho-netlify` folder onto the Netlify dashboard
4. Netlify auto-detects `netlify.toml` and deploys

**Option B — GitHub (recommended for updates):**
1. Push this folder to a GitHub repo
2. In Netlify: **"Add new site" → "Import from Git"**
3. Connect your GitHub and select the repo
4. Build settings are auto-read from `netlify.toml`
5. Click **Deploy**

### Step 2 — Add Your API Key (CRITICAL)
This is how Netlify keeps your key secret from users:

1. In Netlify, go to your site dashboard
2. Click **"Site configuration"** (left sidebar)
3. Click **"Environment variables"**
4. Click **"Add a variable"**
5. Fill in:
   - **Key:** `OPENROUTER_API_KEY`
   - **Value:** `sk-or-v1-your-copied-key-here`
6. Click **Save**
7. Go to **Deploys** → click **"Trigger deploy"** → **"Deploy site"**
   (Environment variables only take effect after a new deploy)

### Step 3 — Test Your Deployment
1. Open your Netlify URL (e.g. `https://amazing-name-12345.netlify.app`)
2. The app should load with the amber/gold YoEcho interface
3. Type a message and wait for a response from Gemma 3 27B
4. If it responds ✅ — you're live!

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| App loads but AI doesn't respond | Check `GEMINI_API_KEY` and `GROQ_API_KEY` are set, redeploy, then read the console error |
| "Function not found" error | Make sure `netlify/functions/chat.js` is in the right folder |
| Responses are slow | Normal for free models — Gemma 3 27B may take 5-15 seconds |
| Rate limit error | Free models have limits. Wait a few minutes and try again |
| Storage not saving | Check browser allows localStorage (disable incognito or restrictions) |

---

## Update the Netlify Function URL (optional)

Open `netlify/functions/chat.js` and update line:
```js
"HTTP-Referer": "https://yoecho.netlify.app",
```
Replace with your actual Netlify URL after deployment.

---

## Installing as a PWA (Add to Home Screen)

**On Android (Chrome):**
1. Open the app in Chrome
2. Tap the 3-dot menu → "Add to Home screen"
3. Tap "Add"

**On iPhone (Safari):**
1. Open the app in Safari
2. Tap the Share icon (box with arrow)
3. Scroll down → "Add to Home Screen"
4. Tap "Add"

The app will now appear on your home screen like a native app!

---

## Built by Steven Sema — SayMyTech Developers, Kampala Uganda
