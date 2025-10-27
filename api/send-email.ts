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
      return Response.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // AGGIUNGI IL FOOTER AL CONTENUTO HTML
    const emailContent = `
      ${html}
      <div style="color: #666; font-size: 12px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee;">
        <p>🤖 <em>Creato con Intelligenza Artificiale - Non rispondere a questa email</em></p>
      </div>
    `;

    // OPZIONE 5: Fantasmia AI <ai@fantasmia.it>
    const { data, error } = await resend.emails.send({
      from: 'Fantasmia AI <ai@fantasmia.it>',
      to: to,
      subject: subject,
      html: emailContent,
      text: text || html.replace(/<[^>]*>/g, ''),
    });

    if (error) {
      console.error('Resend error:', error);
      return Response.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      message: 'Email sent successfully',
      id: data?.id
    });

  } catch (error: any) {
    console.error('Unexpected error:', error);
    return Response.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500 }
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
