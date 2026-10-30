import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { OUTFITS, loadAvatar } from "./avatar.js";
import { syntheticPose } from "./pose-test.js";
import { Webcam, PROFILES, listCameras, describeProblem, describeStartError } from "./camera.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
const MODEL_URL = isMobile
  ? "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
  : "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const testPose = new URLSearchParams(location.search).get("test");

const $ = s => document.querySelector(s);
const video = $("#video"), bg = $("#bg"), glCanvas = $("#gl"), dbg = $("#debugOverlay"), view = $("#view");
const overlay = $("#overlay"), statusEl = $("#status"), hintEl = $("#hint"), fpsEl = $("#fps");

const settings = { fit: 1, offset: 0, autoLight: true, skeleton: !!testPose };

// ---------- Three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.3);
const key = new THREE.DirectionalLight(0xffffff, 1.8);
scene.add(hemi, key, key.target);

// Orthographic camera in camera-image pixels: x right, y up (so y = -pixelRow).
const camera = new THREE.OrthographicCamera(0, 1, 0, -1, 1, 20000);
camera.position.z = 5000;

let W = 1280, H = 720;
function resize(w, h) {
  W = w; H = h;
  renderer.setSize(W, H, false);
  bg.width = dbg.width = W;
  bg.height = dbg.height = H;
  camera.right = W; camera.bottom = -H;
  camera.updateProjectionMatrix();
  key.target.position.set(W / 2, -H / 2, 0);
  key.position.set(W * 0.75, H * 0.1, 1500);
  fitView();
}
function fitView() {
  const maxW = view.parentElement.clientWidth, maxH = window.innerHeight * 0.8;
  const s = Math.min(maxW / W, maxH / H);
  view.style.width = `${Math.floor(W * s)}px`;
  view.style.height = `${Math.floor(H * s)}px`;
}
window.addEventListener("resize", fitView);
resize(W, H);

// ---------- Outfit ----------
let avatar = null;
const outfitSelect = $("#outfit");
for (const o of OUTFITS) outfitSelect.add(new Option(o.name, o.id));
async function setOutfit(id) {
  const outfit = OUTFITS.find(o => o.id === id);
  outfitSelect.disabled = true;
  try {
    const next = await loadAvatar(outfit);
    if (avatar) scene.remove(avatar.root);
    avatar = next;
    avatar.root.visible = false;
    scene.add(avatar.root);
  } finally {
    outfitSelect.disabled = false;
  }
}
const avatarReady = setOutfit(OUTFITS[0].id).catch(err => {
  console.error(err);
  statusEl.className = "err";
  statusEl.textContent = `Could not load the 3D outfit: ${err.message || err}`;
});
outfitSelect.onchange = e => setOutfit(e.target.value);

// ---------- Controls ----------
$("#fit").oninput = e => settings.fit = +e.target.value;
$("#offset").oninput = e => settings.offset = +e.target.value;
$("#autoLight").onchange = e => {
  settings.autoLight = e.target.checked;
  if (!settings.autoLight) { renderer.toneMappingExposure = 1; hemi.color.set(0xffffff); key.color.set(0xffffff); }
};
$("#skeleton").checked = settings.skeleton;
$("#skeleton").onchange = e => settings.skeleton = e.target.checked;
$("#snapBtn").onclick = () => {
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const c = out.getContext("2d");
  c.translate(W, 0); c.scale(-1, 1);   // same mirror as the screen
  c.drawImage(testPose ? bg : video, 0, 0, W, H);
  c.drawImage(glCanvas, 0, 0, W, H);
  out.toBlob(blob => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tryon-3d-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
};

// ---------- Pose tracking ----------
let landmarker = null;
async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = delegate => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: "VIDEO", numPoses: 1 });
  try {
    return await PoseLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU", err);
    return await PoseLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

// Smoothed pose: screen-space points (pixels, y up) and world points (meters, y up, z toward camera).
let pose = null, missing = 0;
function updatePose(result) {
  const lm = result?.landmarks?.[0], wl = result?.worldLandmarks?.[0];
  if (!lm || !wl) {
    if (++missing > 8) pose = null;
    return;
  }
  missing = 0;
  const img = lm.map(l => new THREE.Vector3(l.x * W, -l.y * H, 0));
  const wld = wl.map(l => new THREE.Vector3(l.x, -l.y, -l.z));
  const vis = lm.map(l => l.visibility ?? 1);
  if (!pose) { pose = { img, wld, vis }; return; }
  // Adaptive smoothing: steady when still, responsive when moving.
  const scale = Math.max(40, pose.img[11].distanceTo(pose.img[12]));
  for (let i = 0; i < img.length; i++) {
    const a = Math.min(0.9, 0.25 + img[i].distanceTo(pose.img[i]) / (scale * 0.3));
    pose.img[i].lerp(img[i], a);
    pose.wld[i].lerp(wld[i], a);
    pose.vis[i] += (vis[i] - pose.vis[i]) * 0.5;
  }
}

// ---------- Lighting from the camera image ----------
const probe = document.createElement("canvas");
probe.width = 24; probe.height = 14;
const probeCtx = probe.getContext("2d", { willReadFrequently: true });
const tint = new THREE.Color(), white = new THREE.Color(0xffffff);
let exposure = 1;
function matchLighting(src) {
  probeCtx.drawImage(src, 0, 0, probe.width, probe.height);
  const d = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = (d.length / 4) * 255;
  r /= n; g /= n; b /= n;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  exposure += (THREE.MathUtils.clamp(0.45 + lum * 1.2, 0.55, 1.45) - exposure) * 0.3;
  renderer.toneMappingExposure = exposure;
  const m = Math.max(r, g, b, 1e-3);
  tint.setRGB(r / m, g / m, b / m, THREE.SRGBColorSpace).lerp(white, 0.6);
  hemi.color.copy(tint);
  key.color.copy(tint);
}

// ---------- Main loop ----------
let lastVideoTime = -1, frames = 0, fpsFrames = 0, fpsT = performance.now();

function loop() {
  requestAnimationFrame(loop);
  let result;
  if (testPose) {
    result = syntheticPose(testPose, W, H);
  } else {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    if (video.videoWidth !== W || video.videoHeight !== H) resize(video.videoWidth, video.videoHeight);
    result = landmarker.detectForVideo(video, performance.now());
  }
  updatePose(result);
  render();

  frames++; fpsFrames++;
  const now = performance.now();
  if (now - fpsT > 1000) {
    fpsEl.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsT))} fps`;
    fpsFrames = 0; fpsT = now;
  }
  if (testPose && frames === 5) document.title = "ready";
}

function render() {
  let hint = "";
  if (!avatar) {
    hint = "Loading outfit…";
  } else if (!pose) {
    hint = "Step into view, facing the camera";
    avatar.root.visible = false;
  } else if (pose.vis[11] < 0.5 || pose.vis[12] < 0.5) {
    hint = "Face the camera so both shoulders are visible";
    avatar.root.visible = false;
  } else {
    avatar.update(pose, settings);
    avatar.root.visible = true;
  }
  if (settings.autoLight && frames % 10 === 0) matchLighting(testPose ? bg : video);
  renderer.render(scene, camera);
  drawDebug();
  hintEl.textContent = hint;
  hintEl.hidden = !hint;
}

function drawDebug() {
  const c = dbg.getContext("2d");
  c.clearRect(0, 0, W, H);
  if (!settings.skeleton || !pose) return;
  const p = i => [pose.img[i].x, -pose.img[i].y];
  c.strokeStyle = "rgba(0,255,170,0.9)"; c.lineWidth = 2;
  for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28]]) {
    c.beginPath(); c.moveTo(...p(a)); c.lineTo(...p(b)); c.stroke();
  }
  for (const i of [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26]) {
    c.fillStyle = pose.vis[i] > 0.5 ? "#0fa" : "#f55";
    c.beginPath(); c.arc(...p(i), 5, 0, Math.PI * 2); c.fill();
  }
}

// ---------- Start ----------
const webcam = new Webcam(video);
const cameraSelect = $("#cameraSelect");
let stopWatching = null, looping = false, retryProfile = 0;

async function startCamera(opts = {}) {
  const btn = $("#startBtn");
  btn.disabled = true;
  statusEl.className = "";
  overlay.hidden = false;
  stopWatching?.();
  try {
    statusEl.textContent = "Requesting camera…";
    await webcam.start(opts);
    resize(video.videoWidth, video.videoHeight);

    if (!landmarker) {
      statusEl.textContent = "Loading pose model and 3D outfit…";
      [landmarker] = await Promise.all([createLandmarker(), avatarReady]);
    }
    if (!avatar) throw new Error("the 3D outfit failed to load");

    overlay.hidden = true;
    fpsEl.hidden = false;
    $("#snapBtn").disabled = false;
    stopWatching = webcam.watch(onCameraProblem);
    fillCameraList();
    if (!looping) { looping = true; requestAnimationFrame(loop); }
  } catch (err) {
    console.error(err);
    statusEl.className = "err";
    statusEl.textContent = describeStartError(err);
    btn.disabled = false;
  }
}

function onCameraProblem(problem) {
  console.warn("Camera problem:", problem);
  hintEl.hidden = true;
  fpsEl.hidden = true;
  pose = null;
  overlay.hidden = false;
  statusEl.className = "err";
  statusEl.textContent = describeProblem(problem);
  const btn = $("#startBtn");
  btn.textContent = "Try again";
  btn.disabled = false;
  // A camera that disconnects or freezes often copes better with a lower resolution.
  retryProfile = problem === "black" ? webcam.profile : Math.min(webcam.profile + 1, PROFILES.length - 1);
}

async function fillCameraList() {
  const cams = await listCameras();
  cameraSelect.replaceChildren(...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  cameraSelect.value = webcam.deviceId;
  $("#cameraSection").hidden = cams.length < 2;
}
cameraSelect.onchange = e => startCamera({ deviceId: e.target.value, profile: 0 });

async function startTest() {
  overlay.hidden = true;
  fpsEl.hidden = false;
  const c = bg.getContext("2d");
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#8a8f98"); g.addColorStop(1, "#4b4f57");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  bg.hidden = false;
  video.hidden = true;
  await avatarReady;
  $("#snapBtn").disabled = false;
  requestAnimationFrame(loop);
}

// Handy for debugging from the browser console.
window.tryon = { get pose() { return pose; }, get avatar() { return avatar; }, settings };

$("#startBtn").onclick = () => startCamera({ profile: retryProfile });
if (testPose) startTest();
else if (new URLSearchParams(location.search).has("autostart")) startCamera();
