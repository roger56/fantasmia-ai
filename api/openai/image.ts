/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE 5B-R2 / 2.2 — AI/api/openai/image.ts.
 * Correzione esclusivamente TypeScript; JavaScript emesso verificato identico. */
/** FANTASMIA TRACE 5B-R2 / 2.1 — AI/api/openai/image.ts.
 * Solo osservatori di ingresso/errori; argomenti e risultati originali conservati. */
import {tracePoint as __fantasmiaTracePoint,withTrace as __fantasmiaWithTrace,withTraceRequest as __fantasmiaWithTraceRequest} from "../../lib/traceRuntime.js";
import OpenAI from "openai";
import Cors from 'cors';
import { Readable } from 'node:stream';
import { NextApiRequest, NextApiResponse } from 'next';

// CONFIGURAZIONE CORS DINAMICA - PER TUTTI I DOMINI LOVABLE
const cors = Cors({
  origin: (origin, callback) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","origin_L8_C11");

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
    
    if (!origin || allowedDomains.some(domain => (/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","callback_L25_C40"), (origin.includes(domain))))) {
      callback(null, true);
    } else {
      console.log('CORS blocked for origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
});

// Helper per eseguire il middleware
function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","runMiddleware_L40_C1");

  return new Promise((resolve, reject) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","callback_L41_C22");

    fn(req, res, (result: any) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","callback_L42_C18");

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
  operation?: 'runway-create';
  imageDataUrl?: string;
  promptText?: string;
};

/** Forma attesa delle risposte Runway: solo annotazione, nessuna validazione aggiunta. */
interface RunwayTask {
  id?: string;
  status?: string;
  failure?: string;
  failureCode?: string;
  output?: string[];
}

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_API_VERSION = '2024-11-06';
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runwayHeaders(apiKey: string, json = false): Record<string, string> {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","runwayHeaders_L67_C1");

  return {
    Authorization: `Bearer ${apiKey}`,
    'X-Runway-Version': RUNWAY_API_VERSION,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function readRunwayError(response: Response): Promise<string> {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","readRunwayError_L75_C1");

  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.error || parsed?.message || parsed?.detail || text;
  } catch {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","readRunwayError_L75_C1",true);

    return text;
  }
}

async function getRunwayTask(taskId: string, apiKey: string) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","getRunwayTask_L85_C1");

  const response = await fetch(`${RUNWAY_API_BASE}/tasks/${taskId}`, {
    headers: runwayHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(`Runway task ${response.status}: ${await readRunwayError(response)}`);
  }
  return response.json() as Promise<RunwayTask>;
}

async function handleRunwayCreate(req: NextApiRequest, res: NextApiResponse) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","handleRunwayCreate_L95_C1");

  const apiKey = process.env.RUNWAYML_API_SECRET;
  if (!apiKey) return res.status(503).json({ error: 'Runway non configurato' });

  const imageDataUrl = String(req.body?.imageDataUrl || '');
  const promptText = String(req.body?.promptText || '').trim();
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageDataUrl)) {
    return res.status(400).json({ error: 'Disegno AI mancante o non valido' });
  }
  if (Buffer.byteLength(imageDataUrl, 'utf8') > 3_800_000) {
    return res.status(413).json({ error: 'Disegno troppo grande per Runway' });
  }
  if (!promptText || promptText.length > 1000) {
    return res.status(400).json({ error: 'Testo della storia non valido' });
  }

  const response = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
    method: 'POST',
    headers: runwayHeaders(apiKey, true),
    body: JSON.stringify({ model: 'gen4_turbo', promptImage: imageDataUrl, promptText, ratio: '1280:720', duration: 5 }),
  });
  if (!response.ok) {
    return res.status(response.status).json({ error: 'Avvio del filmato non riuscito', detail: await readRunwayError(response) });
  }
  const task = await response.json() as RunwayTask;
  return res.status(202).json({ taskId: task.id, status: task.status });
}

async function handleRunwayTask(req: NextApiRequest, res: NextApiResponse) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","handleRunwayTask_L123_C1");

  const apiKey = process.env.RUNWAYML_API_SECRET;
  if (!apiKey) return res.status(503).json({ error: 'Runway non configurato' });
  const taskId = String(req.query.taskId || '');
  if (!TASK_ID_PATTERN.test(taskId)) return res.status(400).json({ error: 'Task Runway non valido' });

  const task = await getRunwayTask(taskId, apiKey);
  if (req.query.download !== '1') {
    return res.status(200).json({ taskId: task.id, status: task.status, failure: task.failure || task.failureCode || null });
  }
  if (task.status !== 'SUCCEEDED' || !Array.isArray(task.output) || !task.output[0]) {
    return res.status(409).json({ error: 'Filmato non ancora disponibile' });
  }
  const videoResponse = await fetch(task.output[0]);
  if (!videoResponse.ok || !videoResponse.body) return res.status(502).json({ error: 'Impossibile trasferire il filmato Runway' });
  res.setHeader('Content-Type', videoResponse.headers.get('content-type') || 'video/mp4');
  const length = videoResponse.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);
  res.setHeader('Cache-Control', 'private, no-store');
  Readable.fromWeb(videoResponse.body as any).pipe(res);
}

// Mappatura degli stili con prompt ottimizzati
const STYLES = {
  fumetto: "fumetto colorato, vivace, linee nette, cartoon",
  manga: "manga giapponese, bianco e nero, tratti distintivi, drammatico",
  acquarello: "acquerello, tratti morbidi, colori pastello, sfumature",
  fotografico: "fotorealistico, alta definizione, illuminazione naturale",
  carboncino: "carboncino, sfumature di grigio, tratti espressivi, artistico",
  astratto: "arte astratta, forme geometriche, colori vibranti",
  sketch: "disegno vettoriale, linea pulita, tratto spesso e nero, nessun colore, sfondo bianco, stile line art per libro da colorare per bambini di 6 anni, facile da colorare, contorni chiari"
};

// Prompt anti-testo ottimizzato IN INGLESE
const ANTI_TEXT_PROMPT = "STRICT NO TEXT POLICY: Absolutely no text, no words, no letters, no numbers, no symbols, no signatures, no logos, no writing of any kind in any language. Completely text-free image.";

  async function handler(req: NextApiRequest, res: NextApiResponse) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","handler_L159_C1");

  // Esegui il middleware CORS PER PRIMO
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method === 'POST' && req.body?.operation === 'runway-create') {
      return await handleRunwayCreate(req, res);
    }
    if (req.method === 'GET' && req.query.operation === 'runway-task') {
      return await handleRunwayTask(req, res);
    }
  } catch (error: any) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","handler_L159_C1",true);

    console.error('Runway video error:', error);
    return res.status(500).json({ error: 'Generazione filmato non riuscita', detail: String(error?.message || error) });
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

if (style === 'sketch') {
    finalPrompt += ". Black and white line art only, no shading, no colors, no grayscale areas, solid black lines, pure white background.";
}
    if (finalPrompt.length > 800) {
      console.warn(`Final prompt too long (${finalPrompt.length} chars), optimizing...`);
      finalPrompt = `${prompt.substring(0, 400)}. ${styleDescription}. ${ANTI_TEXT_PROMPT}`;
    }

    console.log(`Generating image - Style: ${style}, Prompt length: ${prompt.length}, Final length: ${finalPrompt.length}`);

       // 4. GENERAZIONE IMMAGINE - FORMATO BASE64
    const response = await client.images.generate({
      model: (process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare") as any,
      prompt: finalPrompt,
      n: 1,
      size: "1024x1024",
      quality: "medium"
    });

    // Controllo per i dati base64
    const imageBase64 = response.data?.[0]?.b64_json;

    if (!imageBase64) {
      throw new Error("No base64 image data returned from OpenAI");
    }

    console.log("✅ Image generated successfully in base64 format");

    return res.status(200).json({
      image_base64: imageBase64,
      style: style,
      prompt: prompt,
      prompt_length: prompt.length,
      final_length: finalPrompt.length,
      note: "Image generated in base64 format"
    });

  } catch (err: any) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/image.ts","handler_L159_C1",true);

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


export default __fantasmiaWithTrace("api/openai/image.ts",handler);
