import OpenAI from "openai";
import Cors from 'cors';
import { NextApiRequest, NextApiResponse } from 'next';

// Inizializza il middleware CORS
const cors = Cors({
  origin: [
    'https://id-preview--61f56c03-2d55-460b-9514-3ce772cd7cd0.lovable.app',
    'https://6lf56c03-2655-460b-9514-3ce77cd7cd0.lovableproject.com',
    'https://*.lovable.app',
    'https://*.lovableproject.com'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

// Helper per eseguire il middleware
function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Body = {
  prompt?: string;
  style?: string;
};

// Mappatura degli stili con prompt ottimizzati
const STYLES = {
  fumetto: "fumetto colorato, vivace, linee nette, cartoon",
  manga: "manga giapponese, bianco e nero, tratti distintivi, drammatico",
  acquarello: "acquerello, tratti morbidi, colori pastello, sfumature",
  fotografico: "fotorealistico, alta definizione, illuminazione naturale",
  carboncino: "carboncino, sfumature di grigio, tratti espressivi, artistico",
  astratto: "arte astratta, forme geometriche, colori vibranti"
};

// Prompt anti-testo ottimizzato
const ANTI_TEXT_PROMPT = "Nessun testo, nessuna scritta, nessuna parola, carattere o simbolo alfabetico";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Esegui il middleware CORS
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body as Body;
    
    let prompt = body.prompt || "";
    const style = body.style || "fotografico";

    if (!prompt) {
      return res.status(400).json({ error: "Missing 'prompt' in body" });
    }

    // Verifica che lo stile sia valido
    const validStyles = Object.keys(STYLES);
    if (!validStyles.includes(style)) {
      return res.status(400).json({
        error: "Invalid style",
        valid_styles: validStyles
      });
    }

    // 1. PULIZIA E RIDUZIONE DEL PROMPT
    prompt = prompt
      .replace(/scritta|testo|parola|scrivere|leggere|lettere|alfabeto|frase|didascalia|sottotitolo/gi, '')
      .replace(/["][^"]*["]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 2. TRONCAMENTO INTELLIGENTE (max 600 caratteri per il prompt utente)
    const MAX_USER_PROMPT_LENGTH = 600;
    if (prompt.length > MAX_USER_PROMPT_LENGTH) {
      console.warn(`Prompt too long (${prompt.length} chars), truncating to ${MAX_USER_PROMPT_LENGTH}`);
      prompt = prompt.substring(0, MAX_USER_PROMPT_LENGTH) + "...";
    }

    // 3. COSTRUZIONE PROMPT FINALE CON CONTROLLO LUNGHEZZA
    const styleDescription = STYLES[style as keyof typeof STYLES];
    let finalPrompt = `${prompt}. ${styleDescription}. ${ANTI_TEXT_PROMPT}`;

    if (finalPrompt.length > 800) {
      console.warn(`Final prompt too long (${finalPrompt.length} chars), optimizing...`);
      finalPrompt = `${prompt.substring(0, 400)}. ${styleDescription}. ${ANTI_TEXT_PROMPT}`;
    }

    console.log(`Generating image - Style: ${style}, Prompt length: ${prompt.length}, Final length: ${finalPrompt.length}`);

    // 4. GENERAZIONE IMMAGINE - FORMATO BASE64 OBBLIGATORIO
    const response = await client.images.generate({
      model: "dall-e-3",
      prompt: finalPrompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      style: "vivid",
      response_format: "b64_json" // ← QUESTA È LA CHIAVE!
    });

    // Controllo per i dati base64
    const imageBase64 = response.data?.[0]?.b64_json;

    if (!imageBase64) {
      console.error("❌ OpenAI non ha restituito dati base64");
      throw new Error("No base64 image data returned from OpenAI");
    }

    console.log(`✅ Immagine base64 generata: ${imageBase64.length} caratteri`);

    // 5. RESTITUISCI SOLO BASE64 - RIMUOVI IMAGE_URL
    return res.status(200).json({
      image_base64: imageBase64, // ← PROPRIETÀ CORRETTA
      style: style,
      prompt: prompt,
      prompt_length: prompt.length,
      final_length: finalPrompt.length,
      note: "Image generated in base64 format"
    });

  } catch (err: any) {
    console.error("Image generation error:", err);

    // Gestione errori specifici di OpenAI
    if (err?.error?.code === "content_policy_violation") {
      return res.status(400).json({
        error: "Content policy violation",
        detail: "The prompt was rejected by the safety system. Please try a different prompt."
      });
    } else if (err?.message?.includes("length")) {
      return res.status(400).json({
        error: "Prompt too long",
        detail: "The prompt exceeds maximum length limits. Please shorten your description."
      });
    } else {
      return res.status(500).json({
        error: "Image generation failed",
        detail: String(err?.message || err)
      });
    }
  }
}
