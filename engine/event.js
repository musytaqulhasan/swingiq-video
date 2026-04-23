export function detectP4(wristSpeed) {
  for (let i = 1; i < wristSpeed.length - 1; i++) {
    if (
      wristSpeed[i] < wristSpeed[i - 1] &&
      wristSpeed[i] < wristSpeed[i + 1]
    ) {
      return i;
    }
  }
  return 0;
}

export function detectP7(wristSpeed) {
  let max = 0;
  let index = 0;

  wristSpeed.forEach((v, i) => {
    if (v > max) {
      max = v;
      index = i;
    }
  });

  return index;
}
