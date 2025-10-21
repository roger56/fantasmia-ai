import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Body = { text?: string };

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body: Body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const text = body.text || "";

    if (!text) {
      res.status(400).json({ error: "Missing 'text' in body" });
      return;
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Write a rhymed poem in Italian inspired by the user's story, at most 15 lines. Output only the poem.",
        },
        { role: "user", content: text },
      ],
      temperature: 0.8,
    });

    const output =
      completion.choices?.[0]?.message?.content?.toString().trim() ?? "";

    res.status(200).json({ output_text: output });
  } catch (err: any) {
    console.error("poetry error:", err);
    res.status(500).json({ error: "Poetry failed", detail: String(err?.message || err) });
  }
}

