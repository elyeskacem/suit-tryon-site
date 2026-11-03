import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { OUTFITS, FILM, loadAvatar } from "./avatar.js";
import { syntheticPose } from "./pose-test.js";
import { Webcam, PROFILES, listCameras, describeProblem, describeStartError } from "./camera.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
const MODEL_URL = isMobile
  ? "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
  : "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const params = new URLSearchParams(location.search);
const testPose = params.get("test");

const $ = s => document.querySelector(s);
const video = $("#video"), bg = $("#bg"), glCanvas = $("#gl"), dbg = $("#debugOverlay"), view = $("#view");
const stage = $("#stage"), overlay = $("#overlay"), statusEl = $("#status"), hintEl = $("#hint"), fpsEl = $("#fps");

const settings = { fit: 1, offset: 0, autoLight: true, skeleton: !!testPose };

// ---------- Three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// A studio for metal and glass to reflect. Fabric doesn't reflect it (see garmentMaterial).
const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
// Soft light from above, as indoors: a sky/ground fill and a key light from above the camera,
// which also casts the garment's shadow on the person. Their color follows the camera image, and
// the exposure makes a garment as bright as the scene's light would (see matchLighting).
const KEY_DIR = new THREE.Vector3(0, 0.75, 0.66).normalize();
const KEY = 1.2, SKY = 1, GROUND = 0.3;
const FRONT_IRRADIANCE = KEY * KEY_DIR.z + (SKY + GROUND) / 2;   // on a surface facing the camera
const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, SKY);
const key = new THREE.DirectionalLight(0xffffff, KEY);
key.castShadow = true;
key.shadow.mapSize.setScalar(isMobile ? 1024 : 2048);
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
  key.position.copy(key.target.position).addScaledVector(KEY_DIR, 3000);
  const shadowCam = key.shadow.camera, half = Math.max(W, H) * 0.75;
  Object.assign(shadowCam, { left: -half, right: half, top: half, bottom: -half, near: 100, far: 6000 });
  shadowCam.updateProjectionMatrix();
  fitView();
}
function fitView() {
  const maxW = stage.clientWidth, maxH = stage.clientHeight;
  const s = Math.min(maxW / W, maxH / H);
  view.style.width = `${Math.floor(W * s)}px`;
  view.style.height = `${Math.floor(H * s)}px`;
}
window.addEventListener("resize", fitView);
resize(W, H);

// ---------- Outfit ----------
// Only the DENYX garments are offered; each gets a card with a thumbnail from assets/ui/.
const CHOICES = OUTFITS.filter(o => o.garment);
const CARD_TEXT = { denyx_apron: ["Apron", "Denim bib apron"], denyx_badge: ["Badge", "Lanyard & card holder"] };
const outfitCards = CHOICES.map(o => {
  const [name, note] = CARD_TEXT[o.id] ?? [o.name, ""];
  const card = document.createElement("button");
  card.className = "outfit";
  card.dataset.id = o.id;
  card.setAttribute("role", "radio");
  card.innerHTML = `<span class="thumb"><img src="assets/ui/${o.id}.png" alt=""></span><span><b>${name}</b><small>${note}</small></span>`;
  card.onclick = () => { if (card.getAttribute("aria-checked") !== "true") setOutfit(o.id); };
  return card;
});
$("#outfits").append(...outfitCards);

let avatar = null;
async function setOutfit(id) {
  const outfit = OUTFITS.find(o => o.id === id);
  for (const card of outfitCards) {
    card.disabled = true;
    card.setAttribute("aria-checked", card.dataset.id === id);
    card.classList.toggle("loading", card.dataset.id === id);
  }
  try {
    const next = await loadAvatar(outfit, { envMap });
    if (avatar) scene.remove(avatar.root);
    avatar = next;
    avatar.root.visible = false;
    scene.add(avatar.root);
  } finally {
    for (const card of outfitCards) { card.disabled = false; card.classList.remove("loading"); }
  }
}
const firstOutfit = CHOICES.some(o => o.id === params.get("outfit")) ? params.get("outfit") : CHOICES[0].id;
const avatarReady = setOutfit(firstOutfit).catch(err => {
  console.error(err);
  statusEl.className = "err";
  statusEl.textContent = `Could not load the 3D outfit: ${err.message || err}`;
});

// ---------- Controls ----------
$("#fit").oninput = e => settings.fit = +e.target.value;
$("#offset").oninput = e => settings.offset = +e.target.value;
$("#autoLight").onchange = e => {
  settings.autoLight = e.target.checked;
  if (!settings.autoLight) setLighting(NEUTRAL_LIGHT, white);
};
$("#skeleton").checked = settings.skeleton;
$("#skeleton").onchange = e => settings.skeleton = e.target.checked;
$("#resetFit").onclick = () => {
  for (const [id, value] of [["fit", 1], ["offset", 0]]) {
    $("#" + id).value = value;
    $("#" + id).dispatchEvent(new Event("input"));
  }
};

// Settings drawer.
const panel = $("#panel"), scrim = $("#scrim"), settingsBtn = $("#settingsBtn");
function showPanel(open) {
  panel.classList.toggle("open", open);
  scrim.hidden = !open;
  settingsBtn.setAttribute("aria-expanded", open);
}
settingsBtn.onclick = () => showPanel(!panel.classList.contains("open"));
$("#closePanel").onclick = scrim.onclick = () => showPanel(false);
window.addEventListener("keydown", e => { if (e.key === "Escape") showPanel(false); });

$("#snapBtn").onclick = () => {
  stage.classList.remove("flash");
  void stage.offsetWidth;   // restart the flash animation
  stage.classList.add("flash");
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
// A garment of albedo a, facing the camera, should come out about a * lightLevel bright (linear),
// as bright as the person's real clothes of that color: rendered brighter, it glowed like a
// sticker. A camera exposes for its scene, so the image's mean brightness says roughly how
// strongly the scene is lit. Dark clothes and dark rooms make that too low, so the face sets a
// floor: skin reflects at most about 45% of the light, so the light on the person is at least the
// face's brightness / 0.45. Whatever the skin tone, that floor is at most the real light, so it
// only corrects scenes darker on average than the light on the person. The light also takes on
// the image's color cast.
const probe = document.createElement("canvas");
probe.width = 24; probe.height = 14;
const probeCtx = probe.getContext("2d", { willReadFrequently: true });
const faceProbe = document.createElement("canvas");
faceProbe.width = faceProbe.height = 12;
const faceCtx = faceProbe.getContext("2d", { willReadFrequently: true });
const LINEAR = Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const NEUTRAL_LIGHT = 0.45;
const tint = new THREE.Color(), white = new THREE.Color(0xffffff);
let lightLevel = NEUTRAL_LIGHT;

function setLighting(level, color) {
  renderer.toneMappingExposure = level * Math.PI / FRONT_IRRADIANCE;
  FILM.grain.value = THREE.MathUtils.clamp(0.012 * Math.sqrt(NEUTRAL_LIGHT / level), 0.008, 0.03);   // dim scenes are grainier
  hemi.color.copy(color);
  hemi.groundColor.copy(color).multiplyScalar(GROUND / SKY);
  key.color.copy(color);
}

// The light on the face, from the skin between the eyes and the nose (its bright part, so
// glasses, eyes and beard don't count); 0 if the face isn't clearly in view.
function faceLight(src) {
  if (!pose || [0, 2, 5].some(i => pose.vis[i] < 0.5)) return 0;
  const a = pose.img[2], b = pose.img[5], nose = pose.img[0];
  const x = Math.min(a.x, b.x), y = -Math.max(a.y, b.y), w = Math.abs(a.x - b.x), h = -nose.y - y;
  if (w < 6 || h < 4) return 0;
  faceCtx.drawImage(src, x, y, w, h, 0, 0, faceProbe.width, faceProbe.height);
  const d = faceCtx.getImageData(0, 0, faceProbe.width, faceProbe.height).data;
  const lum = [];
  for (let i = 0; i < d.length; i += 4) lum.push(0.2126 * LINEAR[d[i]] + 0.7152 * LINEAR[d[i + 1]] + 0.0722 * LINEAR[d[i + 2]]);
  lum.sort((p, q) => p - q);
  return lum[Math.floor(lum.length * 0.75)] / 0.45;
}

function matchLighting(src) {
  probeCtx.drawImage(src, 0, 0, probe.width, probe.height);
  const d = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += LINEAR[d[i]]; g += LINEAR[d[i + 1]]; b += LINEAR[d[i + 2]]; }
  const n = d.length / 4;
  r /= n; g /= n; b /= n;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const level = Math.max(1.5 * lum, testPose ? 0 : faceLight(src));
  lightLevel += (THREE.MathUtils.clamp(level, 0.12, 0.8) - lightLevel) * 0.3;
  const m = Math.max(r, g, b, 1e-4);
  tint.setRGB(r / m, g / m, b / m, THREE.LinearSRGBColorSpace).lerp(white, 0.6);
  setLighting(lightLevel, tint);
}
setLighting(NEUTRAL_LIGHT, white);

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
  FILM.time.value = performance.now() % 1000;
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
window.tryon = { get pose() { return pose; }, get avatar() { return avatar; }, settings, renderer, scene, key };

$("#startBtn").onclick = () => startCamera({ profile: retryProfile });
if (testPose) startTest();
else if (params.has("autostart")) startCamera();
