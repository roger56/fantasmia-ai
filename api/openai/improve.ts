import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Body = { 
  text?: string; 
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
    const text = body.text || "";
    const style = body.style || "professional";

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
          content: `Sei un assistente per il miglioramento del testo. 
Migliora il testo fornito dall'utente rendendolo più ${style} in italiano.
Mantieni il significato originale ma rendilo più chiaro, fluido e ben scritto.
Rispondi SOLO con il testo migliorato, senza commenti aggiuntivi.`
        },
        { 
          role: "user", 
          content: `Migliora questo testo in stile ${style}: "${text}"` 
        },
      ],
      temperature: 0.3,
      max_tokens: 1000,
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
    console.error("improve error:", err);
    return new Response(
      JSON.stringify({ 
        error: "Text improvement failed", 
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
