import { estimateShaftAngle } from "./shaft.js";

// P6 = shaft horizontal (~0–30 deg)
export function detectP6(frames) {
  for (let i = 0; i < frames.length; i++) {
    const angle = estimateShaftAngle(frames[i]);
    if (angle !== null && angle < 30) {
      return i;
    }
  }
  return null;
}

// P7 = shaft mendekati vertical (~60–100 deg)
export function detectP7ByShaft(frames) {
  let bestIndex = 0;
  let bestScore = 999;

  frames.forEach((f, i) => {
    const angle = estimateShaftAngle(f);
    if (angle === null) return;

    const diff = Math.abs(angle - 80); // target vertical-ish
    if (diff < bestScore) {
      bestScore = diff;
      bestIndex = i;
    }
  });

  return bestIndex;
}
