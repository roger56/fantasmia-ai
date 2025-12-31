import OpenAI from "openai";
import Cors from "cors";
import { NextApiRequest, NextApiResponse } from "next";

// ===== CORS (IDENTICO A image.ts) =====
const cors = Cors({
  origin: (origin, callback) => {
    const allowedDomains = [
      ".lovableproject.com",
      ".lovable.app",
      "fantasmia.it",
      "localhost",
    ];

    if (!origin || allowedDomains.some(d => origin.includes(d))) {
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
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== Tipi =====
type Body = {
  text?: string;
  duration?: number;
  fps?: number;
  resolution?: string;
  style?: string;
  camera?: string;
  lighting?: string;
  mood?: string;
  audio?: boolean;
  language?: "it" | "en";
  seed?: number;
};

const MAX_PROMPT_LENGTH = 1200;

// ===== Handler =====
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body as Body;
    let text = body.text?.trim() || "";

    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in body" });
    }

    if (text.length > MAX_PROMPT_LENGTH) {
      console.warn(`Video prompt too long (${text.length}), truncating`);
      text = text.substring(0, MAX_PROMPT_LENGTH);
    }

    const payload: any = {
      model: "sora-2",
      prompt: text,
      duration: body.duration ?? 8,
      fps: body.fps ?? 24,
      resolution: body.resolution ?? "1280x720",
      audio: body.audio ?? false,
      language: body.language ?? "it",
      seed: body.seed,
      style: body.style,
      camera: body.camera,
      lighting: body.lighting,
      mood: body.mood,
    };

    // rimuove undefined
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    console.log("🎬 Generating video with Sora 2", {
      prompt_length: text.length,
      duration: payload.duration,
      resolution: payload.resolution,
    });

    // === CHIAMATA DIRETTA API VIDEO ===
    const response = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI video error:", data);
      return res.status(response.status).json({
        error: "Video generation failed",
        detail: data,
      });
    }

    return res.status(200).json({
      job_id: data.id,
      status: data.status,
      prompt_length: text.length,
      note: "Video job created (async)",
    });

  } catch (err: any) {
    console.error("Video generation error:", err);
    return res.status(500).json({
      error: "Video generation failed",
      detail: String(err?.message || err),
    });
  }
}
