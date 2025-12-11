// /api/openai/image2sketch.ts

import type { NextApiRequest, NextApiResponse } from "next";

// Tipo (semplice) per la risposta di stato di Replicate
type ReplicateStatusResponse = {
  id?: string;
  status: "starting" | "processing" | "succeeded" | "failed" | string;
  output?: string | string[];
  [key: string]: any;
};

// Utility per convertire immagine URL in base64
async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);

  if (!res.ok) {
    throw new Error(`Failed to download sketch image: ${res.status} ${res.statusText}`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  // Prova a ricavare il MIME type dall'header Content-Type,
  // se non disponibile usa l'estensione dell'URL come fallback
  const contentType = res.headers.get("content-type");
  let mimeType = "image/png";

  if (contentType) {
    mimeType = contentType.split(";")[0];
  } else if (imageUrl.endsWith(".jpg") || imageUrl.endsWith(".jpeg")) {
    mimeType = "image/jpeg";
  }

  return `data:${mimeType};base64,${base64}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests are allowed" });
  }

  const { imageUrl } = req.body;

  if (!imageUrl || typeof imageUrl !== "string") {
    return res.status(400).json({ error: 'Missing or invalid "imageUrl"' });
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!replicateToken) {
    return res
      .status(500)
      .json({ error: "Missing REPLICATE_API_TOKEN in environment variables" });
  }

  try {
    // Step 1: avvio della prediction su Replicate
    const predictionRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${replicateToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Versione del modello sketch / edge-detection che stai usando
        version: "21e52f1f6fd34a90df69ef1c59efb6e7e96c9ce14b10b6df988675b011b5b3b0",
        input: { image: imageUrl },
      }),
    });

    const prediction: any = await predictionRes.json();

    if (predictionRes.status !== 201) {
      return res
        .status(500)
        .json({ error: "Prediction failed to start", detail: prediction });
    }

    const predictionId: string | undefined = prediction.id;
    if (!predictionId) {
      return res
        .status(500)
        .json({ error: "Missing prediction id from Replicate response", detail: prediction });
    }

    // Step 2: Polling fino a completamento
    const maxWait = 30000; // 30 secondi
    const pollInterval = 1000;
    let outputUrl: string | null = null;
    let elapsed = 0;

    while (elapsed < maxWait) {
      const statusRes = await fetch(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        {
          headers: { Authorization: `Token ${replicateToken}` },
        }
      );

      const statusData = (await statusRes.json()) as ReplicateStatusResponse;

      if (statusData.status === "succeeded") {
        // output può essere string o array di string
        if (Array.isArray(statusData.output)) {
          outputUrl = statusData.output[0] ?? null;
        } else {
          outputUrl = statusData.output ?? null;
        }
        break;
      } else if (statusData.status === "failed") {
        return res
          .status(500)
          .json({ error: "Sketch generation failed", detail: statusData });
      }

      await new Promise((r) => setTimeout(r, pollInterval));
      elapsed += pollInterval;
    }

    if (!outputUrl) {
      return res.status(500).json({ error: "Sketch generation timed out" });
    }

    // Step 3: converte l'immagine finale in base64
    const base64Image = await imageUrlToBase64(outputUrl);

    return res.status(200).json({ base64: base64Image });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error during sketch generation";
    return res.status(500).json({ error: "Internal error", detail: message });
  }
}
