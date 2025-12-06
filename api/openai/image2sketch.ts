// /api/openai/image2sketch.ts

import type { NextApiRequest, NextApiResponse } from 'next'

// Utility per convertire immagine URL in base64
async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  // Prova a capire il tipo MIME dall’estensione
  const mimeType = imageUrl.endsWith('.jpg') || imageUrl.endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png';

  return `data:${mimeType};base64,${base64}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests are allowed' });
  }

  const { imageUrl } = req.body;

  if (!imageUrl || typeof imageUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "imageUrl"' });
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!replicateToken) {
    return res.status(500).json({ error: 'Missing REPLICATE_API_TOKEN in env variables' });
  }

  try {
    // Step 1: Chiamata al modello sketch-image
    const predictionRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${replicateToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: "21e52f1f6fd34a90df69ef1c59efb6e7e96c9ce14b10b6df988675b011b5b3b0",
        input: { image: imageUrl }
      })
    });

    const prediction = await predictionRes.json();
    if (predictionRes.status !== 201) {
      return res.status(500).json({ error: 'Prediction failed to start', detail: prediction });
    }

    const predictionId = prediction.id;

    // Step 2: Polling fino a completamento
    const maxWait = 30000;
    const pollInterval = 1000;
    let outputUrl: string | null = null;
    let elapsed = 0;

    while (elapsed < maxWait) {
      const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { 'Authorization': `Token ${replicateToken}` }
      });

      const statusData = await statusRes.json();

      if (statusData.status === 'succeeded') {
        outputUrl = statusData.output;
        break;
      } else if (statusData.status === 'failed') {
        return res.status(500).json({ error: 'Sketch generation failed', detail: statusData });
      }

      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;
    }

    if (!outputUrl) {
      return res.status(500).json({ error: 'Sketch generation timed out' });
    }

    // Step 3: Convertiamo l'immagine finale in base64
    const base64Image = await imageUrlToBase64(outputUrl);

    return res.status(200).json({ base64: base64Image });

  } catch (err) {
    return res.status(500).json({ error: 'Internal error', detail: (err as Error).message });
  }
}
