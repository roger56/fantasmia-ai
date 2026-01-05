import Cors from "cors";
import type { NextApiRequest, NextApiResponse } from "next";

// ===== CORS (coerente col tuo stile) =====
const cors = Cors({
  origin: (origin, callback) => {
    const allowedDomains = [
      ".lovableproject.com",
      ".lovable.app",
      "fantasmia.it",
      "localhost",
    ];

    if (!origin || allowedDomains.some((d) => origin.includes(d))) {
      callback(null, true);
    } else {
      console.log("CORS blocked for origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

// ===== Middleware helper =====
function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
  return new Promise<void>((resolve, reject) => {
    fn(req, res, (result: any) => {
      if (result instanceof Error) return reject(result);
      resolve();
    });
  });
}

// ===== Tipi aggiornati =====
type Body = {
  text?: string;
  prompt?: string;
  seconds?: 4 | 8 | 12;
  size?: string;
  resolution?: string;
  style?: string;
  input_reference?: string;
};

const MAX_PROMPT_LENGTH = 1200;

function normalizeSeconds(x: any): 4 | 8 | 12 {
  const n = Number(x);
  if (n === 4) return 4;
  if (n === 12) return 12;
  return 8;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    let body: any = req.body;

    // Body può arrivare come stringa JSON
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    // Accetta sia "text" che "prompt"
    let text = ((body?.text || body?.prompt) ?? "").toString().trim();

    if (!text) {
      return res.status(400).json({
        error: "Missing 'text' in body",
        received_type: typeof req.body,
      });
    }

    if (text.length > MAX_PROMPT_LENGTH) {
      console.warn(`Video prompt too long (${text.length}), truncating`);
      text = text.substring(0, MAX_PROMPT_LENGTH);
    }

    // Costruisci payload con SOLO parametri previsti dal tuo schema /v1/videos
    const payload: Record<string, unknown> = {
      model: "sora-2",
      prompt: text,
      seconds: normalizeSeconds(body?.seconds),
      size: (body?.size ?? body?.resolution ?? "1280x720").toString(),
    };

    if (body?.style) payload.style = body.style;
    if (body?.input_reference) payload.input_reference = body.input_reference;

    console.log("🎬 Generating video with Sora 2", {
      prompt_length: text.length,
      seconds: payload.seconds,
      size: payload.size,
    });

    const response = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    let data: any = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { raw: rawText };
    }

    console.log("OPENAI videos status:", response.status);
    console.log("OPENAI videos raw:", rawText);

    if (!response.ok) {
      console.error("OpenAI video error:", data);
      return res.status(response.status).json({
        error: "Video generation failed",
        detail: data,
      });
    }

    if (!data?.id) {
      return res.status(502).json({
        error: "Video generation returned no job id",
        detail: data,
      });
    }

    return res.status(200).json({
      job_id: data.id,
      status: data.status ?? "unknown",
      prompt_length: text.length,
      note: "Video job created (async)",
      video_url: typeof data.video_url === "string" ? data.video_url : undefined,
    });
  } catch (err: any) {
    console.error("Video generation error:", err);
    return res.status(500).json({
      error: "Video generation failed",
      detail: String(err?.message || err),
    });
  }
}
