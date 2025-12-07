// File: /api/openai/sketch.js

export default async function handler(req, res) {
// File: /api/openai/sketch.js

  // ✅ AGGIUNGI CORS HEADERS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // ✅ GESTISCI PREFLIGHT OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests are allowed' });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests are allowed' });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Missing OpenAI API key in environment variables' });
  }

  const { description } = req.body;

  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "description" field in body' });
  }

  // Costruiamo il prompt base per un disegno da colorare
  const basePrompt = `A black and white line drawing suitable for a 6-year-old child to color. The scene features: ${description}. The drawing should be clear, simple, and fun to color.`;

  // Controlla la lunghezza (limite consigliato: 1000 caratteri)
  if (basePrompt.length > 1000) {
    return res.status(400).json({
      error: 'Description too long. Please shorten it to fit within prompt limits.',
      promptLength: basePrompt.length
    });
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: basePrompt,
        n: 1,
        size: '1024x1024',
        response_format: 'url'
      })
    });

    const data = await openaiRes.json();

    if (openaiRes.status !== 200) {
      return res.status(openaiRes.status).json({ error: data.error || 'Image generation failed' });
    }

    return res.status(200).json({
      imageUrl: data.data[0].url,
      prompt: basePrompt
    });

  } catch (error) {
    return res.status(500).json({ error: 'Failed to call OpenAI API', detail: error.message });
  }
}
