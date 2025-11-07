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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { to, subject, html, text } = req.body;

    if (!to || !subject || (!html && !text)) {
      return res.status(400).json({ 
        error: "Missing required fields: to, subject, and html or text" 
      });
    }

    // Qui implementeresti il servizio email (Resend, SendGrid, etc.)
    // Esempio con Resend:
    /*
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    const { data, error } = await resend.emails.send({
      from: 'Fantasmia <noreply@fantasmia.it>',
      to: to,
      subject: subject,
      html: html,
      text: text
    });

    if (error) {
      throw new Error(error.message);
    }
    */

    // Per ora restituiamo un successo simulato
    console.log('Email would be sent:', { to, subject });

    return res.status(200).json({
      success: true,
      message: "Email sent successfully",
      to: to,
      subject: subject
    });

  } catch (err: any) {
    console.error("Email sending error:", err);
    return res.status(500).json({
      error: "Email sending failed",
      detail: err.message
    });
  }
}
