// Vercel Edge Function oppure Node runtime
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { text, tone } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const prompt = `Migliora il seguente testo per bambini (6-11 anni). Tono: ${tone || 'gentile e chiaro'}.
Restituisci SOLO il testo migliorato, niente meta-spiegazioni.
Testo:
${text}`;

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
    const improved = data?.output_text?.trim() || '';
    return res.status(200).json({ content: improved });
  } catch (e:any) {
    return res.status(500).json({ error: e?.message || 'AI error' });
  }
}
