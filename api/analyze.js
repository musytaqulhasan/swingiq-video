export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const { mode, frames, positions } = req.body;
  if (!frames?.length) return res.status(400).json({ error: 'No frames provided' });

  try {
    // MODE: detect — find which frames are P1-P10
    if (mode === 'detect') {
      // Limit to max 15 frames for detection to avoid timeout
      const scanFrames = frames.slice(0, 15);

      const imageContent = scanFrames.map((f, i) => ([
        { type: 'text', text: `Frame ${i}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ])).flat();

      const detectRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              ...imageContent,
              { type: 'text', text: `These are ${scanFrames.length} frames from a golf swing video (frames 0-${scanFrames.length-1}).

Map each P position to the best matching frame index (0-${scanFrames.length-1}):
P1=Setup, P2=Takeaway, P3=Backswing, P4=Top of Backswing, P5=Start Downswing, P6=Shaft Parallel Down, P7=Impact, P8=Early Follow Through, P9=Late Follow Through, P10=Finish

- Use different frame for each position
- Keep order: P1 index <= P2 index <= ... <= P10 index
- If swing is short, reuse nearby frames

Respond ONLY raw JSON array no markdown:
[{"position":"P1","name":"Setup","frame_index":0},...]` }
            ]
          }]
        })
      });

      if (!detectRes.ok) {
        const err = await detectRes.json();
        return res.status(500).json({ error: err.error?.message || 'Detection failed' });
      }

      const detectData = await detectRes.json();
      let raw = detectData.choices[0].message.content.replace(/```json|```/g,'').trim();
      // Extract JSON array if wrapped in text
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) raw = match[0];

      const parsed = JSON.parse(raw);
      // Map back to original frame indices (since we sliced to 15)
      const ratio = frames.length / scanFrames.length;
      const mapped = parsed.map(p => ({
        ...p,
        frame_index: Math.min(Math.round(p.frame_index * ratio), frames.length - 1)
      }));

      return res.status(200).json({ positions: mapped });
    }

    // MODE: analyze — full analysis of 10 selected frames
    if (mode === 'analyze') {
      if (!positions?.length) return res.status(400).json({ error: 'No positions provided' });

      const imageContent = frames.map((f, idx) => {
        const pos = positions[idx] || { position: `F${idx}`, name: `Frame ${idx}` };
        return [
          { type: 'text', text: `${pos.position} — ${pos.name}:` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'high' } }
        ];
      }).flat();

      const sys = `You are SwingIQ, expert AI golf coach analyzing 10 golf swing positions P1-P10.

For ANGLES: be highly descriptive. E.g. "Rotasi pinggul saat impact (sudut bukaan pinggul ke target line)". Explain what value means and consequences.

Respond ONLY with raw JSON no markdown no backticks:
{
  "overall_score": <0-100>,
  "summary": "<2 sentences Bahasa Indonesia>",
  "phases": [
    {"position":"P1","name":"Setup","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P2","name":"Takeaway","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P3","name":"Backswing","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P4","name":"Top of Backswing","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P5","name":"Start Downswing","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P6","name":"Shaft Parallel Down","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P7","name":"Impact","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P8","name":"Early Follow Through","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P9","name":"Late Follow Through","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>},
    {"position":"P10","name":"Finish","score":<0-100>,"note":"<Bahasa Indonesia>","timestamp":<sec>}
  ],
  "radar": {"setup":<0-100>,"backswing":<0-100>,"power":<0-100>,"impact":<0-100>,"follow_through":<0-100>,"balance":<0-100>},
  "angles": [
    {"position":"<P1-P10>","phase":"<name>","area":"<descriptive Bahasa Indonesia>","actual":"<value+unit>","ideal":"<range>","status":"good|warn|bad","label":"Sudah baik|Bisa dioptimalkan|Perlu perhatian","impact":"<detailed Bahasa Indonesia>"}
  ],
  "error_frames": [
    {"position":"<P1-P10>","frame_index":<0-9>,"phase":"<name>","issue":"<short>","description":"<Bahasa Indonesia>","actual_value":"<val>","ideal_value":"<ideal>","status":"bad|warn"}
  ],
  "insight": "<2-3 sentences Bahasa Indonesia>"
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

      if (!analyzeRes.ok) {
        const err = await analyzeRes.json();
        return res.status(500).json({ error: err.error?.message || 'Analysis failed' });
      }

      const analyzeData = await analyzeRes.json();
      let raw = analyzeData.choices[0].message.content.replace(/```json|```/g,'').trim();
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) raw = match[0];

      return res.status(200).json({ result: JSON.parse(raw) });
    }

    return res.status(400).json({ error: 'Unknown mode' });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.split('\n')[0] });
  }
}
