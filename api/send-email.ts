/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE 5B-R2 / 2.1 — AI/api/send-email.ts.
 * Solo osservatori di ingresso/errori; argomenti e risultati originali conservati. */
import {tracePoint as __fantasmiaTracePoint,withTrace as __fantasmiaWithTrace,withTraceRequest as __fantasmiaWithTraceRequest} from "../lib/traceRuntime.js";
import Cors from 'cors';
import { Resend } from 'resend';
import { NextApiRequest, NextApiResponse } from 'next';

const cors = Cors({
  origin: (origin, callback) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","origin_L6_C11");

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
    ];
    if (!origin || allowedDomains.some(domain => (/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","callback_L21_C40"), (origin.includes(domain))))) {
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
/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","runMiddleware_L35_C1");

  return new Promise((resolve, reject) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","callback_L36_C22");

    fn(req, res, (result: any) => {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","callback_L37_C18");

      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

  async function handler(req: NextApiRequest, res: NextApiResponse) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","handler_L44_C1");

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
      emailPayload.attachments = attachments.map((att: any) => (/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","callback_L74_C50"), (({
        filename: att.filename,
        content: att.content,           // stringa base64
        content_type: att.content_type || att.contentType || 'application/octet-stream'
      }))));
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
/* TRACE 2.1 */ __fantasmiaTracePoint("api/send-email.ts","handler_L44_C1",true);

    console.error("Email sending error:", err);
    return res.status(500).json({
      error: "Email sending failed",
      detail: err.message
    });
  }
}

export default __fantasmiaWithTrace("api/send-email.ts",handler);
