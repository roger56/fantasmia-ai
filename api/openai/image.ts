export const config = { runtime: 'nodejs' }; // forza runtime Node (così puoi usare process.env)

export default async function handler(req: any, res: any) {
  // ...
}


export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { prompt, style = 'watercolor' } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const fullPrompt = `${prompt}\n\nIMPORTANT: no text in the image. Style: ${style}. For kids 6-11.`;

    const r = await fetch('https://api.openai.com/v1/images', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: fullPrompt,
        size: '1024x1024',
        response_format: 'b64_json'
      })
    });
    const data = await r.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: 'No image from model' });

    const dataUrl = `data:image/png;base64,${b64}`;
    return res.status(200).json({ dataUrl });
  } catch (e:any) {
    return res.status(500).json({ error: e?.message || 'AI error' });
  }
}
