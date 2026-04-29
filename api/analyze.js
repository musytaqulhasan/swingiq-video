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

function estimateShaftAngle(frame) {
  const wrist = frame.right_wrist;
  const elbow = frame.right_elbow;
  if (!wrist || !elbow) return null;
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  return Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
}

function detectP4(wristSpeed) {
  for (let i = 1; i < wristSpeed.length - 1; i++) {
    if (wristSpeed[i] < wristSpeed[i - 1] && wristSpeed[i] < wristSpeed[i + 1]) return i;
  }
  return 0;
}

function detectP6(frames) {
  for (let i = 0; i < frames.length; i++) {
    const angle = estimateShaftAngle(frames[i]);
    if (angle !== null && angle < 30) return i;
  }
  return null;
}

function detectP7Speed(wristSpeed) {
  let max = 0, index = 0;
  wristSpeed.forEach((v, i) => { if (v > max) { max = v; index = i; } });
  return index;
}

function detectP7Shaft(frames) {
  let bestIndex = 0, bestScore = 999;
  frames.forEach((f, i) => {
    const angle = estimateShaftAngle(f);
    if (angle === null) return;
    const diff = Math.abs(angle - 80);
    if (diff < bestScore) { bestScore = diff; bestIndex = i; }
  });
  return bestIndex;
}

function buildViewContext(viewAngle) {
  if (viewAngle === 'dtl') return 'Camera: DOWN THE LINE (DTL). Focus: swing plane, club path, spine angle, shaft lean.';
  if (viewAngle === 'face-on') return 'Camera: FACE ON. Focus: weight transfer, hip rotation, shoulder tilt, head position.';
  return 'Camera: general view.';
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
  console.log('frames:', frames?.length, 'viewAngle:', viewAngle);
  if (!frames?.length) return res.status(400).json({ error: 'No frames provided' });

  try {
    // Biomechanics
    const wristSpeed = computeWristSpeed(frames);
    const p4 = detectP4(wristSpeed);
    const p6 = detectP6(frames);
    const p7_speed = detectP7Speed(wristSpeed);
    const p7_shaft = detectP7Shaft(frames);
    const p7 = Math.round((p7_speed + p7_shaft) / 2);

    // Tempo
    let tempoData = null;
    try {
      const t0 = frames[0].timestamp, tP4 = frames[Math.min(p4, frames.length-1)].timestamp;
      const tP7 = frames[Math.min(p7, frames.length-1)].timestamp, tEnd = frames[frames.length-1].timestamp;
      const bs = tP4 - t0, ds = tP7 - tP4, ft = tEnd - tP7;
      if (ds > 0) {
        tempoData = {
          backswing_ms: Math.round(bs * 1000),
          downswing_ms: Math.round(ds * 1000),
          follow_ms: Math.round(ft * 1000),
          ratio: `${(bs/ds).toFixed(1)}:1:${(ft/ds).toFixed(1)}`,
          classification: bs/ds >= 3 ? 'Lambat & Terkontrol' : bs/ds >= 2 ? 'Sedang' : 'Terlalu Cepat'
        };
      }
    } catch(e) {}

    const viewCtx = buildViewContext(viewAngle);
    const viewLabel = viewAngle === 'dtl' ? 'Down the Line (DTL)' : viewAngle === 'face-on' ? 'Face On' : 'General';

    const imageContent = frames.slice(0, 10).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx+1}`, name: `Position ${idx+1}` };
      return [
        { type: 'text', text: `${p.position} — ${p.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    // Compact but complete schema
    const sys = `You are SwingIQ, an expert AI golf coach. ${viewCtx}
Analyze the golf swing and return ONLY valid JSON with NO markdown, NO explanation.
Required JSON structure:
{
  "overall_score": <number 0-100>,
  "view_angle": "<view>",
  "coach_insight": "<2-3 sentences coaching summary in Bahasa Indonesia>",
  "focus_fault": "<main fault max 5 words>",
  "focus_sub": "<1 sentence ball flight impact in Bahasa Indonesia>",
  "coach_says": "<2-3 natural human sentences in Bahasa Indonesia, NOT technical>",
  "why": "<1-2 sentences why this fault happens in Bahasa Indonesia>",
  "fix_drill": "<drill name>",
  "fix_feel": "<1 sentence feel cue in Bahasa Indonesia>",
  "strengths": ["<s1>","<s2>","<s3>"],
  "improvements": ["<real result 1>","<real result 2>","<real result 3>"],
  "phases": [
    {"position":"P1","name":"Setup/Address","score":<0-100>,"status":"<good|warn|bad>","feedback":"<Bahasa Indonesia>"},
    {"position":"P2","name":"Takeaway","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},
    {"position":"P3","name":"Backswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},
    {"position":"P4","name":"Top of Backswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},
    {"position":"P5","name":"Downswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},
    {"position":"P6","name":"Impact","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},
    {"position":"P7","name":"Follow Through","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},
    {"position":"P8","name":"Finish","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"}
  ],
  "angle_analysis": [
    {"phase":"<P1-P8>","metric":"<metric>","value":"<actual>","ideal":"<ideal>","status":"<good|warn|bad>","detail":"<Bahasa Indonesia>"}
  ],
  "error_frames": [
    {"position":"<Px>","issue":"<fault>","actual_value":"<actual>","ideal_value":"<ideal>","status":"<bad|warn>","description":"<Bahasa Indonesia>"}
  ]
}
CRITICAL: phases array MUST have exactly 8 objects. Return raw JSON only.`;

    const userPrompt = `View: ${viewLabel}
Biomechanics: P4=frame${p4}, P6=frame${p6 ?? 'n/a'}, P7=frame${p7}${tempoData ? `, Tempo=${tempoData.ratio} (${tempoData.classification})` : ''}
Analyze all 8 positions and return the JSON.`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [...imageContent, { type: 'text', text: userPrompt }] }
        ]
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.error?.message || 'OpenAI error' });

    const choice = d.choices[0];
    console.log('finish_reason:', choice.finish_reason, 'tokens:', d.usage?.completion_tokens);

    let raw = choice.message.content.trim().replace(/```json|```/g, '').trim();
    console.log('GPT RAW (first 500):', raw.substring(0, 500));
    console.log('GPT RAW length:', raw.length);

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'GPT tidak return JSON valid', debug: raw.substring(0, 500) });
    }

    let result;
    try {
      result = JSON.parse(raw.substring(start, end + 1));
    } catch(e) {
      return res.status(500).json({ error: 'JSON parse error: ' + e.message, debug: raw.substring(0, 300) });
    }

    // Safety fallbacks
    if (!result.coach_insight) result.coach_insight = 'Analisa swing selesai. Perhatikan konsistensi posisi dan tempo.';
    if (!Array.isArray(result.phases) || result.phases.length === 0) {
      return res.status(500).json({
        error: 'GPT tidak return phases',
        result_keys: Object.keys(result),
        finish_reason: choice.finish_reason,
        debug: raw.substring(0, 500)
      });
    }
    if (!Array.isArray(result.strengths)) result.strengths = [];
    if (!Array.isArray(result.improvements)) result.improvements = ['Konsistensi swing meningkat', 'Ball flight lebih terprediksi', 'Jarak bisa bertambah'];
    if (!Array.isArray(result.angle_analysis)) result.angle_analysis = [];
    if (!Array.isArray(result.error_frames)) result.error_frames = [];
    if (!result.view_angle) result.view_angle = viewLabel;
    if (!result.focus_fault) result.focus_fault = result.error_frames[0]?.issue || 'Konsistensi swing';
    if (!result.focus_sub) result.focus_sub = result.improvements[0] || '';
    if (!result.coach_says) result.coach_says = result.coach_insight;
    if (!result.why) result.why = result.error_frames[0]?.description || result.coach_insight;
    if (!result.fix_drill) result.fix_drill = 'Hip Bump Drill';
    if (!result.fix_feel) result.fix_feel = 'Fokus pada transisi yang mulus dari backswing ke downswing.';
    if (tempoData) result.tempo = tempoData;

    return res.status(200).json({ result, debug: { p4, p6, p7, p7_speed, p7_shaft, tempo: tempoData } });

  } catch (err) {
    console.error('analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
