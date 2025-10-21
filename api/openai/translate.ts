export const config = { runtime: 'nodejs' }; // forza runtime Node (così puoi usare process.env)

export default async function handler(req: any, res: any) {
  // ...
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { title, content, targetLang = 'en' } = req.body || {};
    if (!content) return res.status(400).json({ error: 'Missing content' });

    const prompt = `Traduci in ${targetLang} il seguente titolo e testo. 
Restituisci JSON con chiavi: title, content. Non aggiungere commenti.
TITOLO:\n${title || ''}
TESTO:\n${content}`;

    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: prompt,
        text_format: { type: 'json_object' }
      })
    });
    const data = await r.json();
    const json = JSON.parse(data?.output_text || '{}');
    return res.status(200).json({ title: json.title || '', content: json.content || '' });
  } catch (e:any) {
    return res.status(500).json({ error: e?.message || 'AI error' });
  }
}
