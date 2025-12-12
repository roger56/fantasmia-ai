// /api/openai/image2sketch.ts
import type { NextApiRequest, NextApiResponse } from "next";

type ApiOk = { base64: string };
type ApiErr = { error: string; detail?: unknown };

// ✅ IMPORTANTISSIMO: alza il limite body per base64
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "12mb", // puoi scendere a 8mb se vuoi
    },
  },
};

function setCors(res: NextApiResponse) {
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

function extractOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  return null;
}

async function readRawAndJson(r: Response): Promise<{ raw: string; json: any | null }> {
  const raw = await r.text().catch(() => "");
  try {
    return { raw, json: raw ? JSON.parse(raw) : null };
  } catch {
    return { raw, json: null };
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiErr>,
) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST requests are allowed" });

  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!replicateToken) {
    return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN in env variables" });
  }

  const body = (req.body ?? {}) as Partial<{ imageUrl: unknown; imageBase64: unknown; storyId?: unknown }>;
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";

  if (!imageUrl && !imageBase64) {
    return res.status(422).json({
      error: 'Missing input: provide "imageUrl" (http/https) or "imageBase64" (dataURL)',
    });
  }

  // 1) Prepara input per Replicate
  let imageInput: string;

  try {
    if (imageBase64) {
      if (!isDataUrl(imageBase64)) {
        return res.status(422).json({
          error: 'Invalid "imageBase64": expected data URL like data:image/png;base64,...',
        });
      }
      imageInput = imageBase64;
    } else {
      if (imageUrl.startsWith("blob:")) {
        return res.status(422).json({
          error:
            'Invalid "imageUrl": received a browser-only blob: URL. Send "imageBase64" instead (data:image/...;base64,...)',
        });
      }

      // ✅ Se è dataURL lo accettiamo
      if (isDataUrl(imageUrl)) {
        imageInput = imageUrl;
      } else {
        // ✅ Se è URL pubblico, lo mandiamo DIRETTO a Replicate (meglio di dataURL)
        if (!/^https?:\/\//i.test(imageUrl)) {
          return res.status(422).json({
            error: 'Invalid "imageUrl": expected http/https URL (public) or a data URL',
          });
        }
        imageInput = imageUrl;

        // Se vuoi forzare dataURL solo quando Replicate non riesce a fetchare,
        // puoi fare fallback automatico in caso di errore (vedi sotto).
      }
    }
  } catch (e) {
    return res.status(500).json({ error: "Failed to prepare image input", detail: e instanceof Error ? e.message : e });
  }

  // 2) Create prediction
  const version = "21e52f1f6fd34a90df69ef1c59efb6e7e96c9ce14b10b6df988675b011b5b3b0";

  let predictionId = "";

  const createPrediction = async (img: string) => {
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
          image: img,
        },
      }),
    });

    const { raw, json } = await readRawAndJson(createRes);

    if (createRes.status !== 201 || !json?.id) {
      return {
        ok: false as const,
        status: createRes.status,
        raw,
        json,
      };
    }

    return {
      ok: true as const,
      id: String(json.id),
      raw,
      json,
    };
  };

  try {
    // Primo tentativo: come abbiamo deciso sopra (URL pubblico o dataURL)
    let created = await createPrediction(imageInput);

    // ✅ Fallback utile: se abbiamo usato URL e Replicate fallisce a fetcharlo,
    // riproviamo convertendo in dataURL lato server.
    if (!created.ok && imageInput.startsWith("http")) {
      const dataUrl = await fetchToDataUrl(imageInput);
      created = await createPrediction(dataUrl);
    }

    if (!created.ok) {
      // 👇 QUI finalmente vedi l’errore vero di Replicate
      return res.status(422).json({
        error: "Prediction failed to start",
        detail: {
          replicateStatus: created.status,
          replicateJson: created.json,
          replicateRaw: created.raw,
        },
      });
    }

    predictionId = created.id;
  } catch (e) {
    return res.status(500).json({
      error: "Failed to call Replicate (create prediction)",
      detail: e instanceof Error ? e.message : e,
    });
  }

  // 3) Polling
  const maxWaitMs = 60_000;
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

      const { json } = await readRawAndJson(statusRes);
      const status = json?.status as string | undefined;

      if (status === "succeeded") {
        outputUrl = extractOutputUrl(json?.output);
        break;
      }

      if (status === "failed" || status === "canceled") {
        return res.status(500).json({ error: "Sketch generation failed", detail: json });
      }

      await sleep(pollIntervalMs);
    }

    if (!outputUrl) return res.status(500).json({ error: "Sketch generation timed out" });
  } catch (e) {
    return res.status(500).json({
      error: "Failed to poll Replicate prediction",
      detail: e instanceof Error ? e.message : e,
    });
  }

  // 4) Output → base64
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
