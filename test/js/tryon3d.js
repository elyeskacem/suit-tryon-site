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
// Everyone in view wears the outfit, up to this many people.
const MAX_PEOPLE = isMobile ? 3 : 4;
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
const CARD_TEXT = { denyx_apron: ["Apron", "Denim waist apron"], denyx_badge: ["Badge", "Lanyard & card holder"] };
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

// The loaded outfit is a template that is never posed; each person in view wears a copy of it.
let outfitTemplate = null;
function dressPerson(person) {
  if (person.avatar) scene.remove(person.avatar.root);
  person.avatar = outfitTemplate?.clone() ?? null;
  if (person.avatar) {
    person.avatar.root.visible = false;
    scene.add(person.avatar.root);
  }
}
async function setOutfit(id) {
  const outfit = OUTFITS.find(o => o.id === id);
  for (const card of outfitCards) {
    card.disabled = true;
    card.setAttribute("aria-checked", card.dataset.id === id);
    card.classList.toggle("loading", card.dataset.id === id);
  }
  try {
    outfitTemplate = await loadAvatar(outfit, { envMap });
    for (const person of people) dressPerson(person);
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
  const opts = delegate => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: "VIDEO", numPoses: MAX_PEOPLE });
  try {
    return await PoseLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU", err);
    return await PoseLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

// ---------- People ----------
// Each person: a smoothed pose (screen-space points in pixels, y up; world points in meters, y up,
// z toward the camera), how many frames they have gone undetected, and their copy of the outfit.
// MediaPipe lists the people it finds in no fixed order, so each frame every person is matched to
// the nearest detection, by the middle of the shoulders, nearest pairs first (with no distance
// limit, so someone moving fast keeps their copy). A detection left over is someone new; a person
// left over for a few frames has left.
const people = [];
let detected = 0;     // people MediaPipe found in the last frame
const shoulderMid = pose => new THREE.Vector3().addVectors(pose.img[11], pose.img[12]).multiplyScalar(0.5);
const reachOf = pose => Math.max(80, 1.5 * pose.img[11].distanceTo(pose.img[12]));

function updatePeople(result) {
  const found = (result?.landmarks ?? []).flatMap((lm, k) => {
    const wl = result.worldLandmarks?.[k];
    return wl ? [{
      img: lm.map(l => new THREE.Vector3(l.x * W, -l.y * H, 0)),
      wld: wl.map(l => new THREE.Vector3(l.x, -l.y, -l.z)),
      vis: lm.map(l => l.visibility ?? 1),
    }] : [];
  });
  detected = found.length;
  const pairs = [];
  people.forEach((person, i) => {
    const at = shoulderMid(person.pose);
    found.forEach((f, j) => pairs.push([at.distanceTo(shoulderMid(f)), i, j]));
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const matched = new Set(), taken = new Set();
  for (const [, i, j] of pairs) {
    if (matched.has(i) || taken.has(j)) continue;
    matched.add(i);
    taken.add(j);
    smoothPose(people[i], found[j]);
  }
  for (let i = people.length - 1; i >= 0; i--) {
    if (!matched.has(i) && ++people[i].missing > 8) removePerson(i);
  }
  for (const [j, f] of found.entries()) {
    // A second detection right on someone already tracked is the same person again.
    const duplicate = people.some(p => shoulderMid(p.pose).distanceTo(shoulderMid(f)) < reachOf(p.pose) / 2);
    if (taken.has(j) || duplicate || people.length >= MAX_PEOPLE) continue;
    const person = { pose: f, missing: 0, avatar: null };
    dressPerson(person);
    people.push(person);
  }
}

// Adaptive smoothing: steady when still, responsive when moving.
function smoothPose(person, next) {
  person.missing = 0;
  const pose = person.pose;
  const scale = Math.max(40, pose.img[11].distanceTo(pose.img[12]));
  for (let i = 0; i < next.img.length; i++) {
    const a = Math.min(0.9, 0.25 + next.img[i].distanceTo(pose.img[i]) / (scale * 0.3));
    pose.img[i].lerp(next.img[i], a);
    pose.wld[i].lerp(next.wld[i], a);
    pose.vis[i] += (next.vis[i] - pose.vis[i]) * 0.5;
  }
}

function removePerson(i) {
  if (people[i].avatar) scene.remove(people[i].avatar.root);
  people.splice(i, 1);
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

// The light on a face, from the skin between the eyes and the nose (its bright part, so glasses,
// eyes and beard don't count); 0 if the face isn't clearly in view. With several people, the
// brightest face sets the floor.
function faceLight(src, pose) {
  if ([0, 2, 5].some(i => pose.vis[i] < 0.5)) return 0;
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
  const faces = testPose ? [] : people.map(p => faceLight(src, p.pose));
  const level = Math.max(1.5 * lum, ...faces);
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
  updatePeople(result);
  render();

  frames++; fpsFrames++;
  const now = performance.now();
  if (now - fpsT > 1000) {
    fpsEl.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsT))} fps`;
    fpsFrames = 0; fpsT = now;
  }
  if (testPose && frames === 5) document.title = "ready";
}

// Where people overlap, the one nearer the camera (who looks bigger) must hide the other's
// garment. Each person is set this many centimeters (of their own size) in front of the person
// behind, more than a body is deep, so the bodies, drawn depth-only, sort them.
const DEPTH_GAP_CM = 20;

function render() {
  FILM.time.value = performance.now() % 1000;
  let shown = 0;
  for (const { pose, avatar } of people) {
    const visible = !!avatar && pose.vis[11] >= 0.5 && pose.vis[12] >= 0.5;
    if (visible) {
      avatar.update(pose, settings);
      shown++;
    }
    if (avatar) avatar.root.visible = visible;
  }
  let z = 0, behind = null;
  for (const { avatar } of people.filter(p => p.avatar?.root.visible).sort((a, b) => a.avatar.scale - b.avatar.scale)) {
    if (behind) z += DEPTH_GAP_CM * (behind.scale + avatar.scale);
    avatar.root.position.z += z;
    behind = avatar;
  }
  const hint = !outfitTemplate ? "Loading outfit…" : !people.length ? "Step into view, facing the camera"
    : !shown ? "Face the camera so both shoulders are visible" : "";
  if (settings.autoLight && frames % 10 === 0) matchLighting(testPose ? bg : video);
  renderer.render(scene, camera);
  drawDebug();
  hintEl.textContent = hint;
  hintEl.hidden = !hint;
}

function drawDebug() {
  const c = dbg.getContext("2d");
  c.clearRect(0, 0, W, H);
  if (!settings.skeleton) return;
  for (const { pose } of people) {
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
    if (!outfitTemplate) throw new Error("the 3D outfit failed to load");

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
  while (people.length) removePerson(0);
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
// pose and avatar are the first person's.
window.tryon = {
  get people() { return people; }, get detected() { return detected; }, get pose() { return people[0]?.pose ?? null; }, get avatar() { return people[0]?.avatar ?? null; },
  settings, renderer, scene, key,
};

$("#startBtn").onclick = () => startCamera({ profile: retryProfile });
if (testPose) startTest();
else if (params.has("autostart")) startCamera();
