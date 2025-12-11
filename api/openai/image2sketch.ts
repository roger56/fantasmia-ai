// /api/openai/image2sketch.ts

import type { NextApiRequest, NextApiResponse } from "next";

// --- Tipi per la risposta di Replicate ---
type ReplicateStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

interface ReplicatePredictionResponse {
  id: string;
  status: ReplicateStatus;
  output?: string | string[];
  error?: any;
}

// --- Helper CORS molto semplice ---
function applyCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // se vuoi, limita ai tuoi domini
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS,PUT,DELETE"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Requested-With"
  );
}

// --- Converte una URL immagine in dataURL base64 ---
async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const contentType = res.headers.get("content-type");
  let mimeType = "image/png";

  if (contentType && contentType.startsWith("image/")) {
    mimeType = contentType;
  } else if (imageUrl.endsWith(".jpg") || imageUrl.endsWith(".jpeg")) {
    mimeType = "image/jpeg";
  }

  return `data:${mimeType};base64,${base64}`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  applyCors(res);

  // Gestione preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests are allowed" });
  }

  const { imageUrl } = req.body || {};

  if (!imageUrl || typeof imageUrl !== "string") {
    return res
      .status(400)
      .json({ error: 'Missing or invalid "imageUrl" field in body' });
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!replicateToken) {
    return res
      .status(500)
      .json({ error: "Missing REPLICATE_API_TOKEN in environment variables" });
  }

  try {
    // STEP 1 – avvio prediction su Replicate
    const createRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${replicateToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version:
          "21e52f1f6fd34a90df69ef1c59efb6e7e96c9ce14b10b6df988675b011b5b3b0",
        input: { image: imageUrl },
      }),
    });

    const createData =
      (await createRes.json()) as ReplicatePredictionResponse | any;

    if (!createRes.ok) {
      return res.status(createRes.status).json({
        error: "Prediction failed to start",
        detail: createData,
      });
    }
console.log("REPLICATE ERROR:", createRes.status, createData);

    const predictionId = createData.id as string;
    if (!predictionId) {
      return res
        .status(500)
        .json({ error: "Missing prediction id in Replicate response" });
    }

    // STEP 2 – polling dello stato
    const maxWaitMs = 30000;
    const pollIntervalMs = 1000;
    let elapsed = 0;
    let outputUrl: string | null = null;

    while (elapsed < maxWaitMs) {
      const statusRes = await fetch(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        {
          headers: {
            Authorization: `Token ${replicateToken}`,
          },
        }
      );

      if (!statusRes.ok) {
        const errorData = await statusRes.json();
        return res.status(statusRes.status).json({
          error: "Failed to get prediction status",
          detail: errorData,
        });
      }

      const statusData =
        (await statusRes.json()) as ReplicatePredictionResponse;

      if (!statusData || typeof statusData.status !== "string") {
        return res.status(500).json({
          error: "Invalid status response from Replicate API",
          detail: statusData,
        });
      }

      if (statusData.status === "succeeded") {
        if (typeof statusData.output === "string") {
          outputUrl = statusData.output;
        } else if (
          Array.isArray(statusData.output) &&
          statusData.output.length > 0
        ) {
          outputUrl = statusData.output[0];
        }
        break;
      }

      if (statusData.status === "failed") {
        return res.status(500).json({
          error: "Sketch generation failed",
          detail: statusData.error || statusData,
        });
      }

      if (statusData.status === "canceled") {
        return res.status(500).json({
          error: "Sketch generation was canceled",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      elapsed += pollIntervalMs;
    }

    if (!outputUrl) {
      return res.status(500).json({
        error: "Sketch generation timed out",
        detail: `No output after ${maxWaitMs / 1000} seconds`,
      });
    }

    // STEP 3 – converte in base64
    const base64Image = await imageUrlToBase64(outputUrl);

    return res.status(200).json({
      success: true,
      base64: base64Image,
      message: "Sketch generated successfully",
    });
  } catch (err) {
    console.error("Error in image2sketch API:", err);
    const error = err as Error;
    return res.status(500).json({
      error: "Internal server error",
      detail: error.message,
    });
  }
}
