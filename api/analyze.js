export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const { frames, positions } = req.body;
  if (!frames?.length) return res.status(400).json({ error: 'No frames provided' });

  try {
    // Use only 3 frames: first, middle, last
    const f0 = frames[0];
    const f1 = frames[Math.floor(frames.length / 2)];
    const f2 = frames[frames.length - 1];

    const threeFrames = [f0, f1, f2].filter(Boolean);

    const imgContent = threeFrames.map((f, i) => {
      const label = ['Setup (awal swing)', 'Impact (kontak bola)', 'Finish (akhir swing)'][i];
      return [
        { type: 'text', text: `Gambar ${i+1} — ${label}:` },
        { type: 'image_url', image_url: {
          url: `data:image/jpeg;base64,${f.base64}`,
          detail: 'low'
        }}
      ];
    }).flat();

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: 'Kamu adalah SwingIQ, AI golf coach profesional. Selalu respond dalam Bahasa Indonesia. Selalu return JSON valid.'
          },
          {
            role: 'user',
            content: [
              ...imgContent,
              {
                type: 'text',
                text: `Ini adalah 3 frame dari video golf swing: setup, impact, dan finish.

Analisa teknik golf swing dari gambar-gambar ini dan return HANYA JSON berikut (tanpa markdown, tanpa backtick, langsung mulai dari {):

{"overall_score":75,"summary":"Ringkasan analisa swing dalam 2 kalimat.","phases":[{"position":"P1","name":"Setup","score":75,"note":"Catatan setup"},{"position":"P2","name":"Takeaway","score":70,"note":"Catatan takeaway"},{"position":"P3","name":"Backswing","score":68,"note":"Catatan backswing"},{"position":"P4","name":"Top of Backswing","score":65,"note":"Catatan top"},{"position":"P5","name":"Start Downswing","score":70,"note":"Catatan downswing awal"},{"position":"P6","name":"Shaft Parallel Down","score":72,"note":"Catatan shaft"},{"position":"P7","name":"Impact","score":74,"note":"Catatan impact"},{"position":"P8","name":"Early Follow Through","score":73,"note":"Catatan follow through awal"},{"position":"P9","name":"Late Follow Through","score":75,"note":"Catatan follow through akhir"},{"position":"P10","name":"Finish","score":72,"note":"Catatan finish"}],"radar":{"setup":75,"backswing":66,"power":71,"impact":74,"follow_through":74,"balance":72},"angles":[{"position":"P4","area":"Rotasi bahu saat top of backswing","actual":"72 derajat","ideal":"90 derajat","status":"warn","label":"Bisa dioptimalkan","impact":"Rotasi kurang menyebabkan kehilangan power"},{"position":"P7","area":"Posisi pinggul saat impact","actual":"30 derajat","ideal":"45 derajat","status":"bad","label":"Perlu perhatian","impact":"Pinggul kurang terbuka"}],"error_frames":[{"position":"P4","frame_index":1,"issue":"Rotasi bahu kurang","description":"Bahu perlu berputar lebih penuh","actual_value":"72 derajat","ideal_value":"90 derajat","status":"warn"}],"insight":"Insight coach dalam 2-3 kalimat Bahasa Indonesia."}`
              }
            ]
          }
        ]
      })
    });

    const d = await r.json();
    if (!r.ok) {
      return res.status(500).json({ error: d.error?.message || 'OpenAI error', detail: d });
    }

    let raw = d.choices[0].message.content.trim();
    raw = raw.replace(/```json|```/g, '').trim();

    // Find JSON object
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');

    if (start === -1 || end === -1) {
      return res.status(500).json({
        error: 'GPT tidak return JSON',
        gpt_response: raw.substring(0, 500)
      });
    }

    const jsonStr = raw.substring(start, end + 1);
    const result = JSON.parse(jsonStr);
    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
