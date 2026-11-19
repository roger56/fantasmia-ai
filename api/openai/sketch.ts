/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE 5B-R2 / 2.1 — AI/api/openai/sketch.ts.
 * Solo osservatori di ingresso/errori; argomenti e risultati originali conservati. */
import {tracePoint as __fantasmiaTracePoint,withTrace as __fantasmiaWithTrace,withTraceRequest as __fantasmiaWithTraceRequest} from "../../lib/traceRuntime.js";
// apiopenaisketch.ts (o Daiproxytest.ts)
import type { NextApiRequest, NextApiResponse } from 'next'; // Per type safety in Vercel/Next.js

  async function handler(req: NextApiRequest, res: NextApiResponse) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sketch.ts","handler_L4_C1");

  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*'); // Configura in base alle origini consentite
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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
    return res.status(400).json({ error: 'Missing or invalid description field in body' });
  }

  // USA DIRETTAMENTE description COME PROMPT già formattato dal client
  const finalPrompt = description;

  // Controlla la lunghezza, aumenta il limite a 1000 per sicurezza
  if (finalPrompt.length > 1000) {
    return res.status(400).json({
      error: 'Description too long. Please shorten it to fit within prompt limits.',
      promptLength: finalPrompt.length
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
        prompt: finalPrompt, // USA DIRETTAMENTE
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json' // BASE64 per evitare CORS
      })
    });

    const data: any = await openaiRes.json();

    if (openaiRes.status !== 200) {
      return res.status(openaiRes.status).json({ error: data.error || 'Image generation failed' });
    }

    // RITORNA BASE64 come data URL
    const base64Image = data.data[0].b64_json;
    const imageDataUrl = `data:image/png;base64,${base64Image}`;

    return res.status(200).json({
      imageUrl: imageDataUrl,
      prompt: finalPrompt
    });
  } catch (error: any) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/sketch.ts","handler_L4_C1",true);

    return res.status(500).json({ error: `Failed to call OpenAI API, detail: ${error.message}` });
  }
}

export default __fantasmiaWithTrace("api/openai/sketch.ts",handler);
