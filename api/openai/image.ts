import OpenAI from "openai";
// subito sotto gli import


const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Body = {
  prompt?: string;
  style?: "comic" | "photographic" | "abstract" | "manga" | "watercolor" | "charcoal";
  size?: "512x512" | "1024x1024";
};

export default async function handler(req: any, res: any) {
 const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// dentro la funzione handler, come prima cosa:
if (req.method === "OPTIONS") {
  res.writeHead(200, CORS_HEADERS);
  res.end();
  return;
}
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body: Body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { prompt = "", style = "comic", size = "1024x1024" } = body;

    if (!prompt) {
      res.status(400).json({ error: "Missing 'prompt' in body" });
      return;
    }

    // Prompt: vietiamo testo nei disegni
    const styledPrompt = `${prompt}. IMPORTANT: The image must not include any text or letters. Style: ${style}`;

    const result = await client.images.generate({
      model: "gpt-image-1",
      prompt: styledPrompt,
      size,
    });

    const url = result.data?.[0]?.url || "";
    if (!url) {
      res.status(500).json({ error: "Image generation failed" });
      return;
    }

    res.status(200).json({ url });
  } catch (err: any) {
    console.error("image error:", err);
    res.status(500).json({ error: "Image failed", detail: String(err?.message || err) });
  }
}
