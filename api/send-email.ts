import { Resend } from 'resend';

// Inizializza Resend
const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(request: Request) {
  console.log('Email endpoint called');
  
  try {
    const body = await request.json();
    console.log('Request body:', body);

    const { to, subject, html } = body;

    // Validazione base
    if (!to || !subject || !html) {
      return Response.json(
        { error: 'Missing required fields: to, subject, html' },
        { status: 400 }
      );
    }

    // Verifica API key
    if (!process.env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set');
      return Response.json(
        { error: 'Email service not configured' },
        { status: 500 }
      );
    }

    console.log('Sending email to:', to);

    // Invio email
    const { data, error } = await resend.emails.send({
      from: 'Fantasmia AI <onboarding@resend.dev>',
      to: to,
      subject: subject,
      html: html,
    });

    if (error) {
      console.error('Resend error:', error);
      return Response.json(
        { error: error.message },
        { status: 500 }
      );
    }

    console.log('Email sent successfully:', data?.id);
    
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

// Handle OPTIONS for CORS
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
