// Vercel Serverless Function.
// Runs on the server, never in the user's browser — so the API key
// (set as an environment variable in the Vercel dashboard, NOT in this file)
// stays secret even though this code is public on GitHub.

// --- Basic in-memory rate limiter ---
// Resets when the serverless function cold-starts, so it's not perfect,
// but it stops the common case: someone hammering the endpoint in a loop.
const requestLog = new Map(); // ip -> [timestamps]
const RATE_LIMIT = 10;        // max requests per visitor per window (enough for repeated rephrase/email use)
const RATE_WINDOW_MS = 60_000; // per 1 minute

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT;
}

// --- Allowed origins ---
// Add your real Vercel/production domain(s) here once deployed.
// During local testing, requests with no origin header (e.g. curl) are allowed through,
// but browser requests from other websites will be blocked.
const ALLOWED_ORIGINS = [
  'https://wordsmith-rephrase.vercel.app',
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser requests (e.g. server-to-server) have no origin header
  return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
}

const MAX_INPUT_LENGTH = 3000; // characters

export default async function handler(req, res) {
  const origin = req.headers.origin;

  // CORS headers — tells browsers directly that only your domain may call this API.
  // This backs up the manual origin check below with browser-enforced blocking too.
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight requests (browsers send these automatically before the real POST)
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  // 1. Origin check — blocks other websites from calling your API and burning your quota
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // 2. Rate limit per IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — please slow down and try again in a minute.' });
  }

  // 3. Validate input
  const { mode, text } = req.body || {};
  if (!text || !mode) {
    return res.status(400).json({ error: 'Missing mode or text' });
  }
  if (typeof text !== 'string' || typeof mode !== 'string') {
    return res.status(400).json({ error: 'Invalid input type' });
  }
  if (!text.trim()) {
    return res.status(400).json({ error: 'Input cannot be empty' });
  }
  if (text.length > MAX_INPUT_LENGTH) {
    return res.status(400).json({ error: `Input too long — keep it under ${MAX_INPUT_LENGTH} characters.` });
  }
  if (!['rephrase', 'email', 'straightforward'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  const styleGuide = `Write like a real person, not an AI. Rules:
- Use natural, everyday professional English — how a normal competent colleague actually talks, not a formal letter.
- Avoid AI-sounding phrases and clichés entirely: no "I hope this message finds you well," "I wanted to reach out," "kindly," "at your earliest convenience," "please don't hesitate," "I would be most grateful," "furthermore," "moreover," "in order to," "let's dive in," "circle back," "touch base," or similar corporate-speak filler.
- Avoid overly balanced or symmetrical sentence structures (e.g. "not only X, but also Y") — real people write more unevenly than that.
- Don't over-hedge or over-qualify. Say things plainly and directly instead of softening everything.
- Keep sentences short. Vary sentence length like a real person would, don't make every sentence the same length and shape.
- No exclamation points unless the input itself is enthusiastic.
- Sound like a specific person wrote it, not a template.`;

  const system = mode === 'email'
    ? `${styleGuide}\nTurn the user's rough note into a complete, well-structured professional email (subject line + greeting + body + sign-off). Keep the body concise — 2-4 short sentences unless more detail is clearly needed. End the sign-off with exactly:\nRegards,\n[Your name]\nOutput only the email, nothing else.`
    : mode === 'straightforward'
    ? `${styleGuide}\nRewrite the user's rough sentence into one clear, plain, direct version — no fluff, no extra pleasantries, just the point stated cleanly in complete sentences. Output ONLY the rewritten sentence, nothing else.`
    : `${styleGuide}\nRewrite the user's rough sentence into 6 short, natural-sounding versions: Polite, Professional, Friendly, Concise, Formal, Assertive. Each should be 1 sentence where possible, 2 max. Keep the original meaning intact. Output ONLY:\nPolite: ...\nProfessional: ...\nFriendly: ...\nConcise: ...\nFormal: ...\nAssertive: ...`;

  try {
    const result = await callGemini(system, text);
    return res.status(200).json({ result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// --- Provider: Gemini (Google) ---
// Set GEMINI_API_KEY in Vercel project settings -> Environment Variables.
// Get a free key at https://aistudio.google.com/apikey (no card required).
async function callGemini(system, userText, attempt = 1) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set on server');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: userText }] }]
      })
    }
  );

  // Gemini's free tier occasionally returns 503 "high demand" — retry a couple times
  // with a short delay before giving up, instead of failing immediately.
  if (response.status === 503 && attempt < 3) {
    await new Promise(r => setTimeout(r, attempt * 800)); // 800ms, then 1600ms
    return callGemini(system, userText, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}
