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
    const result = await callAnthropic(system, text);
    return res.status(200).json({ result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function callAnthropic(system, userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set on server');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: userText }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return (data.content || []).map(b => b.text || '').join('');
}
