/** TRACE 2.4: import ESM espliciti per il runtime Node.js; logica operativa invariata. */
/** FANTASMIA TRACE 5B-R2 / 2.1 — AI/api/openai/send_mail/route.ts.
 * Solo osservatori di ingresso/errori; argomenti e risultati originali conservati. */
import {tracePoint as __fantasmiaTracePoint,withTrace as __fantasmiaWithTrace,withTraceRequest as __fantasmiaWithTraceRequest} from "../../../lib/traceRuntime.js";
import { NextResponse } from 'next/server.js';
import nodemailer from 'nodemailer';

interface EmailRequest {
  to: string;
  subject: string;
  html: string;
}

 async function POST(request: Request) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/send_mail/route.ts","POST_L10_C1");

  try {
    const { to, subject, html } = await request.json() as EmailRequest;

    // Configura nodemailer (modifica con i tuoi dati)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      html,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
/* TRACE 2.1 */ __fantasmiaTracePoint("api/openai/send_mail/route.ts","POST_L10_C1",true);

    console.error('Email error:', error);
    return NextResponse.json(
      { error: 'Failed to send email' },
      { status: 500 }
    );
  }
}

const __fantasmiaPOST=__fantasmiaWithTraceRequest("api/openai/send_mail/route.ts",POST);
export {__fantasmiaPOST as POST};
