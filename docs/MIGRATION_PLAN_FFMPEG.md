# SwingIQ — Backend Frame Extraction Migration Plan

## 1. Root Cause Analysis

### Browser-Dependent Components (Current)

| Component | Location | Browser Dependency |
|-----------|----------|-------------------|
| `extractFrames()` | line 1949 | `video.currentTime` seek + `canvas.drawImage` |
| `extractFrameAt()` | line 1997 | Same — single frame HQ extraction |
| `video.duration` | line 1954 | Browser video decoder determines duration |
| `canvas.toDataURL()` | line 1990 | JPEG encoding varies by browser engine |
| `video.onseeked` | line 1963 | Seek precision varies (keyframe alignment) |

### Why Results Differ

```
Edge (Chromium):
  Video decoder: FFmpeg-based (libavcodec)
  Duration: 2.07s
  Seek: frame-accurate on most codecs
  
Safari (WebKit):
  Video decoder: AVFoundation (Apple)  
  Duration: 2.04s (different container parsing)
  Seek: seeks to nearest keyframe, then decodes forward
```

Same video → different duration → different frame timestamps → different frames sent to GPT → different P1-P8.

---

## 2. Migration Plan: Browser → Backend FFmpeg

### Target Architecture

```
┌─────────────────────────────────────────────────────┐
│  Mobile / Web (any browser)                         │
│  ┌───────────────┐                                  │
│  │ Upload Video   │ ──── POST /api/analyze ────┐    │
│  │ Display Result │ ◄── JSON response ─────────┤    │
│  └───────────────┘                             │    │
└────────────────────────────────────────────────│────┘
                                                 │
┌────────────────────────────────────────────────│────┐
│  Backend (Node.js on GCP Cloud Run)            │    │
│                                                ▼    │
│  ┌──────────────────────────────────────────┐       │
│  │ 1. Receive video                         │       │
│  │ 2. FFmpeg: extract 90 frames + timestamps│       │
│  │ 3. GPT Pass 1: detect P1-P8             │       │
│  │ 4. GPT Impact Refine: refine P6         │       │
│  │ 5. MediaPipe: biomechanics (8 frames)   │       │
│  │ 6. GPT: coaching analysis (1 grid image)│       │
│  │ 7. Return JSON                          │       │
│  └──────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────┘
```

### FFmpeg Command for Frame Extraction

```bash
# Extract exactly 90 frames evenly distributed
ffmpeg -i input.mp4 \
  -vf "select='not(mod(n,${total_frames/90}))',setpts=N/TB" \
  -vsync vfr \
  -q:v 3 \
  -frames:v 90 \
  frame_%03d.jpg

# OR: extract at fixed FPS (more predictable)
ffmpeg -i input.mp4 \
  -vf fps=45 \
  -q:v 3 \
  frame_%03d.jpg

# Get precise timestamps per frame
ffprobe -v quiet -select_streams v:0 \
  -show_entries frame=pts_time \
  -of csv=p=0 input.mp4
```

### Node.js Implementation (Pseudocode)

```javascript
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

async function extractFrames(videoPath, count = 90) {
  const probe = await ffprobe(videoPath);
  const duration = probe.format.duration;
  const interval = duration / (count + 1);
  
  const frames = [];
  for (let i = 1; i <= count; i++) {
    const timestamp = interval * i;
    const framePath = `/tmp/frame_${i}.jpg`;
    
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .output(framePath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    // Resize to 640x360 for GPT
    const buffer = await sharp(framePath)
      .resize(640, 360)
      .jpeg({ quality: 65 })
      .toBuffer();
    
    frames.push({
      base64: buffer.toString('base64'),
      timestamp: parseFloat(timestamp.toFixed(3)),
      index: i
    });
  }
  
  return { frames, duration, frameCount: count };
}
```

---

## 3. JSON Response Design

```json
{
  "status": "success",
  "video": {
    "duration": 2.07,
    "fps": 30,
    "resolution": "1080x1920",
    "frameCount": 90,
    "frameTimestamps": [0.023, 0.046, 0.069, ...]
  },
  "phases": {
    "P1": { "frame": 4,  "timestamp": 0.114 },
    "P2": { "frame": 16, "timestamp": 0.386 },
    "P3": { "frame": 28, "timestamp": 0.659 },
    "P4": { "frame": 40, "timestamp": 0.931 },
    "P5": { "frame": 48, "timestamp": 1.113 },
    "P6": { "frame": 52, "timestamp": 1.204 },
    "P7": { "frame": 60, "timestamp": 1.385 },
    "P8": { "frame": 76, "timestamp": 1.749 }
  },
  "biomechanics": {
    "P1": { "spineAngle": 38, "shoulderTilt": 0, "hipRotation": 0 },
    "P4": { "spineAngle": 35, "shoulderTilt": 45, "hipRotation": 42 },
    "P6": { "spineAngle": 32, "shoulderTilt": 28, "hipRotation": 55 }
  },
  "coaching": {
    "overall_score": 78,
    "coach_insight": "...",
    "phases": [...],
    "angle_analysis": [...],
    "strengths": [...],
    "improvements": [...]
  },
  "debug": {
    "extractionMethod": "ffmpeg",
    "gptPass1Raw": "{...}",
    "gptRefineRaw": "{...}",
    "processingTime": 8.2
  }
}
```

---

## 4. Frontend Changes Required

### Remove
- `extractFrames()` — no longer needed
- `extractFrameAt()` — no longer needed
- `detectAnchorPhases()` — moves to backend
- `refineImpact()` — moves to backend
- MediaPipe WASM loading — moves to backend
- All Canvas-based frame extraction

### Keep
- Video upload UI
- Result display UI
- Phase thumbnail strip
- Video seek (`video.currentTime` for playback only)
- Debug panel

### New Frontend Flow
```javascript
// Upload video
const formData = new FormData();
formData.append('video', videoFile);
formData.append('club', selectedClub);
formData.append('view', selectedView);

const response = await fetch('/api/analyze-v2', {
  method: 'POST',
  body: formData
});

const result = await response.json();
// result contains everything: phases, biomechanics, coaching
renderResults(result);
```

---

## 5. Recommendation

### Option A: Backend FFmpeg ✅ RECOMMENDED

| Factor | Rating | Notes |
|--------|--------|-------|
| **Accuracy** | ⭐⭐⭐⭐⭐ | FFmpeg identical on all devices |
| **Consistency** | ⭐⭐⭐⭐⭐ | Same frames = same GPT result |
| **Cost** | ⭐⭐⭐ | Server compute + storage needed |
| **Scalability** | ⭐⭐⭐⭐ | Cloud Run auto-scales |
| **Mobile** | ⭐⭐⭐⭐⭐ | Zero browser dependency |
| **Dev effort** | ⭐⭐⭐ | ~2-3 weeks to migrate |

### Option B: Browser Extraction (Current)

| Factor | Rating | Notes |
|--------|--------|-------|
| **Accuracy** | ⭐⭐⭐ | Browser-dependent, ±3 frame variance |
| **Consistency** | ⭐⭐ | Different per browser/device |
| **Cost** | ⭐⭐⭐⭐⭐ | Zero server cost for extraction |
| **Scalability** | ⭐⭐⭐⭐⭐ | Client-side = infinite scale |
| **Mobile** | ⭐⭐⭐ | Safari issues, iOS quirks |
| **Dev effort** | ⭐⭐⭐⭐⭐ | Already done |

### Verdict

**Option A (Backend FFmpeg) is strongly recommended** because:

1. **Golf swing analysis requires frame-level precision** — ±3 frame difference at 30fps = ±0.1s, which is the entire duration of impact
2. **Cross-device consistency is non-negotiable** for a product — users expect same result on any device
3. **This aligns with your v3 architecture plan** (Node.js + GCS + Gemini) — this migration is already on the roadmap
4. **Eliminates entire class of bugs** — iOS Safari seek issues, QuickTime MIME types, WebKit canvas quirks

### Migration Priority

For **MVP launch (mid-June)**: Ship with browser extraction + duration warning. Acceptable because most beta testers will use the same device consistently.

For **v2 (post-launch)**: Migrate to backend FFmpeg as first priority. This is the foundation for everything else (coach marketplace, practice mode, dataset).

---

## 6. Implementation Timeline

| Week | Task |
|------|------|
| Week 1 | Set up Node.js backend on GCP Cloud Run + FFmpeg |
| Week 1 | Implement frame extraction endpoint |
| Week 2 | Migrate GPT phase detection to backend |
| Week 2 | Migrate MediaPipe to server-side Python |
| Week 3 | Integration testing + frontend simplification |
| Week 3 | Deploy + A/B test browser vs backend |
