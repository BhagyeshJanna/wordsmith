// Vercel Serverless Function.
// Runs on the server, never in the user's browser — so the API key
// (set as an environment variable in the Vercel dashboard, NOT in this file)
// stays secret even though this code is public on GitHub.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const { mode, text } = req.body || {};
  if (!text || !mode) {
    return res.status(400).json({ error: 'Missing mode or text' });
  }

  const system = mode === 'email'
    ? `Turn the user's rough note into a complete, well-structured professional email (subject line + greeting + body + sign-off). End the sign-off with exactly:\nRegards,\n[Your name]\nOutput only the email, nothing else.`
    : `Rewrite the user's rough sentence into 6 polished corporate versions: Polite, Professional, Friendly, Concise, Formal, Assertive. Keep the original meaning intact. Output ONLY:\nPolite: ...\nProfessional: ...\nFriendly: ...\nConcise: ...\nFormal: ...\nAssertive: ...`;

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
async function callGemini(system, userText) {
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

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}
