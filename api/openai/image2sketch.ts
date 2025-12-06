// /api/openai/image2sketch.ts

import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests are allowed' });
  }

  const { imageUrl } = req.body;

  if (!imageUrl || typeof imageUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid imageUrl' });
  }

  const replicateApiToken = process.env.REPLICATE_API_TOKEN;

  if (!replicateApiToken) {
    return res.status(500).json({ error: 'Missing REPLICATE_API_TOKEN in env variables' });
  }

  try {
    // Chiamata al modello "sketch-image"
    const predictionRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${replicateApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: "21e52f1f6fd34a90df69ef1c59efb6e7e96c9ce14b10b6df988675b011b5b3b0", // model version from replicate
        input: {
          image: imageUrl
        }
      })
    });

    const prediction = await predictionRes.json();

    if (predictionRes.status !== 201) {
      return res.status(500).json({ error: 'Failed to initiate prediction', detail: prediction });
    }

    const predictionId = prediction.id;

    // Attendere il completamento del job
    let outputUrl: string | null = null;
    const timeout = 30000; // max 30 sec
    const pollInterval = 1000;
    let waited = 0;

    while (waited < timeout) {
      const checkRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: {
          'Authorization': `Token ${replicateApiToken}`
        }
      });

      const statusData = await checkRes.json();

      if (statusData.status === 'succeeded') {
        outputUrl = statusData.output;
        break;
      } else if (statusData.status === 'failed') {
        return res.status(500).json({ error: 'Sketch generation failed', detail: statusData });
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
      waited += pollInterval;
    }

    if (!outputUrl) {
      return res.status(500).json({ error: 'Sketch generation timed out' });
    }

    return res.status(200).json({ sketchUrl: outputUrl });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error', detail: (err as Error).message });
  }
}
