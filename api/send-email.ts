import nodemailer from 'nodemailer';

type EmailRequest = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
};

const createTransporter = () => {
  return nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

// AGGIUNGI QUESTA ESPORTAZIONE PRINCIPALE
export async function POST(request: Request) {
  console.log('Email endpoint called');
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Gestione CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { 
      status: 200, 
      headers: corsHeaders 
    });
  }

  // Verifica che sia POST
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { 
        status: 405, 
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      }
    );
  }

  try {
    const body = await request.json() as EmailRequest;
    const { to, subject, html, text, from } = body;

    console.log('Processing email to:', to);

    // Validazione
    if (!to || !subject || !html) {
      return new Response(
        JSON.stringify({
          error: 'Missing required fields',
          required: ['to', 'subject', 'html'],
        }),
        { 
          status: 400, 
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    // Verifica config SMTP
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.error('Missing SMTP environment variables');
      return new Response(
        JSON.stringify({
          error: 'Email service not configured on server',
        }),
        { 
          status: 500, 
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    // Configura email
    const mailOptions = {
      from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: text || html.replace(/<[^>]*>/g, ''),
      html,
    };

    console.log('Sending email...');
    const transporter = createTransporter();
    const result = await transporter.sendMail(mailOptions);

    console.log('Email sent successfully:', result.messageId);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Email sent successfully',
        messageId: result.messageId,
      }),
      { 
        status: 200, 
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      }
    );

  } catch (error: any) {
    console.error('Email sending error:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to send email',
        detail: error.message,
      }),
      { 
        status: 500, 
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      }
    );
  }
}

// AGGIUNGI ANCHE GET PER DEBUG
export async function GET(request: Request) {
  return new Response(
    JSON.stringify({ 
      message: 'Email API is working! Use POST to send emails.',
      endpoint: '/api/send-email',
      method: 'POST',
      required_fields: ['to', 'subject', 'html']
    }),
    { 
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}
