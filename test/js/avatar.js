import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

// An outfit is either a Rocketbox avatar folder (model.fbx + body_color/normal/roughness textures)
// or a static .glb garment. Garments are fitted in Blender (blender/denyx_garments.blend) to
// GARMENT_BODY, the AVATAR in a T-shirt, and skinned to the avatar's skeleton when they load. The
// avatar follows the person but is not drawn; GARMENT_BODY and its head are drawn depth-only, so
// they hide what is behind the person (the back of a garment, a lanyard behind the neck). A garment
// with a `bone` rides on that bone rigidly; any other bends with the body under it.
export const OUTFITS = [
  { id: "male_adult_07", name: "Grey blazer, shirt & jeans", path: "assets/avatars/male_adult_07/" },
  { id: "denyx_apron", name: "DENYX apron", garment: "assets/garments/denyx_apron.glb" },
  { id: "denyx_badge", name: "DENYX lanyard badge", garment: "assets/garments/denyx_badge.glb", bone: "spine2" },
];
const AVATAR = "assets/avatars/male_adult_07/";
const GARMENT_BODY = "assets/garments/body.glb";
// Garments are in meters; the Rocketbox FBX is in centimeters.
const BODY_UNITS_PER_METER = 100;

// 3ds Max Biped bone names, shared by every Rocketbox avatar.
const BONE_PATTERNS = {
  hips: /_pelvis$/i, spine: /_spine$/i, spine1: /_spine1$/i, spine2: /_spine2$/i,
  neck: /_neck$/i, head: /_head$/i, lClavicle: /_l_clavicle$/i, rClavicle: /_r_clavicle$/i,
  lUpperArm: /_l_upperarm$/i, lForearm: /_l_forearm$/i, lHand: /_l_hand$/i, lFinger: /_l_finger2$/i,
  rUpperArm: /_r_upperarm$/i, rForearm: /_r_forearm$/i, rHand: /_r_hand$/i, rFinger: /_r_finger2$/i,
  lThigh: /_l_thigh$/i, lCalf: /_l_calf$/i, lFoot: /_l_foot$/i, lToe: /_l_toe0$/i,
  rThigh: /_r_thigh$/i, rCalf: /_r_calf$/i, rFoot: /_r_foot$/i, rToe: /_r_toe0$/i,
};

// Vertices driven by these bones are not drawn, so the user's real hands show through.
const HIDDEN_BONES = /hand|finger/i;

// MediaPipe pose landmark indices. "Left" is the person's left.
const LM = {
  nose: 0, lEar: 7, rEar: 8,
  l: { sh: 11, el: 13, wr: 15, pinky: 17, index: 19, hip: 23, knee: 25, ankle: 27, toe: 31 },
  r: { sh: 12, el: 14, wr: 16, pinky: 18, index: 20, hip: 24, knee: 26, ankle: 28, toe: 32 },
};

// `envMap` is what metal, glass and the Rocketbox clothes reflect; fabric doesn't reflect it.
export async function loadAvatar(outfit, { envMap = null } = {}) {
  if (!outfit.garment) {
    const { root, meshes } = await loadRocketbox(outfit.path, { textured: true, occlude: HIDDEN_BONES, envMap });
    return new Avatar(root, meshes[0].skeleton.bones);
  }
  const gltf = new GLTFLoader();
  const [{ root, meshes }, garment, body] = await Promise.all([
    loadRocketbox(AVATAR, { textured: false }),
    gltf.loadAsync(outfit.garment),
    gltf.loadAsync(GARMENT_BODY),
  ]);
  const avatar = new Avatar(root, meshes[0].skeleton.bones);
  const skeleton = new THREE.Skeleton(meshes[0].skeleton.bones);   // bound in the rest pose
  const nearest = nearestWeights(bodyVertices(meshes), 0.04 * BODY_UNITS_PER_METER);
  dress(avatar, skeleton, body.scene, nearest, { body: true });
  const rigid = outfit.bone && [[skeleton.bones.indexOf(avatar.bones[outfit.bone]), 1]];
  dress(avatar, skeleton, garment.scene, rigid ? () => rigid : nearest, { envMap });
  return avatar;
}

// With `textured`, the avatar's clothes are drawn, except where the `occlude` bones drive them.
// Without, nothing is drawn. Either way the head, and the `occlude` bones if any, are rendered
// depth-only.
async function loadRocketbox(path, { textured, occlude, envMap = null }) {
  const fbx = await new FBXLoader().loadAsync(path + "model.fbx");
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  let clothes = hidden;
  if (textured) {
    const texLoader = new THREE.TextureLoader();
    const tex = async (file, isColor) => {
      const t = await texLoader.loadAsync(path + file);
      if (isColor) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };
    const [map, normalMap, roughnessMap] = await Promise.all([
      tex("body_color.jpg", true), tex("body_normal.jpg"), tex("body_roughness.jpg"),
    ]);
    clothes = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 1, metalness: 0, envMap, envMapIntensity: 0.6 });
    maskByBones(clothes, "drop");
  }
  const occludeBones = new THREE.MeshBasicMaterial({ colorWrite: false });
  maskByBones(occludeBones, "keep");
  const occludeHead = new THREE.MeshBasicMaterial({ colorWrite: false });

  const meshes = [];
  fbx.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  if (!meshes.length) throw new Error(`No skinned mesh in ${path}`);

  for (const mesh of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (occlude) addHiddenAttribute(mesh, occlude);
    // Head, neck and hair are never drawn, but the head is rendered depth-only (an invisible
    // occluder) so the user's real neck hides the back of the collar. Same for the hands.
    mesh.material = mats.map(m => /head|opacity/i.test(m.name) ? hidden : clothes);
    const occluder = new THREE.SkinnedMesh(mesh.geometry,
      mats.map(m => /head/i.test(m.name) ? occludeHead : /opacity/i.test(m.name) || !occlude ? hidden : occludeBones));
    occluder.position.copy(mesh.position);
    occluder.quaternion.copy(mesh.quaternion);
    occluder.scale.copy(mesh.scale);
    occluder.bind(mesh.skeleton, mesh.bindMatrix);
    occluder.renderOrder = -1;          // write depth before the clothes are drawn
    mesh.parent.add(occluder);
    mesh.frustumCulled = occluder.frustumCulled = false;
  }
  return { root: fbx, meshes };
}

function addHiddenAttribute(mesh, bones) {
  const geo = mesh.geometry;
  if (geo.attributes.aHidden) return;
  const hiddenIdx = new Set();
  mesh.skeleton.bones.forEach((b, i) => { if (bones.test(b.name)) hiddenIdx.add(i); });
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const out = new Float32Array(si.count);
  for (let v = 0; v < si.count; v++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (hiddenIdx.has(si.getComponent(v, k))) w += sw.getComponent(v, k);
    out[v] = w;
  }
  geo.setAttribute("aHidden", new THREE.BufferAttribute(out, 1));
}

// "drop" discards hidden-bone vertices; "keep" draws only them.
function maskByBones(material, mode) {
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aHidden;\nvarying float vHidden;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHidden = aHidden;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vHidden;")
      .replace("void main() {", `void main() {\n\tif (vHidden ${mode === "drop" ? ">" : "<"} 0.5) discard;`);
  };
  material.customProgramCacheKey = () => `bonemask-${mode}`;
}

// ---------- Garments ----------
// Skin a model fitted to the body's rest pose (a garment, or with `body` the garment body) to the
// avatar's skeleton. The avatar's root is still at the origin here, so world space is the body's
// own space. The body is drawn twice: depth-only first, to hide what is behind the person, and
// then as a shadow catcher, so the garment's shadow falls on the person's clothes.
const OCCLUDER = new THREE.MeshBasicMaterial({ colorWrite: false });
const SHADOW = new THREE.ShadowMaterial({ opacity: 0.32, depthWrite: false });

function dress(avatar, skeleton, scene, weightsAt, { body = false, envMap = null } = {}) {
  const toBody = new THREE.Matrix4().makeScale(BODY_UNITS_PER_METER, BODY_UNITS_PER_METER, BODY_UNITS_PER_METER);
  const parts = [];
  scene.updateMatrixWorld(true);
  scene.traverse(o => { if (o.isMesh) parts.push(o); });
  for (const part of parts) {
    const geometry = part.geometry.clone().applyMatrix4(toBody.clone().multiply(part.matrixWorld));
    // body.glb has no normals (it was only an occluder), but shadow lookups need them.
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    // The view is mirrored, so prints are too, or they would read backwards.
    if (!body && part.material.map) mirrorPrint(geometry);
    setSkin(geometry, weightsAt);
    const meshes = body ? [new THREE.SkinnedMesh(geometry, OCCLUDER), new THREE.SkinnedMesh(geometry, SHADOW)]
      : [new THREE.SkinnedMesh(geometry, garmentMaterial(part.material, envMap, uvPerCm(geometry)))];
    for (const mesh of meshes) {
      mesh.name = part.name;
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      avatar.root.add(mesh);
    }
    if (body) {
      meshes[0].renderOrder = -1;     // write depth before the garment is drawn
      meshes[1].receiveShadow = true;
    } else {
      meshes[0].castShadow = true;
    }
  }
}

// The models' materials suit a 3D viewer; over a camera image they looked like glossy plastic.
// So each is remade as what it is: fabric, print and card are matte (rough, with a faint
// specular and a soft sheen at grazing angles, and no studio reflections), metal is brushed and
// glass reflects a little. Woven fabric (by material name) gets a fabric texture, and everything
// gets the camera's grain (FILM), so the garment isn't cleaner than the video around it.
const WOVEN = /denim|fabric|cloth|cotton|canvas|ribbon|webbing/i;
export const FILM = { time: { value: 0 }, grain: { value: 0.012 } };

function garmentMaterial(m, envMap, uvScale) {
  const base = { name: m.name, color: m.color, map: m.map, side: m.side, transparent: m.transparent,
    opacity: m.opacity, alphaTest: m.alphaTest, depthWrite: m.depthWrite };
  let out;
  if (m.metalness > 0.5) {
    out = new THREE.MeshStandardMaterial({ ...base, metalness: 1, roughness: Math.max(m.roughness, 0.5), envMap, envMapIntensity: 0.5 });
  } else if (m.transparent && !m.map) {
    out = new THREE.MeshStandardMaterial({ ...base, metalness: 0, roughness: 0.2, envMap, envMapIntensity: 0.3 });
  } else {
    out = new THREE.MeshPhysicalMaterial({ ...base, metalness: 0, roughness: 0.95, specularIntensity: 0.3,
      sheen: 1, sheenRoughness: 0.75, sheenColor: m.color.clone().lerp(new THREE.Color(1, 1, 1), 0.25).multiplyScalar(0.35) });
    if (WOVEN.test(m.name) && !m.map && uvScale > 0) {
      const { shade, bumps, mean } = fabricTextures();
      const repeat = 1 / (FABRIC_TILE_CM * uvScale);
      out.color.multiplyScalar(1 / mean);
      out.map = shade.clone();
      out.normalMap = bumps.clone();
      for (const t of [out.map, out.normalMap]) t.repeat.set(repeat, repeat);
      out.normalScale.set(0.6, 0.6);
    }
  }
  out.onBeforeCompile = shader => {
    shader.uniforms.filmTime = FILM.time;
    shader.uniforms.filmGrain = FILM.grain;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform float filmTime;\nuniform float filmGrain;\nvoid main() {")
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
        gl_FragColor.rgb += (fract(sin(dot(gl_FragCoord.xy + filmTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * filmGrain;`);
  };
  out.customProgramCacheKey = () => "film";
  return out;
}

// UV units per centimeter of the surface, from the mesh's triangles.
function uvPerCm(geometry) {
  const pos = geometry.attributes.position, uv = geometry.attributes.uv, index = geometry.index;
  if (!uv) return 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  let area = 0, uvArea = 0;
  const n = index ? index.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const [a, b, c] = index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2];
    A.fromBufferAttribute(pos, a); B.fromBufferAttribute(pos, b); C.fromBufferAttribute(pos, c);
    area += B.sub(A).cross(C.sub(A)).length() / 2;
    const ux = uv.getX(b) - uv.getX(a), uy = uv.getY(b) - uv.getY(a), vx = uv.getX(c) - uv.getX(a), vy = uv.getY(c) - uv.getY(a);
    uvArea += Math.abs(ux * vy - uy * vx) / 2;
  }
  return area > 0 ? Math.sqrt(uvArea / area) : 0;
}

// A tileable woven texture, made once: a color multiplier (soft mottle, lengthwise streaks, a
// faint twill) and a normal map (the twill's ribs and a gentle unevenness). One tile is
// FABRIC_TILE_CM of fabric.
const FABRIC_TILE_CM = 10;
let fabric = null;
function fabricTextures() {
  if (fabric) return fabric;
  const N = 512;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const smooth = t => t * t * (3 - 2 * t);
  // Tileable value noise with cx by cy cells.
  const noise = (cx, cy) => {
    const g = Array.from({ length: cx * cy }, rnd);
    return (x, y) => {
      const fx = x / N * cx, fy = y / N * cy, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = smooth(fx - x0), ty = smooth(fy - y0);
      const at = (i, j) => g[(j % cy) * cx + (i % cx)];
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
      return top + (bottom - top) * ty - 0.5;
    };
  };
  const mottle = noise(8, 8), fine = noise(32, 32), streaks = noise(96, 4), undulate = noise(3, 3);
  const shadeData = new Uint8Array(N * N * 4), height = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const twill = Math.sin(2 * Math.PI * (x + y) / 5);
      const i = y * N + x;
      height[i] = 0.25 * twill + 0.6 * streaks(x, y) + 3 * undulate(x, y);
      const v = 1 + 0.08 * mottle(x, y) + 0.04 * fine(x, y) + 0.06 * streaks(x, y) + 0.02 * twill + 0.02 * (rnd() - 0.5);
      shadeData.fill(Math.round(THREE.MathUtils.clamp(v * 220, 0, 255)), i * 4, i * 4 + 3);
      shadeData[i * 4 + 3] = 255;
    }
  }
  // The multiplier averages below 1 (sRGB 220 leaves room above), so the material's color is
  // divided by its mean.
  const linear = Array.from({ length: 256 }, (_, v) => new THREE.Color().setRGB(v / 255, 0, 0, THREE.SRGBColorSpace).r);
  let sum = 0;
  for (let i = 0; i < shadeData.length; i += 4) sum += linear[shadeData[i]];
  const mean = sum / (N * N);
  const bumpData = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const h = (i, j) => height[((j + N) % N) * N + ((i + N) % N)];
      const nx = (h(x - 1, y) - h(x + 1, y)) / 2, ny = (h(x, y - 1) - h(x, y + 1)) / 2, len = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      bumpData[i] = (nx / len * 0.5 + 0.5) * 255;
      bumpData[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      bumpData[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      bumpData[i + 3] = 255;
    }
  }
  const texture = data => {
    const t = new THREE.DataTexture(data, N, N);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  fabric = { shade: texture(shadeData), bumps: texture(bumpData), mean };
  fabric.shade.colorSpace = THREE.SRGBColorSpace;
  return fabric;
}

// Flip a texture left to right on its part of the model.
function mirrorPrint(geometry) {
  const uv = geometry.attributes.uv;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < uv.count; i++) { lo = Math.min(lo, uv.getX(i)); hi = Math.max(hi, uv.getX(i)); }
  for (let i = 0; i < uv.count; i++) uv.setX(i, lo + hi - uv.getX(i));
}

// The body's vertices in the rest pose, with their skin weights, without duplicates.
function bodyVertices(meshes) {
  const out = [], seen = new Set();
  for (const mesh of meshes) {
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      const p = mesh.localToWorld(mesh.getVertexPosition(i, new THREE.Vector3()));
      const id = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const skin = [];
      for (let k = 0; k < 4; k++) if (skinWeight.getComponent(i, k) > 0) skin.push([skinIndex.getComponent(i, k), skinWeight.getComponent(i, k)]);
      out.push({ p, skin });
    }
  }
  return out;
}

// Skin weights at a point: the nearest body vertices' weights, blended by inverse squared distance.
function nearestWeights(body, cell, k = 6) {
  const grid = new Map(), c = q => Math.floor(q / cell), key = (x, y, z) => `${x},${y},${z}`;
  for (const v of body) {
    const id = key(c(v.p.x), c(v.p.y), c(v.p.z));
    if (!grid.has(id)) grid.set(id, []);
    grid.get(id).push(v);
  }
  return p => {
    // Search shells of grid cells outward until k vertices are found, plus one shell for nearer ones.
    const x0 = c(p.x), y0 = c(p.y), z0 = c(p.z), found = [];
    for (let r = 0, last = Infinity; r <= last; r++) {
      for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++) {
        if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== r) continue;
        for (const v of grid.get(key(x0 + x, y0 + y, z0 + z)) ?? []) found.push([v, v.p.distanceToSquared(p)]);
      }
      if (last === Infinity && found.length >= k) last = r + 1;
    }
    const acc = new Map();
    for (const [v, d2] of found.sort((a, b) => a[1] - b[1]).slice(0, k)) {
      const w = 1 / (d2 + cell * cell * 1e-4);
      for (const [bone, x] of v.skin) acc.set(bone, (acc.get(bone) ?? 0) + w * x);
    }
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((t, [, x]) => t + x, 0);
    return top.map(([bone, x]) => [bone, x / sum]);
  };
}

function setSkin(geometry, weightsAt) {
  const pos = geometry.attributes.position, p = new THREE.Vector3();
  const index = new Uint16Array(pos.count * 4), weight = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    weightsAt(p.fromBufferAttribute(pos, i)).forEach(([bone, w], k) => { index[i * 4 + k] = bone; weight[i * 4 + k] = w; });
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
}

// ---------- Retargeting ----------
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();

// Rotation whose X axis is `xv` (body left) and Y axis is `upv` made orthogonal to it.
function bodyFrame(xv, upv, out) {
  _x.copy(xv).normalize();
  _y.copy(upv).addScaledVector(_x, -_x.dot(upv)).normalize();
  _z.crossVectors(_x, _y);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

// Rotation whose X axis is `xv` and Z axis (forward) is `fwd` made orthogonal to it.
function headFrame(xv, fwd, out) {
  _x.copy(xv).normalize();
  _z.copy(fwd).addScaledVector(_x, -_x.dot(fwd)).normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

const xyDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

class Avatar {
  constructor(root, bones) {
    this.root = root;
    this.bones = {};
    for (const [key, re] of Object.entries(BONE_PATTERNS)) {
      this.bones[key] = bones.find(b => re.test(b.name)) || null;
      if (!this.bones[key]) console.warn(`Avatar bone not found: ${key}`);
    }

    root.updateMatrixWorld(true);
    this.restLocal = new Map(bones.map(b => [b, b.quaternion.clone()]));
    this.restWorld = new Map(bones.map(b => [b, b.getWorldQuaternion(new THREE.Quaternion())]));

    const P = k => this.bones[k].getWorldPosition(new THREE.Vector3());
    const up = P("neck").sub(P("hips"));
    this.hipRestInv = bodyFrame(P("lThigh").sub(P("rThigh")), up, new THREE.Quaternion()).invert();
    this.chestRestInv = bodyFrame(P("lUpperArm").sub(P("rUpperArm")), up, new THREE.Quaternion()).invert();
    // The model looks along +Z; a neutral MediaPipe nose-to-ears vector points slightly down.
    this.headRestInv = headFrame(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -0.25, 1), new THREE.Quaternion()).invert();
    this.modelShoulder = P("lUpperArm").distanceTo(P("rUpperArm"));
    const midShoulder = P("lUpperArm").add(P("rUpperArm")).multiplyScalar(0.5);
    const midHip = P("lThigh").add(P("rThigh")).multiplyScalar(0.5);
    this.modelTorso = midShoulder.distanceTo(midHip);
    // Upper-arm joints sit at the end of the clavicles; moving them in or out changes shoulder width.
    this.upperArmRest = { l: this.bones.lUpperArm.position.clone(), r: this.bones.rUpperArm.position.clone() };
    this.pxPerMeter = null;
    this.scale = null;
  }

  // Another person wearing the same outfit: a copy sharing the meshes and materials, with its own
  // bones. Copy an avatar that hasn't been posed (update() moves its bones).
  clone() {
    const root = cloneSkinned(this.root);
    const bones = [];
    root.traverse(o => { if (o.isBone) bones.push(o); });
    return new Avatar(root, bones);
  }

  /**
   * Pose the avatar to match the person.
   * pose.img: Vector3 per landmark in screen space (x right, y up, pixels, unmirrored camera image)
   * pose.wld: Vector3 per landmark in meters (x right, y up, z toward the camera)
   * pose.vis: visibility per landmark
   */
  update(pose, opts) {
    const { img, wld, vis } = pose;
    const B = this.bones, root = this.root;

    // Pixels per meter, from the shoulder line and the torso (robust to turning sideways).
    const midShW = _a.addVectors(wld[11], wld[12]).multiplyScalar(0.5);
    const midHipW = _b.addVectors(wld[23], wld[24]).multiplyScalar(0.5);
    const midShI = new THREE.Vector3().addVectors(img[11], img[12]).multiplyScalar(0.5);
    const midHipI = new THREE.Vector3().addVectors(img[23], img[24]).multiplyScalar(0.5);
    const k = (xyDist(img[11], img[12]) + xyDist(midShI, midHipI)) / (xyDist(wld[11], wld[12]) + xyDist(midShW, midHipW));
    this.pxPerMeter = this.pxPerMeter == null ? k : this.pxPerMeter + (k - this.pxPerMeter) * 0.2;
    const shoulderPx = this.pxPerMeter * wld[11].distanceTo(wld[12]);
    const torsoPx = this.pxPerMeter * midShW.distanceTo(midHipW);

    // Overall size from torso length; MediaPipe's shoulder points sit closer together than the
    // model's shoulder joints, so shoulder width alone makes the outfit too small.
    const scale = torsoPx / this.modelTorso;
    this.scale = this.scale == null ? scale : this.scale + (scale - this.scale) * 0.15;
    root.position.set(0, 0, 0);
    root.scale.setScalar(this.scale * opts.fit);

    // Then move the shoulder joints most of the way toward the person's shoulder width
    // (not all the way, so the jacket still covers the real shoulders).
    const halfDelta = (shoulderPx / this.scale - this.modelShoulder) / 2;
    for (const s of ["l", "r"]) {
      const rest = this.upperArmRest[s], len = rest.length();
      B[s + "UpperArm"].position.copy(rest).multiplyScalar(THREE.MathUtils.clamp((len + halfDelta * 0.7) / len, 0.5, 1.4));
    }
    root.updateMatrixWorld(true);

    // Torso, neck and head from body frames.
    const up = _c.subVectors(midShW, midHipW);
    const qHip = bodyFrame(_d.subVectors(wld[23], wld[24]), up, new THREE.Quaternion()).multiply(this.hipRestInv);
    const qChest = bodyFrame(_d.subVectors(wld[11], wld[12]), up, new THREE.Quaternion()).multiply(this.chestRestInv);
    const midEar = _d.addVectors(wld[LM.lEar], wld[LM.rEar]).multiplyScalar(0.5);
    const qHead = headFrame(_a.subVectors(wld[LM.lEar], wld[LM.rEar]), _b.subVectors(wld[LM.nose], midEar), new THREE.Quaternion())
      .multiply(this.headRestInv);

    this.setWorldRotation(B.hips, qHip);
    this.setWorldRotation(B.spine, _qc.slerpQuaternions(qHip, qChest, 0.33));
    this.setWorldRotation(B.spine1, _qc.slerpQuaternions(qHip, qChest, 0.66));
    this.setWorldRotation(B.spine2, qChest);
    this.setWorldRotation(B.neck, _qc.slerpQuaternions(qChest, qHead, 0.5));
    this.setWorldRotation(B.head, qHead);
    // Biped clavicles hang off the neck; keep them with the chest so head turns don't move the shoulders.
    this.setWorldRotation(B.lClavicle, qChest);
    this.setWorldRotation(B.rClavicle, qChest);

    // Limbs: point each bone at the next joint. Joints the camera can't see keep the rest pose.
    for (const [s, lm] of [["l", LM.l], ["r", LM.r]]) {
      const handTip = _a.addVectors(wld[lm.pinky], wld[lm.index]).multiplyScalar(0.5);
      this.aim(B[s + "UpperArm"], B[s + "Forearm"], wld[lm.sh], wld[lm.el], vis[lm.el] > 0.3);
      this.aim(B[s + "Forearm"], B[s + "Hand"], wld[lm.el], wld[lm.wr], vis[lm.el] > 0.3 && vis[lm.wr] > 0.3);
      this.aim(B[s + "Hand"], B[s + "Finger"], wld[lm.wr], handTip, vis[lm.wr] > 0.3);
      this.aim(B[s + "Thigh"], B[s + "Calf"], wld[lm.hip], wld[lm.knee], vis[lm.knee] > 0.5);
      this.aim(B[s + "Calf"], B[s + "Foot"], wld[lm.knee], wld[lm.ankle], vis[lm.knee] > 0.5 && vis[lm.ankle] > 0.5);
      this.aim(B[s + "Foot"], B[s + "Toe"], wld[lm.ankle], wld[lm.toe], vis[lm.ankle] > 0.5 && vis[lm.toe] > 0.5);
    }

    // Place the model so its shoulder joints sit on the person's shoulders.
    root.updateMatrixWorld(true);
    const ml = B.lUpperArm.getWorldPosition(_a), mr = B.rUpperArm.getWorldPosition(_b);
    const m = ml.add(mr).multiplyScalar(0.5);
    root.position.set(midShI.x - m.x, midShI.y - m.y + opts.offset * shoulderPx, -m.z);
    root.updateMatrixWorld(true);
  }

  // Give `bone` the world rotation `delta * restWorld`, i.e. its rest orientation turned by `delta`.
  setWorldRotation(bone, delta) {
    if (!bone) return;
    const desired = _qa.copy(delta).multiply(this.restWorld.get(bone));
    bone.parent.getWorldQuaternion(_qb);
    bone.quaternion.copy(_qb.invert().multiply(desired));
    bone.updateMatrixWorld(true);
  }

  // Rotate `bone` (from its rest pose) so the direction to `child` points from `from` to `to`.
  aim(bone, child, from, to, enabled) {
    if (!bone || !child) return;
    bone.quaternion.copy(this.restLocal.get(bone));
    bone.updateMatrixWorld(true);
    if (!enabled) return;
    const target = _x.subVectors(to, from);
    if (target.lengthSq() < 1e-8) return;
    const qWorld = bone.getWorldQuaternion(_qa);
    const current = _y.copy(child.position).normalize().applyQuaternion(qWorld);
    _qb.setFromUnitVectors(current, target.normalize());
    qWorld.premultiply(_qb);
    bone.parent.getWorldQuaternion(_qc);
    bone.quaternion.copy(_qc.invert().multiply(qWorld));
    bone.updateMatrixWorld(true);
  }
}
