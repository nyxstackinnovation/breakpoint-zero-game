// First-person hands and forearms, built in weapon space (glTF axes: +Z toward the muzzle, +Y up, origin
// at the pistol grip). Real hand shape: tapered palm, knuckle pad, three-joint fingers wrapped around the
// grip and the handguard, an opposable thumb, glove cuff, and forearms that match the operator's outfit
// (bare skin, rolled sleeve or full sleeve; fingerless or full gloves).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();

function limb(a, b, r1, r2, mat, radial = 12) {
  // tapered capsule from a to b (radius r1 at a, r2 at b)
  const len = _a.copy(b).sub(a).length();
  const geo = new THREE.CylinderGeometry(r2, r1, len, radial, 2, false);
  const cap1 = new THREE.SphereGeometry(r1, radial, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(0, -len / 2, 0);
  const cap2 = new THREE.SphereGeometry(r2, radial, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, len / 2, 0);
  const g = new THREE.Group();
  for (const gg of [geo, cap1, cap2]) g.add(new THREE.Mesh(gg, mat));
  g.position.copy(a).add(b).multiplyScalar(0.5);
  g.quaternion.setFromUnitVectors(UP, _a.copy(b).sub(a).normalize());
  return g;
}

// One hand in its own frame: +Y wrist -> knuckles, +Z back of the hand, lateral X; thumbSide picks the
// side of X the thumb is on. curls: per finger [base, middle, tip] in degrees toward the palm.
function hand({ thumbSide = 1, curls, thumb, mats, fingerless }) {
  const g = new THREE.Group();
  const palmGeo = new RoundedBoxGeometry(0.084, 0.09, 0.03, 3, 0.012);
  const p = palmGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 0.09 + 0.5; // 0 at wrist, 1 at knuckles
    p.setX(i, p.getX(i) * (0.84 + 0.16 * y));
    p.setZ(i, p.getZ(i) * (1.05 - 0.2 * y) + (p.getZ(i) > 0 ? 0.002 * Math.sin(y * Math.PI) : 0));
  }
  palmGeo.computeVertexNormals();
  const palm = new THREE.Mesh(palmGeo, mats.glove);
  palm.position.set(0, 0.048, 0);
  g.add(palm);
  // padded knuckle strip and back-of-hand panel
  const knuckle = new THREE.Mesh(new RoundedBoxGeometry(0.078, 0.022, 0.012, 2, 0.005), mats.pad);
  knuckle.position.set(0, 0.084, 0.017);
  g.add(knuckle);
  const panel = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.04, 0.006, 2, 0.003), mats.pad);
  panel.position.set(0, 0.045, 0.016);
  g.add(panel);
  // fingers: index on the thumb side
  const xs = [0.029, 0.0098, -0.0098, -0.028].map((x) => x * thumbSide);
  const lens = [[0.044, 0.028, 0.022], [0.048, 0.031, 0.023], [0.045, 0.029, 0.022], [0.036, 0.023, 0.019]];
  const rads = [0.0098, 0.0102, 0.0097, 0.0086];
  for (let f = 0; f < 4; f++) {
    let pos = new THREE.Vector3(xs[f], 0.092 - (f === 3 ? 0.006 : 0), -0.002);
    let dir = new THREE.Vector3(f === 0 ? 0.04 * thumbSide : f === 3 ? -0.06 * thumbSide : 0, 1, 0).normalize();
    for (let j = 0; j < 3; j++) {
      dir.applyAxisAngle(new THREE.Vector3(1, 0, 0), -THREE.MathUtils.degToRad(curls[f][j]));
      const end = pos.clone().addScaledVector(dir, lens[f][j]);
      const r = rads[f] * (1 - j * 0.08);
      const mat = fingerless && j > 0 ? mats.skin : mats.glove;
      g.add(limb(pos, end, r, r * 0.95, mat, 10));
      if (j === 0) { // knuckle bump
        const k = new THREE.Mesh(new THREE.SphereGeometry(r * 1.08, 10, 8), mats.glove);
        k.position.copy(pos);
        g.add(k);
      }
      pos = end;
    }
  }
  // thumb: metacarpal + two phalanges
  let tp = new THREE.Vector3(0.03 * thumbSide, 0.018, -0.008);
  let td = new THREE.Vector3(thumb.dir[0] * thumbSide, thumb.dir[1], thumb.dir[2]).normalize();
  const tl = [0.038, 0.032, 0.026];
  for (let j = 0; j < 3; j++) {
    if (j) td.applyAxisAngle(new THREE.Vector3(thumb.axis[0], thumb.axis[1], thumb.axis[2] * thumbSide).normalize(), -THREE.MathUtils.degToRad(thumb.curl[j - 1]));
    const end = tp.clone().addScaledVector(td, tl[j]);
    const r = j === 0 ? 0.0135 : 0.0108 - j * 0.0005;
    g.add(limb(tp, end, r, r * 0.92, fingerless && j === 2 ? mats.skin : mats.glove, 10));
    tp = end;
  }
  // glove cuff with strap
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.034, 0.03, 16), mats.glove);
  cuff.position.set(0, -0.004, 0);
  const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.0375, 0.0375, 0.012, 16), mats.pad);
  strap.position.set(0, -0.006, 0);
  g.add(cuff, strap);
  return g;
}

function place(obj, origin, yAxis, zAxis) {
  const y = yAxis.clone().normalize();
  const z = zAxis.clone().sub(y.clone().multiplyScalar(zAxis.dot(y))).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  obj.position.copy(origin);
  return obj;
}

function forearm(wrist, elbow, mats, fp, team) {
  const g = new THREE.Group();
  const bare = fp.forearm === 'skin';
  // slightly flattened forearm: wider across the wrist bones, thick muscle toward the elbow
  const arm = limb(elbow, wrist, 0.047, 0.031, bare ? mats.skin : mats.sleeve, 16);
  arm.scale.set(1.12, 1, 0.94);
  g.add(arm);
  const dir = _b.copy(wrist).sub(elbow).normalize().clone();
  const ring = (t, r, h, mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.02, h, 18), mat);
    m.position.copy(elbow).lerp(wrist, t);
    m.quaternion.setFromUnitVectors(UP, dir);
    g.add(m);
  };
  if (bare && fp.rolled) ring(0.12, 0.056, 0.06, mats.cuff);         // rolled-up sleeve near the elbow
  if (!bare) ring(0.94, 0.038, 0.03, mats.cuff);                     // sleeve cuff at the wrist
  if (fp.wraps) ring(0.84, 0.038, 0.045, mats.cuff);                 // wrist wraps
  if (team) ring(0.45, bare ? 0.047 : 0.05, 0.032, mats.band);       // team colour band
  return g;
}

// The support point on the handguard / launcher grip bar and the pistol grip, in weapon space.
const LEFT = { wrist: new THREE.Vector3(0.088, 0.03, 0.2), y: new THREE.Vector3(-0.8, 0.32, 0.5), z: new THREE.Vector3(0.38, -0.92, 0), elbow: new THREE.Vector3(0.22, -0.26, -0.02) };
const RIGHT = { wrist: new THREE.Vector3(-0.034, 0.012, -0.07), y: new THREE.Vector3(0.05, -0.3, 0.95), z: new THREE.Vector3(-1, 0, 0), elbow: new THREE.Vector3(-0.11, -0.27, -0.24) };

export function createFPMaterials() {
  return {
    skin: new THREE.MeshStandardMaterial({ color: 0x9a6d5e, roughness: 0.55 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x1d1c1b, roughness: 0.82 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x2c2a27, roughness: 0.7 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x6b7350, roughness: 0.9 }),
    cuff: new THREE.MeshStandardMaterial({ color: 0x2a2826, roughness: 0.85 }),
    band: new THREE.MeshStandardMaterial({ color: 0xff3b5c, roughness: 0.6, emissive: 0xff3b5c, emissiveIntensity: 0.15 }),
  };
}

export function buildFPArms(fp, mats) {
  const g = new THREE.Group();
  const left = hand({
    thumbSide: 1, mats, fingerless: fp.fingerless,
    curls: [[50, 58, 36], [54, 62, 40], [58, 62, 40], [60, 60, 38]],
    thumb: { dir: [0.45, 0.8, -0.3], axis: [0, 0, 1], curl: [8, 14] },
  });
  g.add(place(left, LEFT.wrist, LEFT.y, LEFT.z));
  const right = hand({
    thumbSide: -1, mats, fingerless: fp.fingerless,
    curls: [[12, 18, 12], [74, 82, 50], [76, 84, 50], [78, 82, 48]],
    thumb: { dir: [0.28, 0.88, -0.42], axis: [0, 0, 1], curl: [14, 18] },
  });
  g.add(place(right, RIGHT.wrist, RIGHT.y, RIGHT.z));
  g.add(forearm(LEFT.wrist.clone().addScaledVector(LEFT.y.clone().normalize(), -0.012), LEFT.elbow, mats, fp, true));
  g.add(forearm(RIGHT.wrist.clone().addScaledVector(RIGHT.y.clone().normalize(), -0.012), RIGHT.elbow, mats, fp, false));
  g.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } });
  return g;
}

export function paintFPMaterials(mats, fp, teamColor) {
  mats.skin.color.setHex(fp.skin);
  mats.glove.color.setHex(fp.glove);
  mats.pad.color.setHex(fp.pad ?? 0x2c2a27);
  mats.sleeve.color.setHex(fp.sleeve);
  mats.cuff.color.setHex(fp.cuff);
  if (teamColor) { mats.band.color.copy(teamColor); mats.band.emissive.copy(teamColor); }
}
