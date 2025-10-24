import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Body = { 
  text?: string; 
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
    const text = body.text || "";
    const style = body.style || "professional"; // Default a professional

    if (!text) {
      res.status(400).json({ error: "Missing 'text' in body" });
      return;
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Sei un assistente per il miglioramento del testo. 
Migliora il testo fornito dall'utente rendendolo più ${style} in italiano.
Mantieni il significato originale ma rendilo più chiaro, fluido e ben scritto.
Rispondi SOLO con il testo migliorato, senza commenti aggiuntivi.`
        },
        { 
          role: "user", 
          content: `Migliora questo testo in stile ${style}: "${text}"` 
        },
      ],
      temperature: 0.3, // Più basso per meno creatività
      max_tokens: 1000,
    });

    const output = completion.choices?.[0]?.message?.content?.trim() ?? "";

    res.status(200).json({ output_text: output });
  } catch (err: any) {
    console.error("improve error:", err);
    res.status(500).json({ error: "Text improvement failed", detail: String(err?.message || err) });
  }
}
