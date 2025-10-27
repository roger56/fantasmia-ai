import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

// Configurazione tipo per il corpo della richiesta
type EmailRequest = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
};

// Configurazione transporter Nodemailer
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

export async function POST(request: NextRequest) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Gestione preflight CORS
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Verifica metodo HTTP
    if (request.method !== 'POST') {
      return NextResponse.json(
        { error: 'Method not allowed' },
        {
          status: 405,
          headers: corsHeaders,
        }
      );
    }

    // Parsing del corpo della richiesta
    const body: EmailRequest = await request.json();
    const { to, subject, html, text, from } = body;

    // Validazione campi obbligatori
    if (!to || !subject || !html) {
      return NextResponse.json(
        {
          error: 'Missing required fields',
          required: ['to', 'subject', 'html'],
        },
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    // Validazione formato email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    // Verifica variabili d'ambiente
    const requiredEnvVars = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

    if (missingEnvVars.length > 0) {
      console.error('Missing environment variables:', missingEnvVars);
      return NextResponse.json(
        {
          error: 'Server configuration error',
          detail: 'Email service not properly configured',
        },
        {
          status: 500,
          headers: corsHeaders,
        }
      );
    }

    // Configurazione email
    const mailOptions = {
      from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: text || html.replace(/<[^>]*>/g, ''), // Fallback a testo semplice
      html,
    };

    console.log('Attempting to send email:', {
      to,
      subject,
      from: mailOptions.from,
    });

    // Invio email
    const transporter = createTransporter();
    const result = await transporter.sendMail(mailOptions);

    console.log('Email sent successfully:', result.messageId);

    return NextResponse.json(
      {
        success: true,
        message: 'Email sent successfully',
        messageId: result.messageId,
        to,
        subject,
      },
      {
        status: 200,
        headers: corsHeaders,
      }
    );

  } catch (error: any) {
    console.error('Email sending error:', error);

    // Gestione errori specifici
    let errorMessage = 'Failed to send email';
    let statusCode = 500;

    if (error.code === 'EAUTH') {
      errorMessage = 'Authentication failed - check SMTP credentials';
      statusCode = 401;
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'SMTP server not found';
      statusCode = 502;
    } else if (error.code === 'ECONNECTION') {
      errorMessage = 'Cannot connect to SMTP server';
      statusCode = 503;
    }

    return NextResponse.json(
      {
        error: errorMessage,
        detail: error.message,
      },
      {
        status: statusCode,
        headers: corsHeaders,
      }
    );
  }
}

// Export per altre HTTP methods se necessario
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}
