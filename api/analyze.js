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
    // Build image content - all 10 frames with position labels
    const imageContent = frames.slice(0, 10).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx+1}`, name: `Position ${idx+1}` };
      const visualCue = [
        'Club at address, weight balanced, upright posture',
        'Club low and moving back, hands hip height',
        'Club shaft around horizontal, shoulder turn starting',
        'Club at top, max shoulder turn, lead arm high',
        'Club coming down, hips shifting to target',
        'Shaft parallel to ground, wrist lag maintained',
        'Club at ball, arms extended, hips open',
        'Club past ball, chest rotating to target',
        'Club high on follow through, body rotating',
        'Full finish, weight on lead foot, club behind head'
      ][idx] || '';
      return [
        { type: 'text', text: `${p.position} — ${p.name} (${visualCue}):` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    const sys = `You are SwingIQ, an expert AI golf coach with deep knowledge of golf biomechanics.
You are analyzing 10 specific positions of a golf swing (P1-P10) from video frames.
Each frame was selected by AI to match the labeled position.

Analyze each position carefully based on what you actually see in the image.
Be specific and technical in your angle descriptions.
Always write in Bahasa Indonesia.
Return ONLY raw JSON, no markdown, no backticks, start directly with {`;

    const userPrompt = `Analyze these 10 golf swing positions and return a detailed assessment.

For each ANGLE you detect, describe it as a professional golf coach would:
- Name it specifically (e.g., "Sudut inklinasi tulang belakang saat address", not just "postur")
- Give the measured value AND what it means physically
- Explain the consequence if it deviates from ideal

Return this exact JSON structure:
{
  "overall_score": <0-100>,
  "summary": "<2 sentences in Bahasa Indonesia summarizing the swing quality>",
  "phases": [
    {"position":"P1","name":"Setup","score":<0-100>,"note":"<specific observation about what you see in THIS frame>","timestamp":0},
    {"position":"P2","name":"Takeaway","score":<0-100>,"note":"<specific>","timestamp":0.2},
    {"position":"P3","name":"Backswing","score":<0-100>,"note":"<specific>","timestamp":0.5},
    {"position":"P4","name":"Top of Backswing","score":<0-100>,"note":"<specific>","timestamp":0.8},
    {"position":"P5","name":"Start Downswing","score":<0-100>,"note":"<specific>","timestamp":1.0},
    {"position":"P6","name":"Shaft Parallel Down","score":<0-100>,"note":"<specific>","timestamp":1.1},
    {"position":"P7","name":"Impact","score":<0-100>,"note":"<specific>","timestamp":1.3},
    {"position":"P8","name":"Early Follow Through","score":<0-100>,"note":"<specific>","timestamp":1.5},
    {"position":"P9","name":"Late Follow Through","score":<0-100>,"note":"<specific>","timestamp":1.7},
    {"position":"P10","name":"Finish","score":<0-100>,"note":"<specific>","timestamp":2.0}
  ],
  "radar": {
    "setup": <0-100>,
    "backswing": <0-100>,
    "power": <0-100>,
    "impact": <0-100>,
    "follow_through": <0-100>,
    "balance": <0-100>
  },
  "angles": [
    {
      "position": "<P1-P10>",
      "area": "<specific descriptive name in BI, e.g. Inklinasi tulang belakang saat address (sudut condong ke depan dari vertikal)>",
      "actual": "<measured value with unit, e.g. 28 derajat>",
      "ideal": "<ideal range, e.g. 25-35 derajat>",
      "status": "good|warn|bad",
      "label": "Sudah baik|Bisa dioptimalkan|Perlu perhatian",
      "impact": "<specific explanation: what this means physically, what goes wrong if outside ideal range, and one specific correction tip>"
    }
  ],
  "error_frames": [
    {
      "position": "<P1-P10 with the worst issue>",
      "frame_index": <0-9>,
      "issue": "<short issue name>",
      "description": "<specific description of what you see wrong in this frame, in BI>",
      "actual_value": "<measured>",
      "ideal_value": "<ideal>",
      "status": "bad|warn"
    }
  ],
  "insight": "<2-3 sentences of actionable coaching advice in Bahasa Indonesia, mentioning the most impactful improvement>"
}

Provide 6-8 angles sorted by severity (worst first).
Provide 2-3 error_frames for the most critical issues.
Base ALL observations on what you actually see in the frames provided.`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 2500,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [...imageContent, { type: 'text', text: userPrompt }] }
        ]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'OpenAI error' });

    let raw = d.choices[0].message.content.trim();
    raw = raw.replace(/```json|```/g, '').trim();

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'GPT tidak return JSON', gpt_response: raw.substring(0, 300) });
    }

    const result = JSON.parse(raw.substring(start, end + 1));
    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
