import OpenAI from "openai";
import Cors from 'cors';
import { NextApiRequest, NextApiResponse } from 'next';

// STESSA CONFIGURAZIONE CORS DINAMICA
const cors = Cors({
  origin: (origin, callback) => {
    const allowedDomains = [
      '.lovableproject.com',
      '.lovable.app',
      '.lovable.dev',     // 👈 aggiunto (subdomini)
      'lovable.dev',      // 👈 aggiunto (dominio secco)
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
    const { theme, style } = req.body;

    if (!theme) {
      return res.status(400).json({ error: "Missing 'theme' in body" });
    }

    const prompt = `Crea una poesia ${style || 'lirica'} sul tema: "${theme}". 
    La poesia deve essere in italiano, evocativa e suggestiva.`;

    const completion = await client.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "Sei un poeta esperto. Crea poesie evocative e suggestive in italiano, mantenendo un tono poetico e ricco di immagini."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 500,
      temperature: 0.8
    });

    const poetry = completion.choices[0]?.message?.content;

    if (!poetry) {
      throw new Error("No poetry generated");
    }

    return res.status(200).json({
      theme: theme,
      style: style || 'lirica',
      poetry: poetry
    });

  } catch (err: any) {
    console.error("Poetry generation error:", err);
    return res.status(500).json({
      error: "Poetry generation failed",
      detail: err.message
    });
  }
}
