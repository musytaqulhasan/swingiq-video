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

// ====== SHAFT ANGLE (proxy via elbow-wrist) ======
function estimateShaftAngle(frame) {
  const wrist = frame.right_wrist;
  const elbow = frame.right_elbow;
  if (!wrist || !elbow) return null;
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;
  const angleRad = Math.atan2(dy, dx);
  return Math.abs(angleRad * 180 / Math.PI);
}

// ====== EVENT DETECTION ======
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

// ====== VIEW CONTEXT ======
function buildViewContext(viewAngle) {
  if (viewAngle === 'dtl') {
    return {
      cameraDesc: `Camera angle: DOWN THE LINE (DTL) — kamera di belakang pemain, searah target line.
Dari sudut ini terlihat jelas: club path, swing plane, spine angle, shaft lean, wrist conditions, trail elbow.`,
      focusAreas: `Untuk sudut DTL, fokus analisa:
1. SWING PLANE: on-plane, over-the-top, atau under-plane
2. SPINE ANGLE: konsisten P1-P7, early extension/sway
3. CLUB PATH: sesuai target line atau in-to-out/out-to-in
4. SHAFT LEAN: positif di P7 (impact)
5. TRAIL ELBOW: tuck atau flying di P4/P6
6. WRIST: flat, cupped, atau bowed di P4`,
      angleMetrics: ['Swing plane angle (DTL)', 'Spine tilt at setup vs impact', 'Trail elbow at P4', 'Shaft lean at impact (P7)', 'Wrist condition at P4', 'Hip hinge depth at P1']
    };
  }
  if (viewAngle === 'face-on') {
    return {
      cameraDesc: `Camera angle: FACE ON — kamera di depan pemain, tegak lurus target line.
Dari sudut ini terlihat jelas: weight transfer, hip/shoulder tilt, head position, knee flex, reverse pivot.`,
      focusAreas: `Untuk sudut Face On, fokus analisa:
1. WEIGHT TRANSFER: berat dari kanan ke kiri saat downswing
2. HIP TURN & TILT: rotasi dan tilt pinggul P1-P10
3. SHOULDER TILT: lead shoulder lebih rendah di P4
4. HEAD POSITION: stabil lateral atau lateral sway
5. REVERSE PIVOT: berat ke kiri saat backswing (fault)
6. LEAD KNEE: posisi lutut kiri di P7`,
      angleMetrics: ['Hip rotation at impact', 'Shoulder tilt at P4', 'Lateral head movement P1 vs P7', 'Weight distribution setup vs impact', 'Lead knee flex at P7', 'Trail side bend at P6']
    };
  }
  return {
    cameraDesc: 'Camera angle: tidak ditentukan.',
    focusAreas: 'Analisa general semua aspek swing.',
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
  console.log("TOTAL FRAMES MASUK:", frames?.length);
  console.log("VIEW ANGLE:", viewAngle);
  console.log("POSITIONS:", positions?.length);
  if (!frames?.length) return res.status(400).json({ error: 'No frames provided' });

  try {
    // ====== BIOMECHANICS DETECTION ======
    const wristSpeed = computeWristSpeed(frames);
    const p4 = detectP4(wristSpeed);
    const p6 = detectP6(frames);
    const p7_speed = detectP7Speed(wristSpeed);
    const p7_shaft = detectP7Shaft(frames);
    const p7 = Math.round((p7_speed + p7_shaft) / 2);

    // ====== VIEW CONTEXT ======
    const viewCtx = buildViewContext(viewAngle);
    const viewLabel = viewAngle === 'dtl' ? 'Down the Line (DTL)' : viewAngle === 'face-on' ? 'Face On' : 'General';

    // ====== BUILD IMAGE CONTENT ======
    const imageContent = frames.slice(0, 8).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx + 1}`, name: `Position ${idx + 1}` };
      return [
        { type: 'text', text: `${p.position} — ${p.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    // ====== SYSTEM PROMPT WITH COMPLETE JSON SCHEMA ======
    const sys = `You are SwingIQ, an expert AI golf coach analyzing a golf swing video frame by frame.

${viewCtx.cameraDesc}

${viewCtx.focusAreas}

You will receive 8 images representing positions P1 through P8 of a golf swing.
You MUST return ONLY a valid JSON object with EXACTLY this structure. No explanation, no markdown, no extra text — just raw JSON:

{
  "overall_score": <number 0-100>,
  "view_angle": "${viewLabel}",

  "coach_insight": "<2-3 kalimat coaching keseluruhan dalam Bahasa Indonesia. WAJIB DIISI.>",

  "focus_fault": "<nama fault utama yang paling kritis, singkat, max 5 kata. Contoh: Over the Top, Early Release, Reverse Pivot>",
  "focus_sub": "<1 kalimat: dampak fault ini ke ball flight. Contoh: Ini penyebab bola kamu sering slice ke kanan.>",

  "coach_says": "<2-3 kalimat BAHASA MANUSIA — seperti coach bicara langsung ke pemain. Bukan teknis. Contoh: Di awal swing kamu sudah cukup bagus. Tapi saat downswing, tangan kamu bergerak ke luar, bukan turun ke dalam. Makanya arah bola jadi belok ke kanan.>",

  "why": "<1-2 kalimat penjelasan sederhana KENAPA fault ini terjadi secara biomekanik. Contoh: Bahu kamu terbuka terlalu cepat, sementara pinggul belum sempat rotate. Akibatnya tangan terlempar keluar.>",

  "fix_drill": "<nama drill yang paling relevan untuk fault ini. Pilih dari: Elbow Tuck Drill, Shoulder Turn Drill, Hip Bump Drill, Weight Transfer Drill, Alignment Stick Setup, Hip Hinge Drill, Flat Left Wrist Drill, Swing Plane Drill, Pause at Top Drill, Lag Retention Drill, Impact Bag Drill, Pump Drill, Hip Clearance Drill, Feet Together Drill, Full Finish Drill, Extension Drill>",
  "fix_feel": "<1 kalimat feel cue — apa yang harus dirasakan pemain saat melakukan drill. Contoh: Turunkan tangan ke dalam, bukan lempar ke depan.>",

  "strengths": ["<kekuatan 1>", "<kekuatan 2>", "<kekuatan 3>"],
  "improvements": ["<apa yang terjadi kalau fault ini diperbaiki, bukan teknis tapi hasil nyata. Contoh: Bola akan lebih lurus>", "<Slice berkurang>", "<Jarak bisa nambah 15-25 meter>"],
  "phases": [
    { "position": "P1", "name": "Setup/Address", "score": <number 0-100>, "status": "<good|warn|bad>", "feedback": "<feedback dalam Bahasa Indonesia>" },
    { "position": "P2", "name": "Takeaway", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P3", "name": "Backswing", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P4", "name": "Top of Backswing", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P5", "name": "Downswing", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P6", "name": "Impact", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P7", "name": "Follow Through", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" },
    { "position": "P8", "name": "Finish", "score": <number>, "status": "<good|warn|bad>", "feedback": "<feedback>" }
  ],
  "angle_analysis": [
    {
      "phase": "<posisi>",
      "metric": "<metrik spesifik untuk sudut ${viewLabel}, contoh: ${viewCtx.angleMetrics[0]}>",
      "value": "<nilai aktual dari video>",
      "ideal": "<nilai ideal>",
      "status": "<good|warn|bad>",
      "detail": "<penjelasan dampak dalam Bahasa Indonesia>"
    }
  ],
  "error_frames": [
    {
      "position": "<posisi bermasalah>",
      "issue": "<nama fault>",
      "actual_value": "<apa yang terlihat>",
      "ideal_value": "<yang seharusnya>",
      "status": "<bad|warn>",
      "description": "<penjelasan dan cara perbaikan dalam Bahasa Indonesia>"
    }
  ]
}

Rules:
- coach_insight, coach_says, why, focus_fault, fix_drill, fix_feel WAJIB semua diisi. TIDAK BOLEH null atau kosong.
- coach_says harus bahasa manusia natural, bukan bahasa teknis/biomechanics.
- improvements harus berisi HASIL NYATA yang bisa dirasakan pemain (bukan deskripsi teknis).
- phases HARUS tepat 8 entry (P1 sampai P8).
- angle_analysis HARUS minimal 5 entry.
- error_frames: hanya posisi bad/warn. Boleh [] jika swing bagus.
- Semua teks dalam Bahasa Indonesia.
- status: HANYA "good", "warn", atau "bad".`;

    const userPrompt = `Sudut kamera: ${viewLabel}

Biomechanics engine mendeteksi:
- P4 (top of backswing): frame ke-${p4}
- P6 (shaft parallel down): frame ke-${p6 ?? 'tidak terdeteksi'}
- P7 (impact): frame ke-${p7} (speed: ${p7_speed}, shaft: ${p7_shaft})

Gunakan sebagai referensi, validasi secara visual dari gambar.
Analisa semua 10 posisi dan return JSON sesuai schema.`;

    const callGPT = async (messages) => {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 3000, messages })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'OpenAI error');
      let raw = d.choices[0].message.content.trim();
      raw = raw.replace(/```json[\s\S]*?```/g, m => m.replace(/```json|```/g, '')).replace(/```/g, '').trim();
      return raw;
    };

    // First attempt
    let raw = await callGPT([
      { role: 'system', content: sys },
      { role: 'user', content: [...imageContent, { type: 'text', text: userPrompt }] }
    ]);

    // Auto-retry jika GPT tidak return JSON
    if (raw.indexOf('{') === -1 || raw.lastIndexOf('}') === -1) {
      console.log("Attempt 1 no JSON, retrying...", raw.substring(0, 200));
      raw = await callGPT([
        { role: 'system', content: 'You are a JSON generator. Return ONLY a valid JSON object. No text before or after. No markdown. Start with { and end with }.' },
        { role: 'user', content: [...imageContent, { type: 'text', text: userPrompt + '

CRITICAL: Return ONLY raw JSON. Start with { end with }. Nothing else.' }] }
      ]);
    }

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.log("GPT RAW:", raw.substring(0, 500));
      return res.status(500).json({
        error: 'GPT tidak return JSON valid',
        debug: raw.substring(0, 500),
        raw_length: raw.length,
        frames_received: frames.length,
        view: viewAngle
      });
    }

    let result;
    try {
      result = JSON.parse(raw.substring(start, end + 1));
    } catch (parseErr) {
      return res.status(500).json({ error: 'JSON parse error: ' + parseErr.message, debug: raw.substring(0, 300) });
    }

    // ====== SAFETY FALLBACKS ======
    if (!result.coach_insight) {
      result.coach_insight = `Analisa swing dari sudut ${viewLabel} selesai. Perhatikan konsistensi posisi dan tempo swing untuk hasil yang lebih baik.`;
    }
    if (!Array.isArray(result.phases) || result.phases.length === 0) {
      return res.status(500).json({ error: 'GPT tidak return phases', debug: JSON.stringify(result).substring(0, 300) });
    }
    // Ensure exactly 8 phases
    if (result.phases.length > 8) result.phases = result.phases.slice(0, 8);
    if (!Array.isArray(result.strengths)) result.strengths = [];
    if (!Array.isArray(result.improvements)) result.improvements = ['Konsistensi swing meningkat', 'Ball flight lebih terprediksi', 'Jarak bisa bertambah'];
    if (!Array.isArray(result.angle_analysis)) result.angle_analysis = [];
    if (!Array.isArray(result.error_frames)) result.error_frames = [];
    if (!result.view_angle) result.view_angle = viewLabel;
    // Fallbacks for new coach fields
    if (!result.focus_fault) result.focus_fault = result.error_frames[0]?.issue || 'Konsistensi swing';
    if (!result.focus_sub) result.focus_sub = result.improvements[0] || '';
    if (!result.coach_says) result.coach_says = result.coach_insight;
    if (!result.why) result.why = result.error_frames[0]?.description || result.coach_insight;
    if (!result.fix_drill) result.fix_drill = 'Hip Bump Drill';
    if (!result.fix_feel) result.fix_feel = 'Fokus pada transisi yang mulus dari backswing ke downswing.';

    return res.status(200).json({
      result,
      debug: { p4, p6, p7, p7_speed, p7_shaft }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
