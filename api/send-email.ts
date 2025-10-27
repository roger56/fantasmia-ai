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
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: corsHeaders }
      );
    }

    const body = await request.json() as EmailRequest;
    const { to, subject, html, text, from } = body;

    if (!to || !subject || !html) {
      return new Response(
        JSON.stringify({
          error: 'Missing required fields',
          required: ['to', 'subject', 'html'],
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Verifica variabili d'ambiente
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return new Response(
        JSON.stringify({
          error: 'Email service not configured',
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    const mailOptions = {
      from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: text || html.replace(/<[^>]*>/g, ''),
      html,
    };

    const transporter = createTransporter();
    const result = await transporter.sendMail(mailOptions);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Email sent successfully',
        messageId: result.messageId,
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
