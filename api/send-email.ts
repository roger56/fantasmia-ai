import Cors from 'cors';
import { Resend } from 'resend';
import { NextApiRequest, NextApiResponse } from 'next';

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
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { to, subject, html, text, attachments } = req.body;

    if (!to || !subject || (!html && !text)) {
      return res.status(400).json({
        error: "Missing required fields: to, subject, and html or text"
      });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    // Costruisci payload Resend
    const emailPayload: any = {
      from: 'FantasMia <noreply@fantasmia.it>',
      to: to,                    // <-- destinatario DINAMICO dal body
      subject: subject,
    };

    if (html) emailPayload.html = html;
    if (text) emailPayload.text = text;

    // Supporto allegati (per export storie JSON)
    // attachments: [{ filename: "storie.json", content: "base64...", content_type: "application/json" }]
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      emailPayload.attachments = attachments.map((att: any) => ({
        filename: att.filename,
        content: att.content,           // stringa base64
        content_type: att.content_type || att.contentType || 'application/octet-stream'
      }));
    }

    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error("Resend error:", error);
      return res.status(500).json({ error: error.message });
    }

    console.log('Email sent to:', to, 'id:', data?.id);

    return res.status(200).json({
      success: true,
      message: "Email sent successfully",
      id: data?.id,
      to: to
    });

  } catch (err: any) {
    console.error("Email sending error:", err);
    return res.status(500).json({
      error: "Email sending failed",
      detail: err.message
    });
  }
}
