import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Body = { 
  prompt?: string;
  style?: string;
};

// Mappatura degli stili con prompt ottimizzati
const STYLES = {
  fumetto: "in stile fumetto colorato, vivace, linee nette, personaggi cartoon",
  manga: "in stile manga giapponese, bianco e nero, tratti distintivi, espressioni drammatiche",
  acquarello: "acquerello, tratti morbidi, colori pastello, sfumature delicate",
  fotografico: "fotorealistico, alta definizione, illuminazione naturale, dettagli precisi",
  carboncino: "disegno a carboncino, sfumature di grigio, tratti espressivi, stile artistico classico",
  astratto: "arte astratta, forme geometriche, colori vibranti, composizione non figurativa"
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
    const prompt = body.prompt || "";
    const style = body.style || "fotografico";

    if (!prompt) {
      res.status(400).json({ error: "Missing 'prompt' in body" });
      return;
    }

    // Verifica che lo stile sia valido
    const validStyles = Object.keys(STYLES);
    if (!validStyles.includes(style)) {
      res.status(400).json({ 
        error: "Invalid style", 
        valid_styles: validStyles 
      });
      return;
    }

    // Costruisci il prompt finale per DALL-E
    const styleDescription = STYLES[style as keyof typeof STYLES];
    const finalPrompt = `${prompt}, ${styleDescription}, senza testo, nessuna scrittura, nessuna parola`;

    console.log(`Generating image with style: ${style}, prompt: ${prompt}`);

    const response = await client.images.generate({
      model: "dall-e-3",
      prompt: finalPrompt,
      n: 1,
      size: "1024x1024", // DALL-E 3 supporta solo 1024x1024, 1792x1024, 1024x1792
      quality: "standard", // o "hd" per qualità superiore
      style: "vivid", // "vivid" o "natural"
    });

    const imageUrl = response.data[0]?.url;

    if (!imageUrl) {
      throw new Error("No image URL returned from OpenAI");
    }

    res.status(200).json({ 
      image_url: imageUrl,
      style: style,
      prompt: prompt
    });

  } catch (err: any) {
    console.error("Image generation error:", err);
    
    // Gestione errori specifici di OpenAI
    if (err?.error?.code === "content_policy_violation") {
      res.status(400).json({ 
        error: "Content policy violation", 
        detail: "The prompt was rejected by the safety system. Please try a different prompt."
      });
    } else {
      res.status(500).json({ 
        error: "Image generation failed", 
        detail: String(err?.message || err) 
      });
    }
  }
}
