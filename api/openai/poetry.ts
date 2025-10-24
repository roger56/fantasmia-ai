import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Body = { 
  theme?: string;
  style?: string;
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
    const theme = body.theme || "amore";
    const poetryStyle = body.style || "libera";

    if (!theme) {
      return new Response(
        JSON.stringify({ error: "Missing 'theme' in body" }),
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
          content: `Sei un poeta italiano. Scrivi una poesia in italiano sul tema fornito.
Usa lo stile poetico richiesto. Massimo 15 righe.
Rispondi SOLO con la poesia, senza commenti aggiuntivi.`
        },
        { 
          role: "user", 
          content: `Tema: ${theme}, Stile: ${poetryStyle}` 
        },
      ],
      temperature: 0.8,
      max_tokens: 500,
    });

    const output = completion.choices?.[0]?.message?.content?.trim() ?? "";

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
    console.error("poetry error:", err);
    return new Response(
      JSON.stringify({ 
        error: "Poetry generation failed", 
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
