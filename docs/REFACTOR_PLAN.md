# SwingIQ — Phase Detection Refactor Plan v2

## Architecture: Vision AI + MediaPipe Geometry

### What's Removed
- ❌ Wrist velocity / Y peak detection
- ❌ Hip velocity / shoulder velocity
- ❌ Rule-based P1-P8 detection
- ❌ Auto-trim via pixel motion
- ❌ Simple interpolation for P2, P3, P5, P7

### What's New
- ✅ Vision AI → 4 anchor phases (P1, P4, P6, P8)
- ✅ MediaPipe Geometry → 4 derived phases (P2, P3, P5, P7)
- ✅ View-specific detection (Face On vs DTL)
- ✅ Shaft angle + Lead arm angle calculations

---

## Pipeline

```
Video Upload
    ↓
Extract 60 Frames + Timestamps
    ↓
Vision AI (GPT-4o / Gemini)
    → Detect P1, P4, P6, P8
    ↓
MediaPipe Geometry Detection
    → P2: Shaft Parallel (before P4)
    → P3: Lead Arm Parallel (before P4)
    → P5: Lead Arm Parallel (P4→P6)
    → P7: View-specific (FO: Lead Arm | DTL: Interpolated)
    ↓
Biomechanical Measurement (8 frames)
    ↓
GPT-4o Coaching (1 grid image + data)
    ↓
Result JSON → App
```

---

## Phase Detection Rules

### Anchor Phases (Vision AI)
| Phase | Name | Method |
|-------|------|--------|
| P1 | Setup/Address | Vision AI |
| P4 | Top of Backswing | Vision AI |
| P6 | Impact | Vision AI |
| P8 | Finish | Vision AI |

### Geometry Phases (MediaPipe)
| Phase | Name | Definition | Search Window |
|-------|------|------------|---------------|
| P2 | Takeaway | Shaft parallel to ground | P1 → P4 |
| P3 | Backswing | Lead arm parallel to ground | P2 → P4 |
| P5 | Downswing | Lead arm parallel to ground | P4 → P6 |
| P7 (FO) | Follow Through | Lead arm parallel to ground | P6 → P8 |
| P7 (DTL) | Follow Through | Interpolated 40% P6→P8 | P6 → P8 |

---

## Angle Calculations

### Lead Arm Angle
```
Vector: Left Shoulder → Left Wrist
Angle to horizontal = atan2(dy, dx) * 180/π
Target: closest to 0° (horizontal)
```

### Shaft Angle
```
Grip = midpoint(left_wrist, right_wrist)
Club Head = extrapolated from right_elbow → right_wrist
Angle to horizontal = atan2(dy, dx) * 180/π
Target: closest to 0° (horizontal)
```

---

## View-Specific Logic

### Face On
- P2: Shaft parallel ✅
- P3: Lead arm parallel ✅
- P5: Lead arm parallel ✅
- P7: Lead arm parallel ✅

### Down The Line
- P2: Shaft parallel ✅
- P3: Lead arm parallel ✅
- P5: Lead arm parallel ✅
- P7: **Interpolated** (DTL perspective makes arm detection unstable)

---

## Fallback Strategy
- If geometry detection deviation > 45°: use interpolation
- If Vision AI fails: use timing ratios
- If MediaPipe fails entirely: use pure interpolation

---

## Files
- `index69.html` — Frontend (Vision + Geometry + Biomechanics)
- `analyze_v5.js` — Backend API (coaching analysis)
