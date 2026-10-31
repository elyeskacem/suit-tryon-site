import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// An outfit is either a Rocketbox avatar folder (model.fbx + body_color/normal/roughness textures)
// or a static .glb garment. Garments are fitted to the BODY avatar in Blender
// (blender/denyx_garments.blend) and skinned to its skeleton when they load; that body follows
// the person but is not drawn. A garment with a `bone` rides on that bone rigidly; any other
// bends with the body under it.
export const OUTFITS = [
  { id: "male_adult_07", name: "Grey blazer, shirt & jeans", path: "assets/avatars/male_adult_07/" },
  { id: "denyx_apron", name: "DENYX apron", garment: "assets/garments/denyx_apron.glb" },
  { id: "denyx_badge", name: "DENYX lanyard badge", garment: "assets/garments/denyx_badge.glb", bone: "spine2" },
];
const BODY = "assets/avatars/male_adult_07/";
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
// Under a garment the whole body occludes: it hides the garment's back, and arms in front of it.
const ALL_BONES = /./;

// MediaPipe pose landmark indices. "Left" is the person's left.
const LM = {
  nose: 0, lEar: 7, rEar: 8,
  l: { sh: 11, el: 13, wr: 15, pinky: 17, index: 19, hip: 23, knee: 25, ankle: 27, toe: 31 },
  r: { sh: 12, el: 14, wr: 16, pinky: 18, index: 20, hip: 24, knee: 26, ankle: 28, toe: 32 },
};

export async function loadAvatar(outfit) {
  if (!outfit.garment) {
    const { root, meshes } = await loadRocketbox(outfit.path, { textured: true, occlude: HIDDEN_BONES });
    return new Avatar(root, meshes[0].skeleton);
  }
  const [body, gltf] = await Promise.all([
    loadRocketbox(BODY, { textured: false, occlude: ALL_BONES }),
    new GLTFLoader().loadAsync(outfit.garment),
  ]);
  const avatar = new Avatar(body.root, body.meshes[0].skeleton);
  dress(avatar, body.meshes, gltf.scene, outfit);
  return avatar;
}

// With `textured`, the avatar's clothes are drawn, except where the `occlude` bones drive them.
// Without, nothing is drawn. Either way the head and the `occlude` bones are rendered depth-only.
async function loadRocketbox(path, { textured, occlude }) {
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
    clothes = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 1, metalness: 0 });
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
    addHiddenAttribute(mesh, occlude);
    // Head, neck and hair are never drawn, but the head is rendered depth-only (an invisible
    // occluder) so the user's real neck hides the back of the collar. Same for the hands.
    mesh.material = mats.map(m => /head|opacity/i.test(m.name) ? hidden : clothes);
    const occluder = new THREE.SkinnedMesh(mesh.geometry,
      mats.map(m => /head/i.test(m.name) ? occludeHead : /opacity/i.test(m.name) ? hidden : occludeBones));
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
// Skin a garment, already fitted to the body's rest pose, to the avatar's skeleton. The avatar's
// root is still at the origin here, so world space is the body's own space.
function dress(avatar, meshes, garment, outfit) {
  const bones = meshes[0].skeleton.bones;
  let weightsAt;
  if (outfit.bone) {
    const rigid = [[bones.indexOf(avatar.bones[outfit.bone]), 1]];
    weightsAt = () => rigid;
  } else {
    weightsAt = nearestWeights(bodyVertices(meshes), 0.04 * BODY_UNITS_PER_METER);
  }

  const toBody = new THREE.Matrix4().makeScale(BODY_UNITS_PER_METER, BODY_UNITS_PER_METER, BODY_UNITS_PER_METER);
  const parts = [];
  garment.updateMatrixWorld(true);
  garment.traverse(o => { if (o.isMesh) parts.push(o); });
  const skeleton = new THREE.Skeleton(bones);   // bound in the rest pose
  for (const part of parts) {
    const geometry = part.geometry.clone().applyMatrix4(toBody.clone().multiply(part.matrixWorld));
    setSkin(geometry, weightsAt);
    const mesh = new THREE.SkinnedMesh(geometry, part.material);
    mesh.name = part.name;
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false;
    avatar.root.add(mesh);
  }
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
  constructor(root, skeleton) {
    this.root = root;
    this.bones = {};
    for (const [key, re] of Object.entries(BONE_PATTERNS)) {
      this.bones[key] = skeleton.bones.find(b => re.test(b.name)) || null;
      if (!this.bones[key]) console.warn(`Avatar bone not found: ${key}`);
    }

    root.updateMatrixWorld(true);
    this.restLocal = new Map(skeleton.bones.map(b => [b, b.quaternion.clone()]));
    this.restWorld = new Map(skeleton.bones.map(b => [b, b.getWorldQuaternion(new THREE.Quaternion())]));

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
