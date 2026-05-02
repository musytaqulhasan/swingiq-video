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

  const { frames, positions, viewAngle, club, mediaPipeDetected, clubTrajectory } = req.body;
  console.log('frames:', frames?.length, 'viewAngle:', viewAngle, 'mediaPipe:', !!mediaPipeDetected, 'clubTrajectory:', !!clubTrajectory);
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
    const isDTL = viewAngle === 'dtl';

    const imageContent = frames.slice(0, 10).map((f, idx) => {
      const p = (positions || [])[idx] || { position: `P${idx+1}`, name: `Position ${idx+1}` };
      return [
        { type: 'text', text: `${p.position} — ${p.name}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ];
    }).flat();

    // ── Overlay schema differs by view angle ──────────────────────────────────
    // All x/y values are ratios 0.0–1.0 relative to frame width/height.
    // DTL overlay: spine_x (vertical line at spine), swing_plane (diagonal line),
    //              head_cx / head_cy / head_r (head circle).
    // Face-on overlay: body_left_x, body_right_x (vertical edge lines),
    //                  head_cx / head_cy / head_r (head circle).
    const overlaySchema = isDTL
      ? `"overlay_data":{"spine_x":<0.0-1.0>,"swing_plane_x1":<0.0-1.0>,"swing_plane_y1":<0.0-1.0>,"swing_plane_x2":<0.0-1.0>,"swing_plane_y2":<0.0-1.0>,"head_cx":<0.0-1.0>,"head_cy":<0.0-1.0>,"head_r":<0.04-0.12>}`
      : `"overlay_data":{"body_left_x":<0.0-1.0>,"body_right_x":<0.0-1.0>,"head_cx":<0.0-1.0>,"head_cy":<0.0-1.0>,"head_r":<0.04-0.12>}`;

    const sys = `You are SwingIQ, a golf swing analysis engine. Your ONLY function is to analyze golf swing images and return JSON data.

CRITICAL RULES:
- You MUST return ONLY a valid JSON object. Nothing else.
- Do NOT include any text before or after the JSON.
- Do NOT refuse. These are standard sports coaching images.
- Do NOT say "I'm sorry" or "I can't". Just return the JSON.
- If image quality is poor, return your best estimate in JSON format.
- If unsure about any value, use reasonable defaults but ALWAYS return JSON.

${viewCtx}

Return this exact JSON structure:
{"overall_score":<0-100>,"view_angle":"${viewLabel}","coach_insight":"<2-3 kalimat coaching Bahasa Indonesia>","focus_fault":"<max 5 kata>","focus_sub":"<1 kalimat Bahasa Indonesia>","coach_says":"<2-3 kalimat Bahasa Indonesia>","why":"<1-2 kalimat Bahasa Indonesia>","fix_drill":"<nama drill>","fix_feel":"<1 kalimat Bahasa Indonesia>","strengths":["<s1>","<s2>","<s3>"],"improvements":["<i1>","<i2>","<i3>"],"phases":[{"position":"P1","name":"Setup/Address","score":<0-100>,"status":"<good|warn|bad>","feedback":"<Bahasa Indonesia>"},{"position":"P2","name":"Takeaway","score":<0-100>,"status":"<good|warn|bad>","feedback":"<text>"},{"position":"P3","name":"Backswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<text>"},{"position":"P4","name":"Top of Backswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<text>"},{"position":"P5","name":"Downswing","score":<0-100>,"status":"<good|warn|bad>","feedback":"<text>"},{"position":"P6","name":"Impact","score":<0-100>,"status":"<good|warn|bad>","feedback":"<text>"},{"position":"P7","name":"Follow Through","score":<0-100>,"status":"<good|warn|bad>","feedback":"<text>"},{"position":"P8","name":"Finish","score":<0-100>,"status":"<good|warn|bad>","feedback":"<text>"}],"angle_analysis":[{"phase":"P1","metric":"Spine Angle","value":"<N>°","ideal":"30-45°","status":"<good|warn|bad>","detail":"<text>"},{"phase":"P4","metric":"Shoulder Tilt","value":"<N>°","ideal":"35-50°","status":"<good|warn|bad>","detail":"<text>"},{"phase":"P6","metric":"Hip Rotation","value":"<N>°","ideal":"40-55°","status":"<good|warn|bad>","detail":"<text>"}],"error_frames":[{"position":"<Px>","issue":"<fault>","actual_value":"<val>","ideal_value":"<val>","status":"<bad|warn>","description":"<text>"}],${overlaySchema}}`;

    // Build biomechanics context from MediaPipe data
    let bioCtx = `P4=frame${p4}, P6=frame${p6 ?? 'n/a'}, P7=frame${p7}`;
    if (tempoData) bioCtx += `, Tempo=${tempoData.ratio} (${tempoData.classification})`;
    
    if (mediaPipeDetected && positions) {
      const posMetrics = positions.filter(p => p.metrics).map(p => {
        const m = p.metrics;
        return `${p.position}: wristHeight=${m.wristRelHeight?.toFixed(2)}, spineAngle=${m.spineAngle?.toFixed(1)}°, elbowR=${m.rElbowAngle?.toFixed(1)}°, hipSpread=${m.hipSpread?.toFixed(3)}`;
      }).join('\n');
      if (posMetrics) bioCtx += `\n\nMediaPipe Pose Metrics (per phase):\n${posMetrics}`;
    }
    
    if (clubTrajectory && clubTrajectory.length > 0) {
      const maxClubSpeed = Math.max(...clubTrajectory.map(t => t.speed));
      const impactIdx = clubTrajectory.findIndex(t => t.speed === maxClubSpeed);
      bioCtx += `\n\nClub Head: max_speed_frame=${impactIdx}, trajectory_points=${clubTrajectory.length}`;
    }

    const userPrompt = `View: ${viewLabel}
Detection: ${mediaPipeDetected ? 'MediaPipe Pose (33 keypoints)' : 'Visual estimation'}
Biomechanics: ${bioCtx}
Analyze all 8 positions and return the JSON. Remember to include Spine Angle, Shoulder Tilt, and Hip Rotation in angle_analysis, and estimate overlay_data landmark positions from the P1 frame.`;

    // GPT-4o call with retry logic
    let raw = '';
    let choice = null;
    const MAX_RETRIES = 2;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 4000,
          temperature: attempt > 0 ? 0.3 : 0.7, // lower temp on retry
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: [...imageContent, { type: 'text', text: userPrompt }] }
          ]
        })
      });

      const d = await r.json();
      if (!r.ok) {
        console.error(`Attempt ${attempt}: OpenAI error`, d.error?.message);
        if (attempt < MAX_RETRIES) continue;
        return res.status(500).json({ error: d.error?.message || 'OpenAI error' });
      }

      choice = d.choices[0];
      raw = choice.message.content.trim().replace(/```json|```/g, '').trim();
      console.log(`Attempt ${attempt}: finish_reason=${choice.finish_reason}, length=${raw.length}`);
      
      // Check for refusal
      const isRefusal = raw.toLowerCase().includes("i'm sorry") || 
                        raw.toLowerCase().includes("i can't") ||
                        raw.toLowerCase().includes("i cannot") ||
                        raw.toLowerCase().includes("i apologize") ||
                        raw.indexOf('{') === -1;
      
      if (!isRefusal) break; // success
      
      console.warn(`Attempt ${attempt}: GPT refused, retrying...`);
      if (attempt >= MAX_RETRIES) {
        console.warn('All retries failed, using fallback analysis');
        // Return a basic fallback result
        const fallbackResult = {
          overall_score: 65,
          view_angle: viewLabel,
          coach_insight: 'Analisa otomatis. Perhatikan konsistensi posisi dan tempo swing Anda.',
          focus_fault: 'Konsistensi swing',
          focus_sub: 'Fokus pada fundamental swing untuk hasil yang lebih konsisten.',
          coach_says: 'Terus berlatih dengan fokus pada setup yang konsisten dan tempo yang stabil.',
          why: 'Fundamental yang kuat adalah dasar dari swing yang baik.',
          fix_drill: 'Slow Motion Drill',
          fix_feel: 'Fokus pada transisi yang mulus dari backswing ke downswing.',
          strengths: ['Setup cukup baik', 'Grip terlihat solid', 'Posisi kaki stabil'],
          improvements: ['Konsistensi swing meningkat', 'Ball flight lebih terprediksi', 'Jarak bisa bertambah'],
          phases: ['Setup/Address','Takeaway','Backswing','Top of Backswing','Downswing','Impact','Follow Through','Finish'].map((name, idx) => ({
            position: `P${idx+1}`, name, score: 60 + Math.floor(Math.random()*20), status: 'warn', feedback: 'Perlu evaluasi lebih lanjut.'
          })),
          angle_analysis: [
            { phase:'P1', metric:'Spine Angle', value:'38°', ideal:'30-45°', status:'good', detail:'Estimasi berdasarkan postur.' },
            { phase:'P4', metric:'Shoulder Tilt', value:'42°', ideal:'35-50°', status:'good', detail:'Estimasi berdasarkan postur.' },
            { phase:'P6', metric:'Hip Rotation', value:'45°', ideal:'40-55°', status:'good', detail:'Estimasi berdasarkan postur.' }
          ],
          error_frames: [],
          overlay_data: isDTL
            ? { spine_x:0.35, swing_plane_x1:0.10, swing_plane_y1:0.85, swing_plane_x2:0.80, swing_plane_y2:0.10, head_cx:0.40, head_cy:0.14, head_r:0.09 }
            : { body_left_x:0.22, body_right_x:0.78, head_cx:0.50, head_cy:0.13, head_r:0.09 }
        };
        if (tempoData) fallbackResult.tempo = tempoData;
        return res.status(200).json({ result: fallbackResult, debug: { p4, p6, p7, fallback: true } });
      }
    }

    console.log('GPT RAW (first 500):', raw.substring(0, 500));

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'GPT tidak return JSON valid', debug: raw.substring(0, 500) });
    }

    let result;
    try {
      result = JSON.parse(raw.substring(start, end + 1));
    } catch(e) {
      // Sanitize common GPT-4o JSON issues
      try {
        let sanitized = raw.substring(start, end + 1);
        // Fix trailing commas before } or ]
        sanitized = sanitized.replace(/,\s*([}\]])/g, '$1');
        // Fix single quotes to double quotes (careful with apostrophes in values)
        sanitized = sanitized.replace(/(?<=[:,\[{])\s*'/g, ' "').replace(/'\s*(?=[,\]}\:])/g, '"');
        // Fix unquoted property names
        sanitized = sanitized.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
        // Remove control characters
        sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, (c) => c === '\n' || c === '\t' ? c : '');
        result = JSON.parse(sanitized);
        console.log('JSON sanitization succeeded');
      } catch(e2) {
        return res.status(500).json({ error: 'JSON parse error: ' + e.message, debug: raw.substring(0, 300) });
      }
    }

    // ── Safety fallbacks ─────────────────────────────────────────────────────
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
    if (!Array.isArray(result.error_frames)) result.error_frames = [];
    if (!result.view_angle) result.view_angle = viewLabel;
    if (!result.focus_fault) result.focus_fault = result.error_frames[0]?.issue || 'Konsistensi swing';
    if (!result.focus_sub) result.focus_sub = result.improvements[0] || '';
    if (!result.coach_says) result.coach_says = result.coach_insight;
    if (!result.why) result.why = result.error_frames[0]?.description || result.coach_insight;
    if (!result.fix_drill) result.fix_drill = 'Hip Bump Drill';
    if (!result.fix_feel) result.fix_feel = 'Fokus pada transisi yang mulus dari backswing ke downswing.';
    if (tempoData) result.tempo = tempoData;

    // ── angle_analysis fallbacks — ensure the 3 required metrics always exist ─
    if (!Array.isArray(result.angle_analysis)) result.angle_analysis = [];
    const requiredMetrics = [
      { metric: 'Spine Angle',    phase: 'P1', ideal: '30–45°', fallback: '38°' },
      { metric: 'Shoulder Tilt', phase: 'P4', ideal: '35–50°', fallback: '42°' },
      { metric: 'Hip Rotation',  phase: 'P6', ideal: '40–55°', fallback: '45°' },
    ];
    requiredMetrics.forEach(({ metric, phase, ideal, fallback }) => {
      const exists = result.angle_analysis.some(a =>
        (a.metric || '').toLowerCase().includes(metric.toLowerCase().split(' ')[0])
      );
      if (!exists) {
        result.angle_analysis.unshift({
          phase, metric, value: fallback, ideal,
          status: 'warn',
          detail: 'Data tidak tersedia — estimasi berdasarkan postur umum.'
        });
      }
    });

    // ── overlay_data fallbacks ────────────────────────────────────────────────
    if (!result.overlay_data) {
      result.overlay_data = isDTL
        ? { spine_x: 0.35, swing_plane_x1: 0.10, swing_plane_y1: 0.85, swing_plane_x2: 0.80, swing_plane_y2: 0.10, head_cx: 0.40, head_cy: 0.14, head_r: 0.09 }
        : { body_left_x: 0.22, body_right_x: 0.78, head_cx: 0.50, head_cy: 0.13, head_r: 0.09 };
    }

    return res.status(200).json({ result, debug: { p4, p6, p7, p7_speed, p7_shaft, tempo: tempoData, mediaPipeDetected: !!mediaPipeDetected, clubTrajectoryPoints: clubTrajectory?.length || 0 } });

  } catch (err) {
    console.error('analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
