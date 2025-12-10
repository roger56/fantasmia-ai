// /api/openai/image2sketch.ts - Versione con type guard
import Cors from 'cors';
// CONFIGURAZIONE CORS DINAMICA - PER TUTTI I DOMINI LOVABLE
const cors = Cors({
  origin: (origin, callback) => {
    // Permetti tutti i domini Lovable + domini personalizzati
    const allowedDomains = [
      '.lovableproject.com',
      '.lovable.app',
      'fantasmia.it',
      'localhost'
    ];
    
    if (!origin || allowedDomains.some(domain => origin.includes(domain))) {
      callback(null, true);
    } else {
      console.log('CORS blocked for origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
});
import type { NextApiRequest, NextApiResponse } from 'next'

// Definiamo i tipi per le risposte di Replicate
interface ReplicatePredictionResponse {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[];
  error?: any;
}

// Type guard per verificare se un oggetto è un ReplicatePredictionResponse
function isReplicatePredictionResponse(obj: any): obj is ReplicatePredictionResponse {
  return obj && 
         typeof obj.id === 'string' && 
         typeof obj.status === 'string' &&
         ['starting', 'processing', 'succeeded', 'failed', 'canceled'].includes(obj.status);
}

// Utility per convertire immagine URL in base64
async function imageUrlToBase64(imageUrl: string): Promise<string> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
    }
    
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    // Determina il tipo MIME dal content-type o dall'estensione
    const contentType = res.headers.get('content-type');
    let mimeType = 'image/png'; // default
    
    if (contentType && contentType.startsWith('image/')) {
      mimeType = contentType;
    } else if (imageUrl.endsWith('.jpg') || imageUrl.endsWith('.jpeg')) {
      mimeType = 'image/jpeg';
    }

    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error('Error converting image to base64:', error);
    throw error;
  }
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

    if (!predictionRes.ok) {
      const errorData = await predictionRes.json();
      return res.status(predictionRes.status).json({ 
        error: 'Failed to start prediction', 
        detail: errorData 
      });
    }

    const predictionData = await predictionRes.json();
    
    if (!isReplicatePredictionResponse(predictionData)) {
      return res.status(500).json({ 
        error: 'Invalid response from Replicate API'
      });
    }

    const predictionId = predictionData.id;

    // Step 2: Polling fino a completamento
    const maxWait = 30000; // 30 secondi
    const pollInterval = 1000; // 1 secondo
    let outputUrl: string | null = null;
    let elapsed = 0;

    while (elapsed < maxWait) {
      const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { 'Authorization': `Token ${replicateToken}` }
      });

      if (!statusRes.ok) {
        const errorData = await statusRes.json();
        return res.status(statusRes.status).json({ 
          error: 'Failed to get prediction status',
          detail: errorData
        });
      }

      const statusData = await statusRes.json();
      
      if (!isReplicatePredictionResponse(statusData)) {
        return res.status(500).json({ 
          error: 'Invalid status response from Replicate API'
        });
      }

      if (statusData.status === 'succeeded') {
        // L'output può essere una stringa o un array di stringhe
        if (typeof statusData.output === 'string') {
          outputUrl = statusData.output;
        } else if (Array.isArray(statusData.output) && statusData.output.length > 0) {
          outputUrl = statusData.output[0];
        } else if (statusData.output) {
          console.warn('Unexpected output format:', statusData.output);
        }
        break;
      } else if (statusData.status === 'failed') {
        return res.status(500).json({ 
          error: 'Sketch generation failed', 
          detail: statusData.error || statusData
        });
      } else if (statusData.status === 'canceled') {
        return res.status(500).json({ 
          error: 'Sketch generation was canceled'
        });
      }

      // Attendi prima del prossimo poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    if (!outputUrl) {
      return res.status(500).json({ 
        error: 'Sketch generation timed out',
        detail: `No output after ${maxWait / 1000} seconds`
      });
    }

    // Step 3: Convertiamo l'immagine finale in base64
    const base64Image = await imageUrlToBase64(outputUrl);

    return res.status(200).json({ 
      success: true,
      base64: base64Image,
      message: 'Sketch generated successfully'
    });

  } catch (err) {
    console.error('Error in image2sketch API:', err);
    
    const error = err as Error;
    return res.status(500).json({ 
      error: 'Internal server error',
      detail: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
