export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const { mode, frames } = req.body;
  if (!frames?.length) return res.status(400).json({ error: 'No frames provided' });

  try {
    // MODE 1: Detect which frames correspond to P1-P10
    if (mode === 'detect') {
      const imageContent = frames.map((f, i) => ([
        { type: 'text', text: `Frame ${i} (t=${f.timestamp.toFixed(2)}s):` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ])).flat();

      const detectRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              ...imageContent,
              { type: 'text', text: `These are ${frames.length} frames extracted evenly from a golf swing video.

Identify which frame index (0-based) best represents each of these 10 golf swing positions:
P1=Setup/Address, P2=Takeaway, P3=Backswing, P4=Top of Backswing, P5=Start Downswing, P6=Shaft Parallel Down, P7=Impact, P8=Early Follow Through, P9=Late Follow Through, P10=Finish

Rules:
- Each position must use a DIFFERENT frame index
- If a position is not clearly visible, pick the closest frame
- Order must be chronological (P1 index < P2 index < ... < P10 index)

Respond ONLY with raw JSON array, no markdown:
[{"position":"P1","name":"Setup","frame_index":0},{"position":"P2","name":"Takeaway","frame_index":2},...]` }
            ]
          }]
        })
      });
      const detectData = await detectRes.json();
      if (!detectRes.ok) return res.status(500).json({ error: detectData.error?.message });
      const raw = detectData.choices[0].message.content.replace(/```json|```/g,'').trim();
      return res.status(200).json({ positions: JSON.parse(raw) });
    }

    // MODE 2: Full analysis of 10 selected frames (P1-P10)
    if (mode === 'analyze') {
      const { positions } = req.body;
      if (!positions?.length) return res.status(400).json({ error: 'No positions provided' });

      const imageContent = positions.map(p => {
        const frame = frames[p.frame_index];
        return [
          { type: 'text', text: `${p.position} — ${p.name} (t=${frame?.timestamp?.toFixed(2)||'?'}s):` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.base64}`, detail: 'high' } }
        ];
      }).flat();

      const sys = `You are SwingIQ, expert AI golf coach. Analyze these 10 golf swing position frames (P1-P10).

For ANGLES: be highly descriptive. Instead of just "Pinggul", write "Rotasi pinggul saat impact (sudut bukaan pinggul ke target line)". Include what value means physically and consequences.

For ERROR_FRAMES: identify positions where technique needs most improvement, with frame_index references.

Respond ONLY with raw JSON, no markdown, no backticks:
{
  "overall_score": <0-100>,
  "summary": "<2 sentences Bahasa Indonesia>",
  "phases": [
    {"position":"P1","name":"Setup","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P2","name":"Takeaway","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P3","name":"Backswing","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P4","name":"Top of Backswing","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P5","name":"Start Downswing","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P6","name":"Shaft Parallel Down","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P7","name":"Impact","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P8","name":"Early Follow Through","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P9","name":"Late Follow Through","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P10","name":"Finish","score":<0-100>,"note":"<short Bahasa Indonesia>","timestamp":<sec>}
  ],
  "radar": {"setup":<0-100>,"backswing":<0-100>,"power":<0-100>,"impact":<0-100>,"follow_through":<0-100>,"balance":<0-100>},
  "angles": [
    {"position":"<P1-P10>","phase":"<name>","area":"<descriptive Bahasa Indonesia>","actual":"<value+unit>","ideal":"<range>","status":"good|warn|bad","label":"Sudah baik|Bisa dioptimalkan|Perlu perhatian","impact":"<detailed explanation Bahasa Indonesia>"}
  ],
  "error_frames": [
    {"position":"<P1-P10>","frame_index":<int>,"phase":"<name>","issue":"<short name>","description":"<Bahasa Indonesia>","actual_value":"<measured>","ideal_value":"<ideal>","status":"bad|warn"}
  ],
  "insight": "<2-3 sentences constructive Bahasa Indonesia>"
}
Provide 8-10 angles sorted worst first. Provide 3-4 error_frames.`;

      const analyzeRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 3000,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: [...imageContent, { type: 'text', text: 'Analyze all 10 swing positions. Return JSON only.' }] }
          ]
        })
      });

      const analyzeData = await analyzeRes.json();
      if (!analyzeRes.ok) return res.status(500).json({ error: analyzeData.error?.message });
      const raw = analyzeData.choices[0].message.content.replace(/```json|```/g,'').trim();
      return res.status(200).json({ result: JSON.parse(raw) });
    }

    return res.status(400).json({ error: 'Unknown mode. Use detect or analyze.' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
