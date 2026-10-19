/**
 * ============================================================================
 * FANTASMIA - SERVIZIO EMAIL PER STORIE E ALLEGATI
 * Path: api/openai/send_email_ai.ts
 * ============================================================================
 *
 * Adattatore HTTP verso Resend utilizzato dal frontend per consegnare email
 * generate da Fantasmia, compresi i pacchetti JSON delle storie NSU destinati
 * al Superuser. Costruisce mittente e footer standard, valida il destinatario,
 * inoltra gli eventuali allegati e restituisce l'identificativo dell'invio.
 *
 * Questo endpoint effettua il trasporto ma non archivia le storie: il JSON
 * viene scaricato dal SU e importato nel suo Archivio Magico locale.
 * Il destinatario di fallback serve solo come protezione legacy; la sorgente
 * corretta dell'indirizzo resta la configurazione del SU.
 *
 * Attenzione: RESEND_API_KEY deve restare nelle variabili d'ambiente. Qualsiasi
 * modifica a formato degli allegati o risposta API va coordinata con
 * storyExportImport.ts, che decide quando marcare una storia come inviata.
 * ============================================================================
 */

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

type EmailAttachment = {
  filename: string;
  content: string | Buffer;
  contentType?: string;
};

type EmailRequest = {
  to?: string;              // destinatario reale (parametrico da Lovable)
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
};

const DEFAULT_TO = 'quando.ruggero@gmail.com';
const GMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

export async function POST(request: Request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = (await request.json()) as EmailRequest;
    const { to, subject, html, text, attachments } = body;

    if (!subject || !html) {
      return Response.json(
        { error: 'Missing required fields: subject or html' },
        { status: 400, headers: corsHeaders }
      );
    }

    // ✅ destinatario finale
    const finalTo =
      to && GMAIL_REGEX.test(to)
        ? to
        : DEFAULT_TO;

    // footer standard Fantasmia
    const emailContent = `
${html}
<div style="color:#666;font-size:12px;margin-top:20px;padding-top:20px;border-top:1px solid #eee">
  <p><em>Messaggio generato automaticamente da Fantasmia – Non rispondere a questa email.</em></p>
</div>
`;

    const emailData: any = {
      from: 'Fantasmia <no-reply@fantasmia.it>',
      to: finalTo,                     // ✅ ORA PARAMETRICO
      subject,
      html: emailContent,
      text: text || html.replace(/<[^>]*>/g, ''),
    };

    if (attachments && attachments.length > 0) {
      emailData.attachments = attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        content_type: a.contentType || 'application/octet-stream',
      }));
    }

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Resend error:', error);
      return Response.json(
        { error: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return Response.json(
      {
        success: true,
        to: finalTo,
        message: 'Email sent successfully',
        id: data?.id,
        attachmentCount: attachments?.length || 0,
      },
      { headers: corsHeaders }
    );

  } catch (error: any) {
    console.error('Unexpected error:', error);
    return Response.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
