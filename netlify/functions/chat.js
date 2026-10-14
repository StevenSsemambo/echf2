// ── YoEcho AI Proxy — Netlify Function ───────────────────────────────────────
// Brain:    Google Gemini (free tier)  → primary
// Fallback: Groq                       → used if every Gemini model fails
//
// Model names retire often, so each provider has an ORDERED LIST of models:
//   • model missing / retired (404, 400)  → try the next model in the list
//   • rate limit (429), bad key (401/403),
//     timeout, 5xx, empty or blocked reply → give up on that provider and
//                                            move straight to the next one
//
// Frontend contract (unchanged):
//   POST { messages:[{role:"user"|"assistant", content}], system }
//   →    { text, provider, model }
//   On total failure → { error, status, details:[...] } so the browser console
//   shows exactly WHY (e.g. "Gemini gemini-3.8-flash HTTP 404 ...").
//
// Netlify env vars:
//   GEMINI_API_KEY     (required)  https://aistudio.google.com/apikey
//   GROQ_API_KEY       (required)  https://console.groq.com/keys
//   GEMINI_MODEL       (optional)  comma-separated list, overrides defaults
//   GROQ_MODEL         (optional)  comma-separated list, overrides defaults
//   GEMINI_TIMEOUT_MS  (optional)  per-attempt, default 6000
//   GROQ_TIMEOUT_MS    (optional)  per-attempt, default 4000
//   MAX_OUTPUT_TOKENS  (optional)  default 1500
//
// If you set GEMINI_MODEL / GROQ_MODEL in Netlify earlier, delete or update
// them — they override the defaults below.
//
// Check current names here when something stops working:
//   Gemini: https://ai.google.dev/gemini-api/docs/deprecations
//   Groq:   https://console.groq.com/docs/deprecations

const list = (v, fallback) =>
  (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback);

const GEMINI_MODELS = list(process.env.GEMINI_MODEL, [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash",
]);
const GROQ_MODELS = list(process.env.GROQ_MODEL, [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
]);

const GEMINI_TIMEOUT = Number(process.env.GEMINI_TIMEOUT_MS) || 6000;
const GROQ_TIMEOUT = Number(process.env.GROQ_TIMEOUT_MS) || 4000;
// Newer models spend part of this budget "thinking", so keep it generous.
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 1500;
const TEMPERATURE = 0.85;

// Stop trying more models once we're close to Netlify's ~10s function limit.
const TOTAL_BUDGET_MS = Number(process.env.TOTAL_BUDGET_MS) || 9000;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 500;
  }
}

// Model-level problems: try the next model in the same provider.
const isModelProblem = (s) => s === 404 || s === 400;

async function timedFetch(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new ProviderError("timed out", 504);
    throw new ProviderError(`network error: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

// Gemini roles: "user" / "model"; must start with "user"; merge repeats.
function toGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const text = String(m.content ?? "");
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n\n" + text;
    else out.push({ role, parts: [{ text }] });
  }
  if (out.length && out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: "[conversation continues]" }] });
  }
  return out;
}

async function callGemini(model, messages, system, capMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ProviderError("GEMINI_API_KEY not set", 401);

  const body = {
    contents: toGeminiContents(messages),
    generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: TEMPERATURE },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await timedFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    },
    Math.min(GEMINI_TIMEOUT, capMs)
  );

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new ProviderError(e?.error?.message || "request failed", res.status);
  }

  const data = await res.json();
  if (data.promptFeedback?.blockReason) {
    throw new ProviderError(`prompt blocked: ${data.promptFeedback.blockReason}`, 422);
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  // skip "thought" parts if the model returns them
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) {
    throw new ProviderError(`no text (${data.candidates?.[0]?.finishReason || "empty"})`, 502);
  }
  return text;
}

async function callGroq(model, messages, system, capMs) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new ProviderError("GROQ_API_KEY not set", 401);

  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const m of messages) {
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") });
  }

  const res = await timedFetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: msgs,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
    },
    Math.min(GROQ_TIMEOUT, capMs)
  );

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new ProviderError(e?.error?.message || "request failed", res.status);
  }

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    throw new ProviderError(`no text (${data.choices?.[0]?.finish_reason || "empty"})`, 502);
  }
  return text;
}

// Try each model of one provider. Returns { text, model } or throws the last error.
async function runProvider(name, models, fn, messages, system, started, details, statuses) {
  for (const model of models) {
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      details.push(`${name}: out of time budget, skipped remaining models`);
      statuses.push(504);
      return null;
    }
    try {
      const capMs = Math.max(1500, TOTAL_BUDGET_MS - (Date.now() - started) + 500);
      const text = await fn(model, messages, system, capMs);
      return { text, model };
    } catch (err) {
      const line = `${name} ${model} HTTP ${err.status}: ${String(err.message).slice(0, 160)}`;
      details.push(line);
      statuses.push(err.status);
      console.warn("[YoEcho]", line);
      if (isModelProblem(err.status)) continue; // retired/unknown model → next model
      return null; // rate limit, key, timeout, 5xx → leave this provider
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const { messages, system } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "messages array required" }) };
  }

  const started = Date.now();
  const details = [];
  const statuses = [];

  const providers = [
    ["Gemini", "gemini", GEMINI_MODELS, callGemini],
    ["Groq", "groq", GROQ_MODELS, callGroq],
  ];

  for (const [label, id, models, fn] of providers) {
    const r = await runProvider(label, models, fn, messages, system, started, details, statuses);
    if (r) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ text: r.text, provider: id, model: r.model }),
      };
    }
  }

  const rateLimited = statuses.includes(429);
  const status = rateLimited ? 429 : 503;
  console.error("[YoEcho] All providers failed:", JSON.stringify(details));
  return {
    statusCode: status,
    headers: HEADERS,
    body: JSON.stringify({
      error: rateLimited ? "Rate limit reached on AI providers" : "All AI providers unavailable",
      status,
      details,
    }),
  };
};
