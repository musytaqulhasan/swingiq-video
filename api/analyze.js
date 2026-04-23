export const config = { maxDuration: 60 };

// ====== BIOMECHANICS ENGINE ======
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
    // ====== DETECT P4 & P7 ======
    const wristSpeed = computeWristSpeed(frames);
    const p4 = detectP4(wristSpeed);
    const p7 = detectP7(wristSpeed);

    // Build image content — all 10 frames
    const imageContent = frames.slice(0, 10).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx + 1}`, name: `Position ${idx + 1}` };
      return [
        { type: 'text', text: `${p.position} — ${p.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    // ====== SYSTEM PROMPT WITH COMPLETE JSON SCHEMA ======
    const sys = `You are SwingIQ, an expert AI golf coach analyzing a golf swing video frame by frame.
You will receive 10 images representing positions P1 through P10 of a golf swing.

You MUST return ONLY a valid JSON object with EXACTLY this structure. No explanation, no markdown, no extra text — just the raw JSON:

{
  "overall_score": <number 0-100>,
  "coach_insight": "<2-3 kalimat ringkasan coaching dalam Bahasa Indonesia, personal dan spesifik>",
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "improvements": ["<area perbaikan 1>", "<area perbaikan 2>", "<area perbaikan 3>"],
  "phases": [
    {
      "position": "P1",
      "name": "Setup/Address",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback spesifik untuk posisi ini dalam Bahasa Indonesia>"
    },
    {
      "position": "P2",
      "name": "Takeaway",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P3",
      "name": "Backswing",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P4",
      "name": "Top of Backswing",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P5",
      "name": "Early Downswing",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P6",
      "name": "Late Downswing",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P7",
      "name": "Impact",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P8",
      "name": "Follow Through",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P9",
      "name": "Release",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    },
    {
      "position": "P10",
      "name": "Finish",
      "score": <number 0-100>,
      "status": "<good|warn|bad>",
      "feedback": "<coaching feedback>"
    }
  ],
  "angle_analysis": [
    {
      "phase": "<contoh: P1>",
      "metric": "<nama sudut atau metrik, contoh: Sudut Tulang Belakang>",
      "value": "<nilai aktual, contoh: 42°>",
      "ideal": "<nilai ideal, contoh: 40–45°>",
      "status": "<good|warn|bad>",
      "detail": "<penjelasan singkat dalam Bahasa Indonesia>"
    }
  ],
  "error_frames": [
    {
      "position": "<contoh: P3>",
      "issue": "<nama masalah singkat>",
      "actual_value": "<nilai aktual>",
      "ideal_value": "<nilai ideal>",
      "status": "<bad|warn>",
      "description": "<penjelasan kesalahan dan dampaknya dalam Bahasa Indonesia>"
    }
  ]
}

Rules:
- coach_insight MUST NOT be null or undefined. Always provide 2-3 sentences.
- phases array MUST have exactly 10 entries (P1 to P10).
- angle_analysis MUST have at least 4 entries covering key joints (spine, shoulder, hip, knee).
- error_frames: include only positions with status bad or warn. Can be empty array [] if swing is excellent.
- All text fields in Bahasa Indonesia.
- status values: ONLY use "good", "warn", or "bad" — nothing else.`;

    // ====== USER PROMPT WITH BIOMECHANICS CONTEXT ======
    const userPrompt = `Biomechanics engine mendeteksi:
- Estimasi P4 (top of backswing): frame ke-${p4}
- Estimasi P7 (impact zone): frame ke-${p7}

Gunakan ini sebagai referensi tambahan, tapi tetap validasi secara visual dari gambar.

Analisa semua 10 posisi swing di atas dan return JSON object sesuai schema.`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 3000,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [...imageContent, { type: 'text', text: userPrompt }] }
        ]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'OpenAI error' });

    let raw = d.choices[0].message.content.trim();

    // Strip markdown code fences if any
    raw = raw.replace(/```json|```/g, '').trim();

    // Extract JSON object
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');

    if (start === -1 || end === -1) {
      return res.status(500).json({
        error: 'GPT tidak return JSON valid',
        debug: raw.substring(0, 300)
      });
    }

    let result;
    try {
      result = JSON.parse(raw.substring(start, end + 1));
    } catch (parseErr) {
      return res.status(500).json({
        error: 'JSON parse error: ' + parseErr.message,
        debug: raw.substring(0, 300)
      });
    }

    // ====== SAFETY: Ensure critical fields are never undefined ======
    if (!result.coach_insight) {
      result.coach_insight = 'Analisa swing selesai. Perhatikan konsistensi posisi dan tempo swing kamu untuk hasil yang lebih baik.';
    }
    if (!Array.isArray(result.phases) || result.phases.length === 0) {
      return res.status(500).json({ error: 'GPT tidak return phases array', debug: JSON.stringify(result).substring(0, 300) });
    }
    if (!Array.isArray(result.strengths)) result.strengths = [];
    if (!Array.isArray(result.improvements)) result.improvements = [];
    if (!Array.isArray(result.angle_analysis)) result.angle_analysis = [];
    if (!Array.isArray(result.error_frames)) result.error_frames = [];

    return res.status(200).json({
      result,
      debug: { p4, p7 }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
