export const config = { maxDuration: 60 };

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
    // ── DETECT: identify which frame = which P position ──────────────────
    if (mode === 'detect') {
      // Use only 10 frames max for detection
      const n = Math.min(frames.length, 10);
      const step = Math.floor(frames.length / n);
      const scanFrames = Array.from({length: n}, (_, i) => frames[Math.min(i * step, frames.length - 1)]);

      const imageContent = scanFrames.map((f, i) => [
        { type: 'text', text: `Frame ${i}:` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
      ]).flat();

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              ...imageContent,
              { type: 'text', text: `Golf swing frames 0-${scanFrames.length-1}. Map each P to best frame. Keep order P1<=...<=P10.
P1=Setup,P2=Takeaway,P3=Backswing,P4=Top,P5=StartDown,P6=ShaftParallel,P7=Impact,P8=EarlyFollow,P9=LateFollow,P10=Finish
Return ONLY JSON array: [{"position":"P1","name":"Setup","frame_index":0},...]` }
            ]
          }]
        })
      });

      const d = await r.json();
      if (!r.ok) return res.status(500).json({ error: d.error?.message });

      let raw = d.choices[0].message.content.replace(/```json|```/g,'').trim();
      const m = raw.match(/\[[\s\S]*\]/);
      if (!m) return res.status(500).json({ error: 'Could not parse positions', raw });
      raw = m[0];

      const parsed = JSON.parse(raw);
      // Map back to original frame indices
      const ratio = frames.length / scanFrames.length;
      const mapped = parsed.map(p => ({
        ...p,
        frame_index: Math.min(Math.round((p.frame_index || 0) * ratio), frames.length - 1)
      }));
      return res.status(200).json({ positions: mapped });
    }

    // ── ANALYZE: full P1-P10 analysis, one position at a time in batches ─
    if (mode === 'analyze') {
      if (!positions?.length) return res.status(400).json({ error: 'No positions provided' });

      // Send 5 frames at a time to avoid token limits — batch 1: P1-P5, batch 2: P6-P10
      const batch1 = frames.slice(0, 5);
      const batch2 = frames.slice(5, 10);
      const pos1   = positions.slice(0, 5);
      const pos2   = positions.slice(5, 10);

      const buildContent = (batchFrames, batchPositions) =>
        batchFrames.map((f, idx) => {
          const p = batchPositions[idx] || { position: `P${idx+1}`, name: `Frame ${idx+1}` };
          return [
            { type: 'text', text: `${p.position} ${p.name}:` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } }
          ];
        }).flat();

      const sys = `You are SwingIQ AI golf coach. You will receive golf swing frames in two batches.
Analyze each position carefully. Use descriptive Bahasa Indonesia for angle names.
Return ONLY raw JSON no markdown no backticks.`;

      // Run both batches in parallel
      const [r1, r2] = await Promise.all([
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: 'gpt-4o', max_tokens: 1000,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: [
                ...buildContent(batch1, pos1),
                { type: 'text', text: `Analyze these 5 golf swing positions (${pos1.map(p=>p.position).join(',')}).
Return JSON: {"phases":[{"position":"P1","name":"Setup","score":75,"note":"<BI>","timestamp":0},...],"angles":[{"position":"P1","area":"<descriptive BI>","actual":"<val>","ideal":"<range>","status":"good|warn|bad","label":"Sudah baik|Bisa dioptimalkan|Perlu perhatian","impact":"<BI>"}]}
Only phases for P1-P5, angles for worst issues found in these 5 positions.` }
              ]}
          })
        }),
        fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: 'gpt-4o', max_tokens: 1000,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: [
                ...buildContent(batch2, pos2),
                { type: 'text', text: `Analyze these 5 golf swing positions (${pos2.map(p=>p.position).join(',')}).
Return JSON: {"phases":[{"position":"P6","name":"Shaft Parallel Down","score":70,"note":"<BI>","timestamp":1.2},...],"angles":[{"position":"P6","area":"<descriptive BI>","actual":"<val>","ideal":"<range>","status":"good|warn|bad","label":"Sudah baik|Bisa dioptimalkan|Perlu perhatian","impact":"<BI>"}]}
Only phases for P6-P10, angles for worst issues found in these 5 positions.` }
              ]}
          })
        })
      ]);

      const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
      if (!r1.ok) return res.status(500).json({ error: d1.error?.message, batch: 1 });
      if (!r2.ok) return res.status(500).json({ error: d2.error?.message, batch: 2 });

      const parseJSON = (raw) => {
        raw = raw.replace(/```json|```/g,'').trim();
        const m = raw.match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : JSON.parse(raw);
      };

      const part1 = parseJSON(d1.choices[0].message.content);
      const part2 = parseJSON(d2.choices[0].message.content);

      // Merge results
      const allPhases = [...(part1.phases||[]), ...(part2.phases||[])];
      const allAngles = [...(part1.angles||[]), ...(part2.angles||[])];

      // Calculate overall score
      const overallScore = Math.round(allPhases.reduce((s,p) => s + (p.score||70), 0) / Math.max(allPhases.length, 1));

      // Build error frames from worst angles
      const worstAngles = allAngles.filter(a => a.status === 'bad' || a.status === 'warn').slice(0, 3);
      const errorFrames = worstAngles.map((a, i) => {
        const phaseIdx = allPhases.findIndex(p => p.position === a.position);
        return {
          position: a.position,
          frame_index: Math.max(0, phaseIdx),
          phase: a.position,
          issue: a.area?.split('(')[0].trim() || 'Teknik perlu diperbaiki',
          description: a.impact || a.area,
          actual_value: a.actual || '-',
          ideal_value: a.ideal || '-',
          status: a.status
        };
      });

      // Estimate radar from phases
      const phaseMap = {};
      allPhases.forEach(p => { phaseMap[p.position] = p.score || 70; });
      const radar = {
        setup: phaseMap['P1'] || 70,
        backswing: Math.round(((phaseMap['P2']||70) + (phaseMap['P3']||70) + (phaseMap['P4']||70)) / 3),
        power: Math.round(((phaseMap['P5']||70) + (phaseMap['P6']||70)) / 2),
        impact: phaseMap['P7'] || 70,
        follow_through: Math.round(((phaseMap['P8']||70) + (phaseMap['P9']||70)) / 2),
        balance: phaseMap['P10'] || 70
      };

      const result = {
        overall_score: overallScore,
        summary: `Analisa swing P1-P10 selesai. Skor overall ${overallScore}/100.`,
        phases: allPhases,
        radar,
        angles: allAngles.sort((a,b) => {const o={bad:0,warn:1,good:2}; return (o[a.status]||1)-(o[b.status]||1);}),
        error_frames: errorFrames,
        insight: `Fokus perbaikan pada ${worstAngles.map(a=>a.area?.split('(')[0].trim()).filter(Boolean).join(', ')||'teknik dasar'}. Latihan konsisten setiap hari akan memberikan perbedaan signifikan dalam 2-4 minggu.`
      };

      return res.status(200).json({ result });
    }

    return res.status(400).json({ error: 'Unknown mode' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
