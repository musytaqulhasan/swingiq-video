// ===== SIMPLE SHAFT DETECTION =====
// NOTE: ini versi ringan (tanpa OpenCV), asumsi kamu punya 2 titik: wrist & clubhead (approx)

export function estimateShaftAngle(frame) {
  // fallback: pakai wrist → (approx) arah club
  const wrist = frame.right_wrist;
  const elbow = frame.right_elbow;

  if (!wrist || !elbow) return null;

  // vector arah lengan bawah (proxy shaft)
  const dx = wrist.x - elbow.x;
  const dy = wrist.y - elbow.y;

  const angleRad = Math.atan2(dy, dx);
  const angleDeg = Math.abs(angleRad * 180 / Math.PI);

  return angleDeg; // 0 = horizontal, 90 = vertical
}
