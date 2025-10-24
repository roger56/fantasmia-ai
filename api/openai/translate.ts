import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Body = {
  text?: string;
  target_language?: string;
  source_language?: string;
};

export async function POST(req: Request) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    const body: Body = await req.json();
    const text = body.text || "";
    const targetLanguage = body.target_language || "en";
    const sourceLanguage = body.source_language || "auto";

    if (!text) {
      return new Response(
        JSON.stringify({ error: "Missing 'text' in body" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Sei un traduttore professionista. Traduci accuratamente il testo dalla lingua sorgente alla lingua target. Rispondi SOLO con il testo tradotto, senza commenti aggiuntivi."
        },
        {
          role: "user",
          content: `Traduci questo testo da ${sourceLanguage} a ${targetLanguage}: "${text}"`
        },
      ],
      temperature: 0.1, // Molto basso per traduzioni precise
      max_tokens: 1000,
    });

    const output = completion.choices?.[0]?.message?.content?.trim() ?? text;

    return new Response(
      JSON.stringify({ output_text: output }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (err: any) {
    console.error("translate error:", err);
    return new Response(
      JSON.stringify({
        error: "Translation failed",
        detail: String(err?.message || err)
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
}
