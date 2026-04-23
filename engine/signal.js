export function computeWristSpeed(frames) {
  const speeds = [];

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].right_wrist;
    const curr = frames[i].right_wrist;

    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;

    const speed = Math.sqrt(dx * dx + dy * dy);
    speeds.push(speed);
  }

  return speeds;
}
