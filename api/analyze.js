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
    // Pick 4 key frames: P1, P4, P7, P10
    const keyIdx = [0, 3, 6, 9];
    const keyFrames = keyIdx.map(i => {
      const fi = Math.min(i, frames.length - 1);
      const p = (positions || [])[i] || { position: `P${i+1}`, name: ['Setup','Top of Backswing','Impact','Finish'][keyIdx.indexOf(i)] };
      return { base64: frames[fi].base64, label: `${p.position} ${p.name}` };
    });

    const imgContent = keyFrames.map(f => ([
      { type: 'text', text: f.label + ':' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
    ])).flat();

    const prompt = `You are a golf coach AI. Analyze these 4 key frames of a golf swing (P1=Setup, P4=Top of Backswing, P7=Impact, P10=Finish).

IMPORTANT: Respond with ONLY a valid JSON object. No explanation, no markdown, no backticks. Start directly with {

{
  "overall_score": 72,
  "summary": "Swing kamu menunjukkan...",
  "phases": [
    {"position":"P1","name":"Setup","score":75,"note":"Posisi setup sudah cukup baik"},
    {"position":"P2","name":"Takeaway","score":70,"note":"Takeaway perlu diperbaiki"},
    {"position":"P3","name":"Backswing","score":68,"note":"Backswing kurang penuh"},
    {"position":"P4","name":"Top of Backswing","score":65,"note":"Top position belum optimal"},
    {"position":"P5","name":"Start Downswing","score":70,"note":"Transisi downswing"},
    {"position":"P6","name":"Shaft Parallel Down","score":72,"note":"Shaft plane cukup baik"},
    {"position":"P7","name":"Impact","score":74,"note":"Impact position sudah baik"},
    {"position":"P8","name":"Early Follow Through","score":73,"note":"Follow through awal"},
    {"position":"P9","name":"Late Follow Through","score":75,"note":"Follow through akhir"},
    {"position":"P10","name":"Finish","score":72,"note":"Finish position"}
  ],
  "radar": {"setup":75,"backswing":66,"power":71,"impact":74,"follow_through":74,"balance":72},
  "angles": [
    {"position":"P4","area":"Rotasi bahu saat top of backswing","actual":"72 derajat","ideal":"90 derajat","status":"warn","label":"Bisa dioptimalkan","impact":"Rotasi bahu yang kurang menyebabkan power berkurang saat impact"},
    {"position":"P7","area":"Posisi pinggul saat impact","actual":"30 derajat","ideal":"45 derajat","status":"bad","label":"Perlu perhatian","impact":"Pinggul kurang terbuka menyebabkan flipping di impact"}
  ],
  "error_frames": [
    {"position":"P4","frame_index":3,"issue":"Rotasi bahu kurang","description":"Bahu hanya berputar 72 derajat, idealnya 90 derajat","actual_value":"72 derajat","ideal_value":"90 derajat","status":"warn"}
  ],
  "insight": "Fokus pada rotasi bahu yang lebih penuh dan posisi pinggul saat impact."
}

Now analyze the actual frames provided and return a JSON with the same structure but with REAL values based on what you see. Return ONLY the JSON object starting with {`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 2000,
        messages: [
          { role: 'user', content: [...imgContent, { type: 'text', text: prompt }] }
        ]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'OpenAI error' });

    let raw = d.choices[0].message.content.trim();

    // Try to extract JSON
    raw = raw.replace(/```json|```/g, '').trim();
    const startIdx = raw.indexOf('{');
    const endIdx = raw.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1) {
      return res.status(500).json({ error: 'Invalid JSON from GPT', preview: raw.substring(0, 300) });
    }
    raw = raw.substring(startIdx, endIdx + 1);

    const result = JSON.parse(raw);
    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
