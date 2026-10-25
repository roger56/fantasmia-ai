import { NextApiRequest, NextApiResponse } from "next";
import Cors from "cors";
import OpenAI from "openai";

// ===== CORS (unificato: include anche lovable.dev) =====
const cors = Cors({
  origin: (origin, callback) => {
    // Permetti tutti i domini Lovable + domini personalizzati
    const allowedDomains = [
      '.lovableproject.com',
      '.lovable.app',
      'fantasmia.it',
      'www.fantasmia.it',
      'fantas-ia.it',
      'www.fantas-ia.it',
      'localhost',
      'fantasmia-web-',
      'fantasmia-web.vercel.app',
        'fantasmia.it',
        'www.fantasmia.it',
      'fantasmia-5tcgfmiwp-rogers-projects-68a7bd87.vercel.app',
    ];

    if (!origin || allowedDomains.some((d) => origin.includes(d))) {
      callback(null, true);
    } else {
      console.log("CORS blocked for origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

// Middleware helper
function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

// OpenAI client
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Helpers
function pickMode(body: any): "improve" | "poetry" {
  // Nuovo: mode esplicito
  const mode = String(body?.mode || "").toLowerCase().trim();
  if (mode === "poetry") return "poetry";
  if (mode === "improve" || mode === "improve_text" || mode === "improve-text") return "improve";

  // Retro-compat: se c’è theme => poesia
  if (body?.theme) return "poetry";

  // Default: improve
  return "improve";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const mode = pickMode(body);

    // ===========================
    // MODE: IMPROVE TEXT (default)
    // ===========================
    if (mode === "improve") {
      // ✅ ACCETTA SIA 'text' (vecchio) CHE 'input_text' (nuovo)
      const { text, input_text, type, style } = body;

      const textToImprove = (input_text || text || "").toString();
      if (!textToImprove.trim()) {
        return res.status(400).json({ error: "Missing 'text' or 'input_text' in body" });
      }

      // ✅ USA style SE PRESENTE, ALTRIMENTI type
      const improvementType = (style || type || "general").toString();

      const prompt = `Migliora il seguente testo ${
        improvementType === "story" ? "narrativo" : "descrittivo"
      } mantenendo lo stile originale ma rendendolo più evocativo e coinvolgente:\n\n"${textToImprove}"`;

      const response = await client.responses.create({
        model: process.env.OPENAI_TEXT_MODEL || "gpt-6-luna",
        instructions:
          "Sei uno scrittore esperto. Migliora i testi mantenendo lo stile originale ma rendendoli più vividi ed emotivamente coinvolgenti.",
        input: prompt,
        max_output_tokens: 1000,
        reasoning: { effort: "none" },
        store: false,
      });

      const improvedText = response.output_text?.trim();
      if (!improvedText) throw new Error("No improved text generated");

      return res.status(200).json({
        mode: "improve",
        original: textToImprove,
        improved: improvedText,
        improvedText, // compat client
        type: improvementType,
      });
    }

    // ===========================
    // MODE: POETRY
    // ===========================
    if (mode === "poetry") {
      // Retro-compat: {theme, style}
      // Nuovo: {mode:"poetry", theme, style}
      const theme = (body.theme || body.text || body.input_text || "").toString();
      const style = (body.style || "lirica").toString();

      if (!theme.trim()) return res.status(400).json({ error: "Missing 'theme' in body" });

      const prompt = `Crea una poesia ${style} sul tema: "${theme}". 
La poesia deve essere in italiano, evocativa e suggestiva.`;

      const response = await client.responses.create({
        model: process.env.OPENAI_TEXT_MODEL || "gpt-6-luna",
        instructions:
          "Sei un poeta esperto. Crea poesie evocative e suggestive in italiano, mantenendo un tono poetico e ricco di immagini.",
        input: prompt,
        max_output_tokens: 500,
        reasoning: { effort: "none" },
        store: false,
      });

      const poetry = response.output_text?.trim();
      if (!poetry) throw new Error("No poetry generated");

      return res.status(200).json({
        mode: "poetry",
        theme,
        style,
        poetry,
      });
    }

    return res.status(400).json({ error: "Unknown mode" });
  } catch (err: any) {
    console.error("Improve/Poetry error:", err);
    return res.status(500).json({
      error: "Request failed",
      detail: err?.message || String(err),
    });
  }
}
