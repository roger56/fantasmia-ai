import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Body = { 
  theme?: string;
  style?: string;
};

export default async function handler(req: any, res: any) {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

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
    const theme = body.theme || "amore";
    const poetryStyle = body.style || "libera";

    if (!theme) {
      res.status(400).json({ error: "Missing 'theme' in body" });
      return;
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Sei un poeta italiano. Scrivi una poesia in italiano sul tema fornito.
Usa lo stile poetico richiesto. Massimo 15 righe.
Rispondi SOLO con la poesia, senza commenti aggiuntivi.`
        },
        { 
          role: "user", 
          content: `Tema: ${theme}, Stile: ${poetryStyle}` 
        },
      ],
      temperature: 0.8, // Più alto per creatività
      max_tokens: 500,
    });

    const output = completion.choices?.[0]?.message?.content?.trim() ?? "";

    res.status(200).json({ output_text: output });
  } catch (err: any) {
    console.error("poetry error:", err);
    res.status(500).json({ error: "Poetry generation failed", detail: String(err?.message || err) });
  }
}
