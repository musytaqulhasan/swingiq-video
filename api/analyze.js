export const config = { maxDuration: 60 };

// ====== NEW: BIOMECHANICS ENGINE ======
function computeWristSpeed(frames) {
  const speeds = [];

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].right_wrist;
    const curr = frames[i].right_wrist;

    if (!prev || !curr) {
      speeds.push(0);
      continue;
    }

    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;

    const speed = Math.sqrt(dx * dx + dy * dy);
    speeds.push(speed);
  }

  return speeds;
}

function detectP4(wristSpeed) {
  for (let i = 1; i < wristSpeed.length - 1; i++) {
    if (
      wristSpeed[i] < wristSpeed[i - 1] &&
      wristSpeed[i] < wristSpeed[i + 1]
    ) {
      return i;
    }
  }
  return 0;
}

function detectP7(wristSpeed) {
  let max = 0;
  let index = 0;

  wristSpeed.forEach((v, i) => {
    if (v > max) {
      max = v;
      index = i;
    }
  });

  return index;
}

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
    // ====== NEW: DETECT P4 & P7 ======
    const wristSpeed = computeWristSpeed(frames);
    const p4 = detectP4(wristSpeed);
    const p7 = detectP7(wristSpeed);

    // Build image content - all 10 frames
    const imageContent = frames.slice(0, 10).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx+1}`, name: `Position ${idx+1}` };

      return [
        { type: 'text', text: `${p.position} — ${p.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    const sys = `You are SwingIQ, an expert AI golf coach.
Analyze golf swing positions.
Return ONLY JSON.`;

    // ====== UPDATED PROMPT (inject P4 & P7 insight) ======
    const userPrompt = `System detected key events:
- Estimated P4 (top): frame ${p4}
- Estimated P7 (impact): frame ${p7}

Use this as reference but validate visually.

Return JSON analysis.`;

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
      return res.status(500).json({
        error: 'GPT tidak return JSON',
        debug: raw.substring(0, 300)
      });
    }

    const result = JSON.parse(raw.substring(start, end + 1));

    // ====== NEW: RETURN EXTRA DATA ======
    return res.status(200).json({
      result,
      debug: {
        p4,
        p7
      }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
