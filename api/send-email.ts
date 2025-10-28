import nodemailer from 'nodemailer';

type EmailRequest = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

// Configurazione transporter per Aruba
const createTransporter = () => {
  return nodemailer.createTransporter({
    host: process.env.SMTP_HOST || 'smtps.aruba.it',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER || 'ai@pirotta.it',
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
    const body = await request.json() as EmailRequest;
    const { to, subject, html, text } = body;

    if (!to || !subject || !html) {
      return Response.json(
        { error: 'Missing required fields: to, subject, html' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Verifica configurazione SMTP
    if (!process.env.SMTP_PASS) {
      return Response.json(
        { error: 'SMTP not configured on server' },
        { status: 500, headers: corsHeaders }
      );
    }

    // Aggiungi footer no-reply
    const emailContent = `
      ${html}
      <div style="color: #666; font-size: 12px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee;">
        <p>🤖 <em>Creato con Intelligenza Artificiale - Non rispondere a questa email</em></p>
      </div>
    `;

    // Configura email
    const mailOptions = {
      from: 'Fantasmia AI <ai@pirotta.it>',
      to: to,
      subject: subject,
      html: emailContent,
      text: text || html.replace(/<[^>]*>/g, ''),
    };

    console.log('Sending email to:', to);

    // Invio email
    const transporter = createTransporter();
    const result = await transporter.sendMail(mailOptions);

    console.log('Email sent successfully:', result.messageId);

    return Response.json({
      success: true,
      message: 'Email sent successfully',
      messageId: result.messageId,
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error('Email error:', error);
    
    let errorMessage = 'Failed to send email';
    if (error.code === 'EAUTH') {
      errorMessage = 'SMTP authentication failed';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'SMTP server not found';
    }

    return Response.json(
      {
        error: errorMessage,
        detail: error.message,
      },
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
