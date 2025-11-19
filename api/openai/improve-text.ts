export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ✅ ACCETTA SIA 'text' (vecchio) CHE 'input_text' (nuovo dal client)
    const { text, type, input_text, style, language, title, temperature } = req.body;

    // ✅ USA input_text SE PRESENTE, ALTRIMENTI text
    const textToImprove = input_text || text;
    
    if (!textToImprove) {
      return res.status(400).json({ error: "Missing 'text' or 'input_text' in body" });
    }

    // ✅ USA style SE PRESENTE, ALTRIMENTI type
    const improvementType = style || type || 'general';

    const prompt = `Migliora il seguente testo ${improvementType === 'story' ? 'narrativo' : 'descrittivo'} mantenendo lo stile originale ma rendendolo più evocativo e coinvolgente:\n\n"${textToImprove}"`;

    const completion = await client.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "Sei uno scrittore esperto. Migliora i testi mantenendo lo stile originale ma rendendoli più vividi ed emotivamente coinvolgenti."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    });

    const improvedText = completion.choices[0]?.message?.content;

    if (!improvedText) {
      throw new Error("No improved text generated");
    }

    // ✅ RITORNA ANCHE 'improvedText' PER COMPATIBILITÀ CON IL CLIENT
    return res.status(200).json({
      original: textToImprove,
      improved: improvedText,
      improvedText: improvedText,  // ⬅️ IL CLIENT SI ASPETTA QUESTO CAMPO!
      type: improvementType
    });

  } catch (err: any) {
    console.error("Text improvement error:", err);
    return res.status(500).json({
      error: "Text improvement failed",
      detail: err.message
    });
  }
}
