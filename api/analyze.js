export const config = { maxDuration: 60 };

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
    if (mode === 'analyze') {
      if (!positions?.length) return res.status(400).json({ error: 'No positions provided' });

      // Pick 3 key frames: setup(P1), impact(P7), finish(P10) for quick analysis
      // Then do full P1-P10 scoring based on these
      const keyIndices = [0, 6, 9]; // P1, P7, P10
      const keyFrames = keyIndices.map(i => {
        const f = frames[Math.min(i, frames.length-1)];
        const p = positions[i] || positions[positions.length-1];
        return { frame: f, pos: p };
      }).filter(x => x.frame);

      const imageContent = keyFrames.map(({frame, pos}) => [
        { type: 'text', text: `${pos.position} ${pos.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.base64}`, detail: 'low' } }
      ]).flat();

      // Also include P4 (top) and P7 (impact) as most important
      const extraIndices = [3, 6];
      const extraFrames = extraIndices.map(i => {
        const f = frames[Math.min(i, frames.length-1)];
        const p = positions[i] || positions[0];
        return { frame: f, pos: p };
      }).filter(x => x.frame);

      const allImageContent = [
        ...imageContent,
        ...extraFrames.map(({frame, pos}) => [
          { type: 'text', text: `${pos.position} ${pos.name}:` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.base64}`, detail: 'low' } }
        ]).flat()
      ];

      const positionsList = positions.map(p => `{"position":"${p.position}","name":"${p.name}","score":<0-100>,"note":"<BI>","timestamp":${p.frame_index * 0.2}}`).join(',');

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 2000,
          messages: [
            { role: 'system', content: 'You are SwingIQ AI golf coach. Analyze golf swing frames. Return ONLY raw JSON no markdown.' },
            { role: 'user', content: [
              ...allImageContent,
              { type: 'text', text: `Based on these key swing frames, analyze the complete P1-P10 golf swing.
Estimate scores for ALL 10 positions based on what you see.

Return ONLY this JSON structure:
{
  "overall_score": <0-100>,
  "summary": "<2 sentences Bahasa Indonesia>",
  "phases": [${positionsList}],
  "radar": {"setup":<0-100>,"backswing":<0-100>,"power":<0-100>,"impact":<0-100>,"follow_through":<0-100>,"balance":<0-100>},
  "angles": [
    {"position":"<P1-P10>","area":"<descriptive Bahasa Indonesia e.g. Rotasi bahu saat backswing (sudut rotasi terhadap target line)>","actual":"<value+unit>","ideal":"<range>","status":"good|warn|bad","label":"Sudah baik|Bisa dioptimalkan|Perlu perhatian","impact":"<1 sentence BI explaining consequence>"}
  ],
  "error_frames": [
    {"position":"<P1-P10>","frame_index":<0-9>,"issue":"<short name>","description":"<BI>","actual_value":"<val>","ideal_value":"<ideal>","status":"bad|warn"}
  ],
  "insight": "<2-3 sentences constructive Bahasa Indonesia>"
}
Provide 5-7 angles sorted worst first. Provide 2-3 error_frames.` }
            ]}
          ]
        })
      });

      const d = await r.json();
      if (!r.ok) return res.status(500).json({ error: d.error?.message || 'OpenAI error', detail: d });

      let raw = d.choices[0].message.content.replace(/```json|```/g,'').trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(500).json({ error: 'Invalid JSON from GPT', raw: raw.substring(0,200) });

      return res.status(200).json({ result: JSON.parse(m[0]) });
    }

    return res.status(400).json({ error: 'Unknown mode. Use: analyze' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
