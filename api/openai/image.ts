import OpenAI from "openai";
import OpenAI from "openai";
import Cors from 'cors';  // ← AGGIUNGI QUESTA IMPORT
import { NextApiRequest, NextApiResponse } from 'next';

// ← INSERISCI QUI IL CODICE CORS (dopo le import ma prima della logica esistente)

// Inizializza il middleware CORS
const cors = Cors({
  origin: [
    'https://6lf56c03-2655-460b-9514-3ce77cd7cd0.lovableproject.com',
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

// ← MANTIENI TUTTO IL CODICE ESISTENTE DA QUI IN POI ↓

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,  // Correggi: apiKey non apikey
});

type Body = {
    prompt1: string;
    style1: string;
};

// Mappatura degli stili con prompt ottimizzati
const STYLES = {
    fumetto: "fumetto colorato, vivace, linee nette, cartoon",
    manga: "manga giapponese, bianco e nero, tratti distintivi, drammatico",
    // ... il resto del tuo codice esistente
};

// MODIFICA LA FUNZIONE handler PRINCIPALE:
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ← AGGIUNGI QUESTA LINEA ALL'INIZIO DELLA HANDLER
  await runMiddleware(req, res, cors);
  
  // ← MANTIENI TUTTA LA TUA LOGICA ESISTENTE QUI SOTTO
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { prompt1, style1 } = req.body as Body;
  
  // ... il resto del tuo codice per generare immagini
  try {
    // La tua logica esistente con OpenAI...
    const response = await client.images.generate({
      model: "dall-e-3",
      prompt: `${prompt1} in stile ${STYLES[style1 as keyof typeof STYLES]}`,
      size: "1024x1024",
      quality: "standard",
      n: 1,
    });

    const imageUrl = response.data[0]?.url;
    
    if (!imageUrl) {
      throw new Error("No image URL returned from OpenAI");
    }

    res.status(200).json({ imageUrl });
    
  } catch (error) {
    console.error("Error generating image:", error);
    res.status(500).json({ error: "Failed to generate image" });
  }
}
Riepilogo delle modifiche:
import Cors from 'cors'; - dopo l'import di OpenAI

Blocco CORS completo - dopo le import ma prima di const client = new OpenAI()

await runMiddleware(req, res, cors); - prima riga dentro la funzione handler

Verifica che cors sia installato correttamente:
bash
# Nella cartella del progetto Vercel
npm list cors
Dovresti vedere cors nella lista delle dipendenze.

File finale completo dovrebbe essere strutturato così:
typescript
// 1. IMPORTS
import OpenAI from "openai";
import Cors from 'cors';
import { NextApiRequest, NextApiResponse } from 'next';

// 2. CONFIGURAZIONE CORS
const cors = Cors({ ... });
function runMiddleware(...) { ... }

// 3. IL TUO CODICE ESISTENTE
const client = new OpenAI({ ... });
type Body = { ... };
const STYLES = { ... };

// 4. HANDLER MODIFICATA
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);  // ← PRIMA RIGA!
  
  // ... tutto il resto del tuo codice
}
Fai il deploy su Vercel dopo queste modifiche e il problema CORS dovrebbe risolversi!

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

export async function POST(req: Request) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // === CORREZIONE 1: Aggiungi "as Body" qui ===
    const body = await req.json() as Body;
    
    let prompt = body.prompt || "";
    const style = body.style || "fotografico";

    if (!prompt) {
      return new Response(
        JSON.stringify({ error: "Missing 'prompt' in body" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // Verifica che lo stile sia valido
    const validStyles = Object.keys(STYLES);
    if (!validStyles.includes(style)) {
      return new Response(
        JSON.stringify({ 
          error: "Invalid style", 
          valid_styles: validStyles 
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // 1. PULIZIA E RIDUZIONE DEL PROMPT
    prompt = prompt
      .replace(/scritta|testo|parola|scrivere|leggere|lettere|alfabeto|frase|didascalia|sottotitolo/gi, '')
      .replace(/["'](.*?)["']/g, '') // Rimuove testo tra virgolette
      .replace(/\s+/g, ' ') // Riduce spazi multipli
      .trim();

    // 2. TRONCAMENTO INTELLIGENTE (max 600 caratteri per il prompt utente)
    const MAX_USER_PROMPT_LENGTH = 600;
    if (prompt.length > MAX_USER_PROMPT_LENGTH) {
      console.warn(`Prompt too long (${prompt.length} chars), truncating to ${MAX_USER_PROMPT_LENGTH}`);
      prompt = prompt.substring(0, MAX_USER_PROMPT_LENGTH) + "...";
    }

    // 3. COSTRUZIONE PROMPT FINALE CON CONTROLLO LUNGHEZZA
    const styleDescription = STYLES[style as keyof typeof STYLES];
    let finalPrompt = `${prompt}. ${styleDescription}. ${ANTI_TEXT_PROMPT}.`;

    // Verifica lunghezza totale
    if (finalPrompt.length > 800) {
      console.warn(`Final prompt too long (${finalPrompt.length} chars), optimizing...`);
      // Riduci ulteriormente mantenendo l'essenziale
      finalPrompt = `${prompt.substring(0, 400)}. ${styleDescription}. ${ANTI_TEXT_PROMPT}.`;
    }

    console.log(`Generating image - Style: ${style}, Prompt length: ${prompt.length}, Final length: ${finalPrompt.length}`);

    // 4. GENERAZIONE IMMAGINE
    const response = await client.images.generate({
      model: "dall-e-3",
      prompt: finalPrompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      style: "vivid",
    });

    // === CORREZIONE 2: Aggiungi "?" per controllo optional ===
    const imageUrl = response.data?.[0]?.url;

    if (!imageUrl) {
      throw new Error("No image URL returned from OpenAI");
    }

    return new Response(
      JSON.stringify({ 
        image_url: imageUrl,
        style: style,
        prompt: prompt,
        prompt_length: prompt.length,
        final_length: finalPrompt.length,
        note: "Image generated with optimized prompt length"
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );

  } catch (err: any) {
    console.error("Image generation error:", err);
    
    // Gestione errori specifici di OpenAI
    if (err?.error?.code === "content_policy_violation") {
      return new Response(
        JSON.stringify({ 
          error: "Content policy violation", 
          detail: "The prompt was rejected by the safety system. Please try a different prompt."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    } else if (err?.message?.includes("length")) {
      return new Response(
        JSON.stringify({ 
          error: "Prompt too long", 
          detail: "The prompt exceeds maximum length limits. Please shorten your description."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    } else {
      return new Response(
        JSON.stringify({ 
          error: "Image generation failed", 
          detail: String(err?.message || err) 
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }
  }
}
