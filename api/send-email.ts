import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

type EmailRequest = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

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
    const body = await request.json() as EmailRequest;
    const { to, subject, html, text } = body;

    if (!to || !subject || !html) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: corsHeaders }
      );
    }

    // INVIO EMAIL CON RESEND
    const { data, error } = await resend.emails.send({
      from: 'Fantasmia AI <onboarding@resend.dev>', // Puoi verificare il tuo dominio dopo
      to: [to],
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, ''),
    });

    if (error) {
      throw new Error(error.message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Email sent successfully',
        id: data?.id,
      }),
      { status: 200, headers: corsHeaders }
    );

  } catch (error: any) {
    console.error('Email error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to send email',
        detail: error.message,
      }),
      { status: 500, headers: corsHeaders }
    );
  }
}
