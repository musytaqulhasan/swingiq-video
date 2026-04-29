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

    // ====== TEMPO CALCULATION ======
    const tempoData = (() => {
      try {
        const t0  = frames[0].timestamp;
        const tP4 = frames[Math.min(p4, frames.length - 1)].timestamp;
        const tP7 = frames[Math.min(p7, frames.length - 1)].timestamp;
        const tEnd = frames[frames.length - 1].timestamp;

        const backswing  = tP4 - t0;          // P1 → P4 (backswing)
        const downswing  = tP7 - tP4;         // P4 → P7 (downswing)
        const followThru = tEnd - tP7;        // P7 → finish

        if (downswing <= 0) return null;

        const ratio_bs = backswing / downswing;
        const ratio_ft = followThru / downswing;

        // Classify tempo
        let tempoClass;
        if (ratio_bs >= 3.0) tempoClass = 'Lambat & Terkontrol (seperti pro)';
        else if (ratio_bs >= 2.0) tempoClass = 'Sedang';
        else tempoClass = 'Terlalu Cepat di Backswing';

        return {
          backswing_ms: Math.round(backswing * 1000),
          downswing_ms: Math.round(downswing * 1000),
          follow_ms:    Math.round(followThru * 1000),
          ratio: `${ratio_bs.toFixed(1)}:1:${ratio_ft.toFixed(1)}`,
          backswing_to_downswing: parseFloat(ratio_bs.toFixed(2)),
          classification: tempoClass
        };
      } catch(e) {
        return null;
      }
    })();

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

    // ====== SYSTEM PROMPT - COMPACT ======
    const sys = `You are SwingIQ, an expert AI golf coach. ${viewCtx.cameraDesc}

Analyze the golf swing images and return ONLY this JSON (no markdown, no explanation):
{"overall_score":<0-100>,"view_angle":"${viewLabel}","coach_insight":"<2-3 sentences in Bahasa Indonesia>","focus_fault":"<main fault, max 5 words>","focus_sub":"<1 sentence impact on ball flight>","coach_says":"<2-3 natural human sentences in Bahasa Indonesia>","why":"<1-2 sentences why this fault happens>","fix_drill":"<drill name>","fix_feel":"<1 sentence feel cue>","strengths":["<s1>","<s2>","<s3>"],"improvements":["<real result 1>","<real result 2>","<real result 3>"],"phases":[{"position":"P1","name":"Setup/Address","score":<0-100>,"status":"<good|warn|bad>","feedback":"<Bahasa Indonesia>"},{"position":"P2","name":"Takeaway","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},{"position":"P3","name":"Backswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},{"position":"P4","name":"Top of Backswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},{"position":"P5","name":"Downswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},{"position":"P6","name":"Impact","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},{"position":"P7","name":"Follow Through","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"},{"position":"P8","name":"Finish","score":<0-100>,"status":"<good|warn|bad>","feedback":"<feedback>"}],"angle_analysis":[{"phase":"<P1-P8>","metric":"<metric>","value":"<actual>","ideal":"<ideal>","status":"<good|warn|bad>","detail":"<Bahasa Indonesia>"}],"error_frames":[{"position":"<Px>","issue":"<fault>","actual_value":"<actual>","ideal_value":"<ideal>","status":"<bad|warn>","description":"<Bahasa Indonesia>"}]}

Rules: phases MUST have exactly 8 entries. All text in Bahasa Indonesia. status only "good","warn","bad".`
    const userPrompt = `Sudut kamera: ${viewLabel}

Biomechanics engine mendeteksi:
- P4 (top of backswing): frame ke-${p4}
- P6 (shaft parallel down): frame ke-${p6 ?? 'tidak terdeteksi'}
- P7 (impact): frame ke-${p7} (speed: ${p7_speed}, shaft: ${p7_shaft})
${tempoLine}

Gunakan sebagai referensi, validasi secara visual dari gambar.
Sertakan analisa tempo dalam feedback P4 dan P7 jika relevan.
Analisa semua 10 posisi dan return JSON sesuai schema.`;

    const callGPT = async (messages) => {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4000, messages })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'OpenAI error');
      const choice = d.choices[0];
      console.log("finish_reason:", choice.finish_reason, "| tokens used:", d.usage?.completion_tokens);
      if (choice.finish_reason === 'length') {
        console.log("WARNING: Response truncated! Increase max_tokens.");
      }
      let raw = choice.message.content.trim();
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
        { role: 'user', content: [...imageContent, { type: 'text', text: userPrompt + '\n\nCRITICAL: Return ONLY raw JSON. Start with { end with }. Nothing else.' }] }
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
    console.log("GPT result keys:", Object.keys(result));
    console.log("GPT phases:", JSON.stringify(result.phases)?.substring(0, 200));
    console.log("GPT overall_score:", result.overall_score);

    if (!Array.isArray(result.phases) || result.phases.length === 0) {
      // Try alternate field names GPT might use
      const altPhases = result.swing_phases || result.positions || result.analysis;
      if (Array.isArray(altPhases) && altPhases.length > 0) {
        result.phases = altPhases;
      } else {
        return res.status(500).json({
          error: 'GPT tidak return phases',
          result_keys: Object.keys(result),
          debug: JSON.stringify(result).substring(0, 500)
        });
      }
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

    // Attach tempo to result for frontend display
    if (tempoData) result.tempo = tempoData;

    return res.status(200).json({
      result,
      debug: { p4, p6, p7, p7_speed, p7_shaft, tempo: tempoData }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
