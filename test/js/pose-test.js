// Synthetic MediaPipe-style results for testing without a camera: open 3d.html?test=<pose>
// Poses: down, hips, wave, cross, turn, full
// World points are meters in MediaPipe's convention: x = image right (the person's left), y = down,
// z = away from the camera, origin between the hips.

const BASE = {
  0: [0, -0.7, -0.1], 7: [0.075, -0.68, 0], 8: [-0.075, -0.68, 0],
  11: [0.19, -0.5, 0], 12: [-0.19, -0.5, 0],
  23: [0.1, 0, 0], 24: [-0.1, 0, 0],
  25: [0.11, 0.45, -0.01], 26: [-0.11, 0.45, -0.01],
  27: [0.11, 0.88, 0.02], 28: [-0.11, 0.88, 0.02],
  29: [0.11, 0.92, 0.06], 30: [-0.11, 0.92, 0.06],
  31: [0.12, 0.94, -0.1], 32: [-0.12, 0.94, -0.1],
};

// [elbow, wrist] for the person's left arm; the right arm mirrors "down" unless the pose is symmetric.
const LEFT_ARM = {
  down: [[0.24, -0.22, 0.03], [0.26, 0.05, -0.01]],
  hips: [[0.4, -0.26, 0.06], [0.19, -0.03, -0.07]],
  wave: [[0.42, -0.66, 0.02], [0.45, -0.95, -0.03]],
  cross: [[0.23, -0.24, -0.12], [-0.06, -0.3, -0.26]],
};
const SYMMETRIC = new Set(["down", "hips"]);

export function syntheticPose(name, W, H) {
  const arm = LEFT_ARM[name] ? name : "down";
  const P = {};
  for (const [i, p] of Object.entries(BASE)) P[i] = [...p];
  const [le, lw] = LEFT_ARM[arm];
  const [re, rw] = LEFT_ARM[SYMMETRIC.has(arm) ? arm : "down"];
  P[13] = [...le]; P[15] = [...lw];
  P[14] = [-re[0], re[1], re[2]]; P[16] = [-rw[0], rw[1], rw[2]];

  // Hands: continue the forearm direction.
  for (const [el, wr, pinky, index, thumb] of [[13, 15, 17, 19, 21], [14, 16, 18, 20, 22]]) {
    const d = P[wr].map((v, k) => v - P[el][k]);
    const len = Math.hypot(...d);
    const at = (t, side) => P[wr].map((v, k) => v + (d[k] / len) * t + (k === 0 ? side : 0));
    P[pinky] = at(0.08, -0.015); P[index] = at(0.09, 0.015); P[thumb] = at(0.05, 0.03);
  }
  // Remaining face points cluster around the nose.
  for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) P[i] = [...P[0]];

  if (name === "turn") {
    const a = 0.6; // about 35 degrees
    for (const p of Object.values(P)) {
      const [x, z] = [p[0], p[2]];
      p[0] = x * Math.cos(a) + z * Math.sin(a);
      p[2] = -x * Math.sin(a) + z * Math.cos(a);
    }
  }

  const full = name === "full";
  const px = full ? 330 : 820;                  // pixels per meter
  const hipY = full ? 0.55 * H : 0.38 * H + 0.5 * px;
  const landmarks = [], worldLandmarks = [];
  for (let i = 0; i < 33; i++) {
    const p = P[i];
    landmarks.push({ x: (W / 2 + p[0] * px) / W, y: (hipY + p[1] * px) / H, z: p[2], visibility: 0.99 });
    worldLandmarks.push({ x: p[0], y: p[1], z: p[2], visibility: 0.99 });
  }
  return { landmarks: [landmarks], worldLandmarks: [worldLandmarks] };
}
