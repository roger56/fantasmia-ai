import Cors from "cors";
import { NextApiRequest, NextApiResponse } from "next";

// CONFIGURAZIONE CORS DINAMICA - PER TUTTI I DOMINI LOVABLE (come image.ts)
const cors = Cors({
  origin: (origin, callback) => {
    const allowedDomains = [
      ".lovableproject.com",
      ".lovable.app",
      "fantasmia.it",
      "localhost",
    ];

    if (!origin || allowedDomains.some((domain) => origin.includes(domain))) {
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

// Helper per eseguire il middleware
function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

// ===== Tipi aggiornati =====
type Body = {
  text?: string;
  prompt?: string; // accetta anche prompt per compatibilità client
  seconds?: 4 | 8 | 12;
  size?: string;        // es. "1280x720"
  resolution?: string;  // alias
  style?: string;
  input_reference?: string;
};

const MAX_PROMPT_LENGTH = 1200;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS per primo
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Body robusto: può arrivare come stringa JSON
    let body: any = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
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

    // Payload SOLO con parametri previsti dal tuo schema /v1/videos
    const payload: Record<string, unknown> = {
      model: "sora-2",
      prompt: text,
      seconds: (body.seconds ?? 8) as 4 | 8 | 12,
      size: body.size ?? body.resolution ?? body.size ?? "1280x720",
    };

    if (body.style) payload.style = body.style;
    if (body.input_reference) payload.input_reference = body.input_reference;

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

    const raw: unknown = await response.json();
    const data = typeof raw === "object" && raw !== null ? (raw as any) : {};

    if (!response.ok) {
      console.error("OpenAI video error:", data);
      return res.status(response.status).json({
        error: "Video generation failed",
        detail: data,
      });
    }

    if (!data.id) {
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
