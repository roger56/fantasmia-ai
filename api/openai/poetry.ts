export const config = { runtime: 'nodejs' }; // forza runtime Node (così puoi usare process.env)

export default async function handler(req: any, res: any) {
  // ...
}


export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { baseText, maxLines = 15 } = req.body || {};
    if (!baseText) return res.status(400).json({ error: 'Missing baseText' });

    const prompt = `Crea una poesia in rima (massimo ${maxLines} righe) ispirata a questo testo per bambini:
${baseText}
Restituisci solo le righe della poesia.`;

    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: prompt
      })
    });
    const data = await r.json();
    const poem = data?.output_text?.trim() || '';
    return res.status(200).json({ content: poem });
  } catch (e:any) {
    return res.status(500).json({ error: e?.message || 'AI error' });
  }
}
