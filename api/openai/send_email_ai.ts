import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

type EmailAttachment = {
  filename: string;
  content: string | Buffer;
  contentType?: string;
};

type EmailRequest = {
  /**
   * COMPATIBILITÀ:
   * - In questa nuova versione, `to` è il DESTINATARIO.
   * - Se non viene passato, si usa il default (quando.ruggero@gmail.com).
   *
   * In futuro, se vuoi, possiamo aggiungere anche `userEmail` separato,
   * ma per ora basta che Fantasmia passi `to = emailUtente`.
   */
  to?: string;

  subject: string;
  html: string;
  text?: string;

  /**
   * Email dell’utente Fantasmia (opzionale) usata come Reply-To.
   * Se non la passi, la mail resta “no-reply”.
   */
  userEmail?: string;

  attachments?: EmailAttachment[];
};

const DEFAULT_RECIPIENT = "quando.ruggero@gmail.com";

/** Sostituisci con un mittente VERIFICATO su Resend */
const VERIFIED_FROM = "Fantasmia <no-reply@fantasmia.ai>";

function isValidEmail(email: string) {
  // validazione semplice (ok per uso pratico; non è RFC perfetta)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function POST(request: Request) {
  const corsHeaders = buildCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = (await request.json()) as EmailRequest;

    const subject = (body.subject || "").trim();
    const html = (body.html || "").trim();
    const text = body.text;
    const attachments = body.attachments || [];

    // Qui `to` è il destinatario richiesto dall’utente, se presente.
    const requestedRecipient = (body.to || "").trim();

    // userEmail (opzionale) per reply-to
    const userEmail = (body.userEmail || "").trim();

    if (!subject || !html) {
      return Response.json({ error: "Missing required fields: subject, html" }, { status: 400, headers: corsHeaders });
    }

    // Determina destinatario finale
    let finalRecipient = DEFAULT_RECIPIENT;
    if (requestedRecipient) {
      if (!isValidEmail(requestedRecipient)) {
        return Response.json(
          { error: 'Invalid "to" email address' },
          { status: 400, headers: corsHeaders }
        );
      }
      finalRecipient = requestedRecipient;
    }

    // Footer HTML
    const emailContent = `
${html}
<div style="color:#666;font-size:12px;margin-top:20px;padding-top:20px;border-top:1px solid #eee;">
  <p>@<em>Creato con Intelligence Artificiale - Non rispondere a questa email</em></p>
  <p>Album generato automaticamente per la stampa in formato A4/A5</p>
</div>
`;

    // Prepara email
    const emailData: any = {
      from: VERIFIED_FROM,      // ✅ mittente verificato
      to: finalRecipient,       // ✅ destinatario dinamico o default
      subject,
      html: emailContent,
      text: text || html.replace(/<[^>]*>/g, ""),
    };

    // Reply-To: se disponibile e valida, così puoi rispondere all’utente
    if (userEmail) {
      if (!isValidEmail(userEmail)) {
        return Response.json(
          { error: 'Invalid "userEmail" address' },
          { status: 400, headers: corsHeaders }
        );
      }
      emailData.reply_to = userEmail;
    }

    // Allegati
    if (attachments.length > 0) {
      emailData.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        content_type: a.contentType || "application/octet-stream",
      }));
    }

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error("Resend error:", error);
      return Response.json({ error: error.message, detail: error }, { status: 500, headers: corsHeaders });
    }

    return Response.json(
      {
        success: true,
        message: "Email sent successfully with attachments",
        id: data?.id,
        attachmentCount: attachments.length,
        recipient: finalRecipient,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    console.error("Unexpected error:", error);
    return Response.json(
      { error: "Internal server error: " + error.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: buildCorsHeaders() });
}
