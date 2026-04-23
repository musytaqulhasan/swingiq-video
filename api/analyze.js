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

function detectP4(wristSpeed) {
  for (let i = 1; i < wristSpeed.length - 1; i++) {
    if (wristSpeed[i] < wristSpeed[i - 1] && wristSpeed[i] < wristSpeed[i + 1]) return i;
  }
  return 0;
}

function detectP7(wristSpeed) {
  let max = 0, index = 0;
  wristSpeed.forEach((v, i) => { if (v > max) { max = v; index = i; } });
  return index;
}

// ====== VIEW-SPECIFIC PROMPT BUILDER ======
function buildViewContext(viewAngle) {
  if (viewAngle === 'dtl') {
    return {
      cameraDesc: `Camera angle: DOWN THE LINE (DTL) — kamera berada di belakang pemain, searah target line.
Dari sudut ini kamu bisa melihat dengan jelas:
- Club path dan swing plane
- Spine angle dan postur dari samping
- Hip hinge dan knee flex
- Posisi club face dan hosel
- Plane shift antara backswing dan downswing`,

      focusAreas: `Untuk sudut DTL, fokus analisa pada:
1. SWING PLANE: apakah club berada on-plane, over-the-top, atau under-plane di setiap fase
2. SPINE ANGLE: apakah sudut tulang belakang konsisten dari P1 sampai P7 (early extension / sway)
3. CLUB PATH: apakah path sesuai target line atau in-to-out / out-to-in
4. HIP HINGE: kedalaman hip hinge di setup (P1) dan konsistensinya
5. WRIST CONDITIONS: flat, cupped, atau bowed di P4 (top of backswing)
6. TRAIL ELBOW: posisi siku kanan (trail arm) di P4 dan P6 — apakah tuck atau flying
7. IMPACT ALIGNMENT: apakah shaft lean positif di P7`,

      angleMetrics: [
        'Swing plane angle (DTL)',
        'Spine tilt angle at setup vs impact',
        'Trail elbow position at P4',
        'Club face angle at top (P4)',
        'Shaft lean at impact (P7)',
        'Hip hinge depth at address (P1)'
      ]
    };
  }

  if (viewAngle === 'face-on') {
    return {
      cameraDesc: `Camera angle: FACE ON — kamera berada di depan pemain, tegak lurus terhadap target line.
Dari sudut ini kamu bisa melihat dengan jelas:
- Weight transfer dan lateral shift
- Hip dan shoulder tilt/turn
- Posisi kepala (head movement lateral)
- Knee flex dan foot pressure
- Arm width dan extension
- Reverse pivot vs proper weight shift`,

      focusAreas: `Untuk sudut Face On, fokus analisa pada:
1. WEIGHT TRANSFER: pergerakan berat badan dari kanan ke kiri saat downswing
2. HIP TURN & TILT: rotasi dan tilt pinggul dari P1 hingga P10
3. SHOULDER TILT: kemiringan bahu di P4 — lead shoulder harus lebih rendah dari trail shoulder
4. HEAD POSITION: apakah kepala stabil lateral atau bergerak berlebihan (lateral sway)
5. REVERSE PIVOT: apakah berat badan berpindah ke kiri saat backswing (fault)
6. TRAIL SIDE BEND: side bend tubuh ke kanan saat downswing (power move)
7. LEAD KNEE: posisi lutut kiri saat impact — apakah menekan ke depan atau terlalu flex`,

      angleMetrics: [
        'Hip rotation at impact (face on)',
        'Shoulder tilt at P4 top',
        'Lateral head movement P1 vs P7',
        'Weight distribution at setup vs impact',
        'Lead knee flex at impact (P7)',
        'Trail side bend at downswing (P6)'
      ]
    };
  }

  return {
    cameraDesc: 'Camera angle: tidak ditentukan. Lakukan analisa general terbaik yang bisa kamu lakukan.',
    focusAreas: 'Analisa semua aspek swing yang terlihat dari sudut kamera ini.',
    angleMetrics: ['Shoulder turn', 'Hip rotation', 'Spine angle', 'Weight transfer', 'Club path', 'Impact position']
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
    // ====== DETECT P4 & P7 ======
    const wristSpeed = computeWristSpeed(frames);
    const p4 = detectP4(wristSpeed);
    const p7 = detectP7(wristSpeed);

    // ====== BUILD VIEW CONTEXT ======
    const viewCtx = buildViewContext(viewAngle);
    const viewLabel = viewAngle === 'dtl' ? 'Down the Line (DTL)' : viewAngle === 'face-on' ? 'Face On' : 'General';

    // Build image content — all 10 frames
    const imageContent = frames.slice(0, 10).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx + 1}`, name: `Position ${idx + 1}` };
      return [
        { type: 'text', text: `${p.position} — ${p.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    // ====== SYSTEM PROMPT — VIEW-AWARE WITH COMPLETE JSON SCHEMA ======
    const sys = `You are SwingIQ, an expert AI golf coach analyzing a golf swing video frame by frame.

${viewCtx.cameraDesc}

${viewCtx.focusAreas}

You will receive 10 images representing positions P1 through P10 of a golf swing.
You MUST return ONLY a valid JSON object with EXACTLY this structure. No explanation, no markdown, no extra text — just raw JSON:

{
  "overall_score": <number 0-100>,
  "view_angle": "${viewLabel}",
  "coach_insight": "<2-3 kalimat ringkasan coaching spesifik untuk sudut ${viewLabel} dalam Bahasa Indonesia. Sebutkan 1-2 fault utama yang terlihat dari sudut ini.>",
  "strengths": ["<kekuatan 1>", "<kekuatan 2>", "<kekuatan 3>"],
  "improvements": ["<area perbaikan 1 spesifik untuk ${viewLabel}>", "<area perbaikan 2>", "<area perbaikan 3>"],
  "phases": [
    { "position": "P1", "name": "Setup/Address", "score": <number 0-100>, "status": "<good|warn|bad>", "feedback": "<feedback spesifik dari sudut ${viewLabel} dalam Bahasa Indonesia>" },
    { "position": "P2", "name": "Takeaway", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P3", "name": "Backswing", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P4", "name": "Top of Backswing", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P5", "name": "Early Downswing", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P6", "name": "Late Downswing", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P7", "name": "Impact", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P8", "name": "Follow Through", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P9", "name": "Release", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P10", "name": "Finish", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" }
  ],
  "angle_analysis": [
    {
      "phase": "<posisi, contoh P1>",
      "metric": "<nama metrik spesifik untuk sudut ${viewLabel}, contoh: ${viewCtx.angleMetrics[0]}>",
      "value": "<nilai aktual yang terukur dari video>",
      "ideal": "<nilai ideal atau range>",
      "status": "<good|warn|bad>",
      "detail": "<penjelasan dampak fault ini terhadap ball flight atau konsistensi swing, dalam Bahasa Indonesia>"
    }
  ],
  "error_frames": [
    {
      "position": "<posisi yang bermasalah>",
      "issue": "<nama fault singkat>",
      "actual_value": "<apa yang terlihat>",
      "ideal_value": "<yang seharusnya>",
      "status": "<bad|warn>",
      "description": "<penjelasan mengapa ini masalah dan cara memperbaikinya, dalam Bahasa Indonesia>"
    }
  ]
}

Rules:
- coach_insight MUST always be filled — minimum 2 sentences, NEVER null or undefined.
- phases MUST have exactly 10 entries (P1 to P10).
- angle_analysis MUST have at least 5 entries, prioritizing metrics most visible from the ${viewLabel} angle.
- error_frames: include positions with status bad or warn only. Can be [] if swing is clean.
- All feedback and descriptive text in Bahasa Indonesia.
- status values: ONLY "good", "warn", or "bad" — nothing else.
- Be specific to what is ACTUALLY visible from the ${viewLabel} camera angle.`;

    // ====== USER PROMPT WITH BIOMECHANICS CONTEXT ======
    const userPrompt = `Sudut kamera: ${viewLabel}

Biomechanics engine mendeteksi:
- Estimasi P4 (top of backswing): frame ke-${p4}
- Estimasi P7 (impact zone): frame ke-${p7}

Gunakan data ini sebagai referensi, tapi tetap validasi secara visual dari gambar.
Analisa semua 10 posisi swing dari sudut ${viewLabel} dan return JSON sesuai schema.`;

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
    raw = raw.replace(/```json|```/g, '').trim();

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'GPT tidak return JSON valid', debug: raw.substring(0, 300) });
    }

    let result;
    try {
      result = JSON.parse(raw.substring(start, end + 1));
    } catch (parseErr) {
      return res.status(500).json({ error: 'JSON parse error: ' + parseErr.message, debug: raw.substring(0, 300) });
    }

    // ====== SAFETY: Ensure critical fields are never undefined ======
    if (!result.coach_insight) {
      result.coach_insight = `Analisa swing dari sudut ${viewLabel} selesai. Perhatikan konsistensi posisi dan tempo swing kamu untuk hasil yang lebih baik.`;
    }
    if (!Array.isArray(result.phases) || result.phases.length === 0) {
      return res.status(500).json({ error: 'GPT tidak return phases array', debug: JSON.stringify(result).substring(0, 300) });
    }
    if (!Array.isArray(result.strengths)) result.strengths = [];
    if (!Array.isArray(result.improvements)) result.improvements = [];
    if (!Array.isArray(result.angle_analysis)) result.angle_analysis = [];
    if (!Array.isArray(result.error_frames)) result.error_frames = [];
    if (!result.view_angle) result.view_angle = viewLabel;

    return res.status(200).json({
      result,
      debug: { p4, p7, viewAngle }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
