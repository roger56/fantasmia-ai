import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Body = {
  prompt?: string;
  style?: string;
};

// Mappatura degli stili con prompt ottimizzati
const STYLES = {
  fumetto: "in stile fumetto colorato, vivace, linee nette, personaggi cartoon",
  manga: "in stile manga giapponese, bianco e nero, tratti distintivi, espressioni drammatiche",
  acquarello: "acquerello, tratti morbidi, colori pastello, sfumature delicate",
  fotografico: "fotorealistico, alta definizione, illuminazione naturale, dettagli precisi",
  carboncino: "disegno a carboncino, sfumature di grigio, tratti espressivi, stile artistico classico",
  astratto: "arte astratta, forme geometriche, colori vibranti, composizione non figurativa"
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
    const prompt = body.prompt || "";
    const style = body.style || "fotografico";

    if (!prompt) {
      return new Response(
        JSON.stringify({ error: "Missing 'prompt' in body" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // Verifica che lo stile sia valido
    const validStyles = Object.keys(STYLES);
    if (!validStyles.includes(style)) {
      return new Response(
        JSON.stringify({ 
          error: "Invalid style", 
          valid_styles: validStyles 
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // Costruisci il prompt finale per DALL-E
    const styleDescription = STYLES[style as keyof typeof STYLES];
    const finalPrompt = `${prompt}, ${styleDescription}, senza testo, nessuna scrittura, nessuna parola`;

    console.log(`Generating image with style: ${style}, prompt: ${prompt}`);

    const response = await client.images.generate({
      model: "dall-e-3",
      prompt: finalPrompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      style: "vivid",
    });

    const imageUrl = response.data[0]?.url;

    if (!imageUrl) {
      throw new Error("No image URL returned from OpenAI");
    }

    return new Response(
      JSON.stringify({ 
        image_url: imageUrl,
        style: style,
        prompt: prompt
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );

  } catch (err: any) {
    console.error("Image generation error:", err);
    
    // Gestione errori specifici di OpenAI
    if (err?.error?.code === "content_policy_violation") {
      return new Response(
        JSON.stringify({ 
          error: "Content policy violation", 
          detail: "The prompt was rejected by the safety system. Please try a different prompt."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    } else {
      return new Response(
        JSON.stringify({ 
          error: "Image generation failed", 
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
}
