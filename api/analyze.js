export const config = { maxDuration: 60 };

// ====== BIOMECHANICS ENGINE ======
function computeWristSpeed(frames) {
  const speeds = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].right_wrist;
    const curr = frames[i].right_wrist;
    if (!prev || !curr) { speeds.push(0); continue; }
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    speeds.push(Math.sqrt(dx * dx + dy * dy));
  }
  return speeds;
}

// ====== SHAFT (PROXY via elbow-wrist) ======
function estimateShaftAngle(frame) {
  const wrist = frame.right_wrist;
  const elbow = frame.right_elbow;
  if (!wrist || !elbow) return null;

  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;

  const angleRad = Math.atan2(dy, dx);
  return Math.abs(angleRad * 180 / Math.PI); // 0 = horizontal, 90 = vertical
}

// ====== EVENT DETECTION ======
function detectP4(wristSpeed) {
  for (let i = 1; i < wristSpeed.length - 1; i++) {
    if (wristSpeed[i] < wristSpeed[i - 1] && wristSpeed[i] < wristSpeed[i + 1]) {
      return i;
    }
  }
  return 0;
}

// NEW: P6 (shaft horizontal)
function detectP6(frames) {
  for (let i = 0; i < frames.length; i++) {
    const angle = estimateShaftAngle(frames[i]);
    if (angle !== null && angle < 30) {
      return i;
    }
  }
  return null;
}

// OLD: speed-based
function detectP7Speed(wristSpeed) {
  let max = 0, index = 0;
  wristSpeed.forEach((v, i) => {
    if (v > max) {
      max = v;
      index = i;
    }
  });
  return index;
}

// NEW: shaft-based
function detectP7Shaft(frames) {
  let bestIndex = 0;
  let bestScore = 999;

  frames.forEach((f, i) => {
    const angle = estimateShaftAngle(f);
    if (angle === null) return;

    const diff = Math.abs(angle - 80); // near vertical
    if (diff < bestScore) {
      bestScore = diff;
      bestIndex = i;
    }
  });

  return bestIndex;
}

// ====== VIEW CONTEXT (UNCHANGED) ======
function buildViewContext(viewAngle) {
  if (viewAngle === 'dtl') {
    return {
      cameraDesc: `Camera angle: DOWN THE LINE (DTL)`,
      focusAreas: `Fokus: swing plane, club path, spine angle`,
      angleMetrics: ['Swing plane', 'Spine angle', 'Shaft lean']
    };
  }

  if (viewAngle === 'face-on') {
    return {
      cameraDesc: `Camera angle: FACE ON`,
      focusAreas: `Fokus: weight shift, hip rotation, balance`,
      angleMetrics: ['Hip rotation', 'Weight shift', 'Balance']
    };
  }

  return {
    cameraDesc: 'General view',
    focusAreas: 'General analysis',
    angleMetrics: ['General']
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const { frames, positions, viewAngle } = req.body;
  if (!frames?.length) return res.status(400).json({ error: 'No frames provided' });

  try {
    // ====== CORE DETECTION ======
    const wristSpeed = computeWristSpeed(frames);

    const p4 = detectP4(wristSpeed);
    const p6 = detectP6(frames);

    const p7_speed = detectP7Speed(wristSpeed);
    const p7_shaft = detectP7Shaft(frames);

    // COMBINE (IMPORTANT)
    const p7 = Math.round((p7_speed + p7_shaft) / 2);

    // ====== VIEW CONTEXT ======
    const viewCtx = buildViewContext(viewAngle);
    const viewLabel = viewAngle || 'General';

    const imageContent = frames.slice(0, 10).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx + 1}`, name: `Position ${idx + 1}` };
      return [
        { type: 'text', text: `${p.position} — ${p.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    const sys = `You are SwingIQ, AI golf coach. Return JSON only.`;

    const userPrompt = `Camera: ${viewLabel}
Detected:
P4: ${p4}
P6: ${p6}
P7: ${p7}

Analyze swing and return JSON.`;

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
      return res.status(500).json({ error: 'Invalid JSON from GPT', debug: raw.substring(0, 300) });
    }

    const result = JSON.parse(raw.substring(start, end + 1));

    return res.status(200).json({
      result,
      debug: {
        p4,
        p6,
        p7,
        p7_speed,
        p7_shaft
      }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
