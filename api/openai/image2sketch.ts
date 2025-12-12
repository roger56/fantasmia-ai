// /api/openai/image2sketch.ts
import type { NextApiRequest, NextApiResponse } from "next";

type ReplicateCreateResponse = {
  id: string;
  status: string;
  urls?: { get?: string; cancel?: string };
  error?: unknown;
};

type ReplicateGetResponse = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown; // può essere string o array a seconda del modello
  error?: unknown;
};

type ApiOk = { base64: string };
type ApiErr = { error: string; detail?: unknown };

function setCors(res: NextApiResponse) {
  // Se vuoi restringere l’origine, sostituisci "*" con "https://<tuo-dominio>"
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isDataUrl(s: string) {
  return /^data:image\/(png|jpeg|jpg|webp);base64,/.test(s);
}

async function fetchToDataUrl(httpUrl: string): Promise<string> {
  const r = await fetch(httpUrl);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Impossibile scaricare l'immagine (${r.status}). ${txt}`);
  }
  const contentType = r.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await r.arrayBuffer());
  const b64 = buf.toString("base64");
  return `data:${contentType};base64,${b64}`;
}

/**
 * Estrae un output URL dal campo `output` di Replicate.
 * Alcuni modelli ritornano string, altri array di string.
 */
function extractOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  return null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiErr>,
) {
  setCors(res);

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests are allowed" });
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!replicateToken) {
    return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN in env variables" });
  }

  // Body: supporta sia imageUrl (pubblico) sia imageBase64 (dataURL)
  const body = (req.body ?? {}) as Partial<{ imageUrl: unknown; imageBase64: unknown }>;
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";

  if (!imageUrl && !imageBase64) {
    return res.status(422).json({
      error: 'Missing input: provide "imageUrl" (http/https) or "imageBase64" (dataURL)',
    });
  }

  // 1) Determina l’immagine da passare a Replicate
  let imageDataForReplicate: string;

  try {
    if (imageBase64) {
      // Deve essere un dataURL
      if (!isDataUrl(imageBase64)) {
        return res.status(422).json({
          error: 'Invalid "imageBase64": expected a data URL like data:image/png;base64,...',
        });
      }
      imageDataForReplicate = imageBase64;
    } else {
      // usa imageUrl
      if (imageUrl.startsWith("blob:")) {
        // Questo è il tuo caso tipico con IndexedDB + objectURL
        return res.status(422).json({
          error:
            'Invalid "imageUrl": received a browser-only blob: URL. Send "imageBase64" instead (data:image/...;base64,...)',
        });
      }

      if (!/^https?:\/\//i.test(imageUrl) && !isDataUrl(imageUrl)) {
        return res.status(422).json({
          error: 'Invalid "imageUrl": expected http/https URL (public) or a data URL',
        });
      }

      if (isDataUrl(imageUrl)) {
        imageDataForReplicate = imageUrl;
      } else {
        // http/https: opzionale ma consigliato convertirlo in dataURL per evitare problemi di fetch di Replicate
        imageDataForReplicate = await fetchToDataUrl(imageUrl);
      }
    }
  } catch (e) {
    return res.status(500).json({
      error: "Failed to prepare image input",
      detail: e instanceof Error ? e.message : e,
    });
  }

  // 2) Create prediction su Replicate
  // Version: quello che stavi usando tu (sketch-image)
  const version =
    "21e52f1f6fd34a90df69ef1c59efb6e7e96c9ce14b10b6df988675b011b5b3b0";

  let predictionId: string;

  try {
    const createRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${replicateToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        version,
        input: {
          image: imageDataForReplicate, // ✅ QUI: sempre dataURL, mai blob:
        },
      }),
    });

    const createData = (await createRes.json().catch(() => ({}))) as ReplicateCreateResponse;

    if (createRes.status !== 201 || !createData.id) {
      return res.status(422).json({
        error: "Prediction failed to start",
        detail: createData,
      });
    }

    predictionId = createData.id;
  } catch (e) {
    return res.status(500).json({
      error: "Failed to call Replicate (create prediction)",
      detail: e instanceof Error ? e.message : e,
    });
  }

  // 3) Polling fino a completamento
  const maxWaitMs = 60_000; // 60s (puoi aumentare)
  const pollIntervalMs = 1200;

  const start = Date.now();
  let outputUrl: string | null = null;

  try {
    while (Date.now() - start < maxWaitMs) {
      const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: {
          Authorization: `Token ${replicateToken}`,
          Accept: "application/json",
        },
      });

      const statusData = (await statusRes.json().catch(() => ({}))) as ReplicateGetResponse;

      if (statusData.status === "succeeded") {
        outputUrl = extractOutputUrl(statusData.output);
        break;
      }

      if (statusData.status === "failed" || statusData.status === "canceled") {
        return res.status(500).json({
          error: "Sketch generation failed",
          detail: statusData,
        });
      }

      await sleep(pollIntervalMs);
    }

    if (!outputUrl) {
      return res.status(500).json({ error: "Sketch generation timed out" });
    }
  } catch (e) {
    return res.status(500).json({
      error: "Failed to poll Replicate prediction",
      detail: e instanceof Error ? e.message : e,
    });
  }

  // 4) Converti output in base64 (dataURL) e restituisci
  try {
    const base64 = await fetchToDataUrl(outputUrl);
    return res.status(200).json({ base64 });
  } catch (e) {
    return res.status(500).json({
      error: "Failed to convert output image to base64",
      detail: e instanceof Error ? e.message : e,
    });
  }
}
