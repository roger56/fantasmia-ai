// ===== Tipi aggiornati =====
type Body = {
  text?: string;
  prompt?: string;
  seconds?: 4 | 8 | 12;
  size?: string;
  style?: string;
  input_reference?: string;
};

const MAX_PROMPT_LENGTH = 1200;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    let body: any = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    // Accetta sia "text" che "prompt"
    let text = ((body?.text || body?.prompt) ?? "").toString().trim();

    if (!text) {
      return res.status(400).json({
        error: "Missing 'text' in body",
        received_type: typeof req.body,
      });
    }

    if (text.length > MAX_PROMPT_LENGTH) {
      console.warn(`Video prompt too long (${text.length}), truncating`);
      text = text.substring(0, MAX_PROMPT_LENGTH);
    }

    // Costruisci payload con SOLO parametri validi per OpenAI /v1/videos
    const payload: Record<string, unknown> = {
      model: "sora-2",
      prompt: text,
      seconds: body.seconds ?? 8, // 4 | 8 | 12
      size: body.size ?? body.resolution ?? "1280x720",
    };

    // Opzionali se forniti
    if (body.style) payload.style = body.style;
    if (body.input_reference) payload.input_reference = body.input_reference;

    console.log("🎬 Generating video with Sora 2", {
      prompt_length: text.length,
      seconds: payload.seconds,
      size: payload.size,
    });

    const response = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
let data: any = {};
try { data = rawText ? JSON.parse(rawText) : {}; } catch {}

console.log("OPENAI videos status:", response.status);
console.log("OPENAI videos raw:", rawText);


    if (!response.ok) {
      console.error("OpenAI video error:", data);
      return res.status(response.status).json({
        error: "Video generation failed",
        detail: data,
      });
    }

    if (!data.id) {
      return res.status(502).json({
        error: "Video generation returned no job id",
        detail: data,
      });
    }

    return res.status(200).json({
      job_id: data.id,
      status: data.status ?? "unknown",
      prompt_length: text.length,
      note: "Video job created (async)",
      video_url: typeof data.video_url === "string" ? data.video_url : undefined,
    });
  } catch (err: any) {
    console.error("Video generation error:", err);
    return res.status(500).json({
      error: "Video generation failed",
      detail: String(err?.message || err),
    });
  }
}

