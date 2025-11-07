import OpenAI from "openai";
import Cors from 'cors';
import { NextApiRequest, NextApiResponse } from 'next';

// STESSA CONFIGURAZIONE CORS DINAMICA
const cors = Cors({
  origin: (origin, callback) => {
    const allowedDomains = [
      '.lovableproject.com',
      '.lovable.app',
      'fantasmia.it',
      'localhost'
    ];
    
    if (!origin || allowedDomains.some(domain => origin.includes(domain))) {
      callback(null, true);
    } else {
      console.log('CORS blocked for origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
});

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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { text, type } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in body" });
    }

    const prompt = `Migliora il seguente testo ${type === 'story' ? 'narrativo' : 'descrittivo'} mantenendo lo stile originale ma rendendolo più evocativo e coinvolgente:\n\n"${text}"`;

    const completion = await client.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "Sei uno scrittore esperto. Migliora i testi mantenendo lo stile originale ma rendendoli più vividi ed emotivamente coinvolgenti."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    });

    const improvedText = completion.choices[0]?.message?.content;

    if (!improvedText) {
      throw new Error("No improved text generated");
    }

    return res.status(200).json({
      original: text,
      improved: improvedText,
      type: type || 'general'
    });

  } catch (err: any) {
    console.error("Text improvement error:", err);
    return res.status(500).json({
      error: "Text improvement failed",
      detail: err.message
    });
  }
}
