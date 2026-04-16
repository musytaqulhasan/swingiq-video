export const config = { maxDuration: 60 }; // Vercel Pro allows up to 60s

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
      const scanFrames = frames.slice(0, 12); // max 12 frames for speed

      const imageContent = scanFrames.map((f, i) => ([
        { type: 'text', text: `Frame ${i}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ])).flat();

      const detectRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              ...imageContent,
              { type: 'text', text: `${scanFrames.length} frames from a golf swing (0-${scanFrames.length-1}). Map each to best frame index. Keep order P1<=P2<=...<=P10.
P1=Setup,P2=Takeaway,P3=Backswing,P4=Top,P5=StartDown,P6=ShaftParallel,P7=Impact,P8=EarlyFollow,P9=LateFollow,P10=Finish
JSON only: [{"position":"P1","name":"Setup","frame_index":0},...]` }
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
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) raw = match[0];

      const parsed = JSON.parse(raw);
      const ratio = frames.length / scanFrames.length;
      const mapped = parsed.map(p => ({
        ...p,
        frame_index: Math.min(Math.round((p.frame_index || 0) * ratio), frames.length - 1)
      }));

      return res.status(200).json({ positions: mapped });
    }

    // MODE: analyze — full analysis of selected frames
    if (mode === 'analyze') {
      if (!positions?.length) return res.status(400).json({ error: 'No positions provided' });

      const imageContent = frames.slice(0, 10).map((f, idx) => {
        const pos = positions[idx] || { position: `P${idx+1}`, name: `Frame ${idx+1}` };
        return [
          { type: 'text', text: `${pos.position} ${pos.name}:` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
        ];
      }).flat();

      const sys = `You are SwingIQ AI golf coach. Analyze 10 golf swing frames P1-P10.
For angles use descriptive Bahasa Indonesia names like "Rotasi pinggul saat impact (sudut bukaan ke target)".
Return ONLY raw JSON no markdown:
{"overall_score":<0-100>,"summary":"<2 sentences BI>","phases":[{"position":"P1","name":"Setup","score":<0-100>,"note":"<BI>","timestamp":0},{"position":"P2","name":"Takeaway","score":<0-100>,"note":"<BI>","timestamp":0.3},{"position":"P3","name":"Backswing","score":<0-100>,"note":"<BI>","timestamp":0.6},{"position":"P4","name":"Top of Backswing","score":<0-100>,"note":"<BI>","timestamp":0.9},{"position":"P5","name":"Start Downswing","score":<0-100>,"note":"<BI>","timestamp":1.1},{"position":"P6","name":"Shaft Parallel Down","score":<0-100>,"note":"<BI>","timestamp":1.3},{"position":"P7","name":"Impact","score":<0-100>,"note":"<BI>","timestamp":1.5},{"position":"P8","name":"Early Follow Through","score":<0-100>,"note":"<BI>","timestamp":1.7},{"position":"P9","name":"Late Follow Through","score":<0-100>,"note":"<BI>","timestamp":1.9},{"position":"P10","name":"Finish","score":<0-100>,"note":"<BI>","timestamp":2.1}],"radar":{"setup":<0-100>,"backswing":<0-100>,"power":<0-100>,"impact":<0-100>,"follow_through":<0-100>,"balance":<0-100>},"angles":[{"position":"<P1-P10>","phase":"<n>","area":"<descriptive BI>","actual":"<val+unit>","ideal":"<range>","status":"good|warn|bad","label":"Sudah baik|Bisa dioptimalkan|Perlu perhatian","impact":"<BI explanation>"}],"error_frames":[{"position":"<P1-P10>","frame_index":<0-9>,"phase":"<n>","issue":"<short>","description":"<BI>","actual_value":"<val>","ideal_value":"<ideal>","status":"bad|warn"}],"insight":"<2-3 sentences BI>"}
Give 6-8 angles worst first. Give 2-3 error_frames.`;

      const analyzeRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 2000,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: [...imageContent, { type: 'text', text: 'Analyze P1-P10. JSON only.' }] }
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
    return res.status(500).json({ error: err.message });
  }
}
