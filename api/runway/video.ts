import Cors from 'cors';
import { Readable } from 'node:stream';
import type { NextApiRequest, NextApiResponse } from 'next';

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_API_VERSION = '2024-11-06';
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cors = Cors({
  origin: (origin, callback) => {
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
      'fantasmia-5tcgfmiwp-rogers-projects-68a7bd87.vercel.app',
    ];
    if (!origin || allowedDomains.some(domain => origin.includes(domain))) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: any) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => result instanceof Error ? reject(result) : resolve(result));
  });
}

function runwayHeaders(apiKey: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-Runway-Version': RUNWAY_API_VERSION,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function readRunwayError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.error || parsed?.message || parsed?.detail || text;
  } catch {
    return text;
  }
}

async function getTask(taskId: string, apiKey: string) {
  const response = await fetch(`${RUNWAY_API_BASE}/tasks/${taskId}`, {
    headers: runwayHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(`Runway task ${response.status}: ${await readRunwayError(response)}`);
  }
  return response.json();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.RUNWAYML_API_SECRET;
  if (!apiKey) {
    return res.status(503).json({
      error: 'Runway non configurato',
      detail: 'Manca la variabile RUNWAYML_API_SECRET nel backend.',
    });
  }

  try {
    if (req.method === 'POST') {
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

      const runwayResponse = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
        method: 'POST',
        headers: runwayHeaders(apiKey, true),
        body: JSON.stringify({
          model: 'gen4_turbo',
          promptImage: imageDataUrl,
          promptText,
          ratio: '1280:720',
          duration: 5,
        }),
      });

      if (!runwayResponse.ok) {
        return res.status(runwayResponse.status).json({
          error: 'Avvio del filmato non riuscito',
          detail: await readRunwayError(runwayResponse),
        });
      }

      const task = await runwayResponse.json();
      return res.status(202).json({
        taskId: task.id,
        status: task.status,
        estimatedCredits: task.estimatedCost?.credits,
      });
    }

    if (req.method === 'GET') {
      const taskId = String(req.query.taskId || '');
      if (!TASK_ID_PATTERN.test(taskId)) {
        return res.status(400).json({ error: 'Task Runway non valido' });
      }

      const task = await getTask(taskId, apiKey);
      if (req.query.download !== '1') {
        return res.status(200).json({
          taskId: task.id,
          status: task.status,
          failure: task.failure || task.failureCode || null,
        });
      }

      if (task.status !== 'SUCCEEDED' || !Array.isArray(task.output) || !task.output[0]) {
        return res.status(409).json({ error: 'Filmato non ancora disponibile' });
      }

      // Gli URL Runway scadono: il file viene trasferito immediatamente al
      // browser, che lo salva in IndexedDB. L'URL temporaneo non viene esposto.
      const videoResponse = await fetch(task.output[0]);
      if (!videoResponse.ok || !videoResponse.body) {
        return res.status(502).json({ error: 'Impossibile trasferire il filmato Runway' });
      }

      res.setHeader('Content-Type', videoResponse.headers.get('content-type') || 'video/mp4');
      const length = videoResponse.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      res.setHeader('Cache-Control', 'private, no-store');
      Readable.fromWeb(videoResponse.body as any).pipe(res);
      return;
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Runway video error:', error);
    return res.status(500).json({
      error: 'Generazione filmato non riuscita',
      detail: String(error?.message || error),
    });
  }
}
