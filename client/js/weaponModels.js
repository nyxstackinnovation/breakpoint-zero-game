// Detailed procedural weapon models: an assault rifle and a shoulder-fired rocket launcher.
// Barrels point down -Z. The origin of the rifle sits at the pistol grip.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

let MATS = null;
export function weaponMaterials() {
  if (MATS) return MATS;
  MATS = {
    metal: new THREE.MeshStandardMaterial({ color: 0x3a3e46, metalness: 0.45, roughness: 0.42 }),
    metalDark: new THREE.MeshStandardMaterial({ color: 0x24272c, metalness: 0.4, roughness: 0.5 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x35383f, metalness: 0.05, roughness: 0.7 }),
    tan: new THREE.MeshStandardMaterial({ color: 0xa88c5e, metalness: 0.05, roughness: 0.8 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x4d5836, metalness: 0.15, roughness: 0.7 }),
    oliveDark: new THREE.MeshStandardMaterial({ color: 0x363e26, metalness: 0.15, roughness: 0.8 }),
    red: new THREE.MeshStandardMaterial({ color: 0xb02020, metalness: 0.2, roughness: 0.6 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.9, roughness: 0.3 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x6fb4d8, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.35 }),
    reticle: new THREE.MeshBasicMaterial({ map: reticleTexture(), transparent: true, depthWrite: false, toneMapped: false }),
    emissive: new THREE.MeshBasicMaterial({ color: 0xff3020, toneMapped: false }),
  };
  return MATS;
}

function reticleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,40,30,0.95)';
  g.lineWidth = 3;
  g.beginPath(); g.arc(32, 32, 20, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,60,40,1)';
  g.beginPath(); g.arc(32, 32, 3.5, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0, rounded = 0) {
  const g = rounded > 0 ? new RoundedBoxGeometry(w, h, d, 2, rounded) : new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}
function cyl(r1, r2, len, x, y, z, seg = 12, axis = 'z') {
  const g = new THREE.CylinderGeometry(r1, r2, len, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function assemble(parts, detailed) {
  // parts: { matName: [geometries] } -> group with one merged mesh per material
  const group = new THREE.Group();
  const M = weaponMaterials();
  for (const [name, geos] of Object.entries(parts)) {
    if (!geos.length) continue;
    const norm = geos.map((g) => { const n = g.index ? g.toNonIndexed() : g; if (n.attributes.uv) n.deleteAttribute('uv'); return n; });
    const merged = mergeGeometries(norm, false);
    merged.computeVertexNormals && name === 'none' && merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, M[name]);
    mesh.castShadow = !detailed;
    mesh.name = name;
    group.add(mesh);
  }
  return group;
}

export function buildRifle({ detailed = true, noMag = false } = {}) {
  const P = { metal: [], metalDark: [], polymer: [], tan: [], brass: [] };
  const magParts = noMag ? { tan: [], metalDark: [] } : P;
  // receivers
  P.metal.push(box(0.052, 0.062, 0.24, 0, 0.0, -0.04, 0, 0, 0, detailed ? 0.006 : 0));
  P.metal.push(box(0.056, 0.05, 0.27, 0, 0.056, -0.05, 0, 0, 0, detailed ? 0.006 : 0));
  // top rail
  P.metalDark.push(box(0.03, 0.012, 0.32, 0, 0.087, -0.06));
  if (detailed) for (let i = 0; i < 16; i++) P.metalDark.push(box(0.036, 0.006, 0.008, 0, 0.096, 0.09 - i * 0.02));
  // handguard
  P.tan.push(box(0.064, 0.068, 0.3, 0, 0.042, -0.32, 0, 0, 0, detailed ? 0.01 : 0));
  if (detailed) {
    for (let i = 0; i < 6; i++) {
      P.metalDark.push(box(0.066, 0.012, 0.03, 0, 0.042, -0.21 - i * 0.045));
    }
    P.metalDark.push(box(0.012, 0.012, 0.28, 0, -0.0, -0.32)); // bottom rail
  }
  // barrel, gas block, front sight, muzzle
  P.metal.push(cyl(0.011, 0.011, 0.24, 0, 0.045, -0.58, detailed ? 12 : 6));
  P.metalDark.push(box(0.026, 0.03, 0.03, 0, 0.05, -0.49));
  P.metalDark.push(box(0.008, 0.05, 0.012, 0, 0.09, -0.49));
  P.metalDark.push(cyl(0.018, 0.018, 0.065, 0, 0.045, -0.72, detailed ? 12 : 6));
  if (detailed) for (let i = 0; i < 3; i++) P.metal.push(box(0.04, 0.006, 0.008, 0, 0.045, -0.7 - i * 0.018));
  // magazine (curved)
  for (let i = 0; i < 5; i++) {
    const a = 0.08 + i * 0.07;
    magParts.tan.push(box(0.03, 0.05, 0.075, 0, -0.06 - i * 0.042, -0.1 - i * 0.012, a, 0, 0));
  }
  magParts.metalDark.push(box(0.034, 0.012, 0.085, 0, -0.27, -0.165, 0.38, 0, 0));
  P.metal.push(box(0.044, 0.03, 0.09, 0, -0.035, -0.1));
  // pistol grip + trigger
  P.polymer.push(box(0.036, 0.11, 0.046, 0, -0.07, 0.05, 0.32, 0, 0, detailed ? 0.008 : 0));
  P.metalDark.push(box(0.006, 0.006, 0.07, 0, -0.045, -0.02));
  P.metalDark.push(box(0.006, 0.03, 0.006, 0, -0.03, -0.055));
  P.metal.push(box(0.004, 0.022, 0.006, 0, -0.03, -0.015, -0.3, 0, 0));
  // stock
  P.metalDark.push(cyl(0.017, 0.017, 0.16, 0, 0.03, 0.17, detailed ? 12 : 6));
  P.tan.push(box(0.046, 0.085, 0.17, 0, 0.012, 0.29, 0, 0, 0, detailed ? 0.012 : 0));
  P.polymer.push(box(0.048, 0.1, 0.022, 0, 0.0, 0.385));
  // charging handle + ejection port + forward assist
  P.metalDark.push(box(0.05, 0.012, 0.02, 0, 0.08, 0.075));
  if (detailed) {
    P.metalDark.push(box(0.004, 0.022, 0.06, 0.029, 0.05, -0.04));
    P.brass.push(box(0.003, 0.012, 0.03, 0.031, 0.05, -0.04));
    P.metal.push(cyl(0.008, 0.008, 0.02, 0.03, 0.06, 0.03, 8, 'x'));
  }
  const g = assemble(P, detailed);
  // holographic sight
  if (detailed) {
    const M = weaponMaterials();
    const sight = new THREE.Group();
    const S = { metalDark: [box(0.04, 0.012, 0.075, 0, 0.1, -0.02), box(0.006, 0.05, 0.06, 0.02, 0.13, -0.025), box(0.006, 0.05, 0.06, -0.02, 0.13, -0.025), box(0.046, 0.008, 0.06, 0, 0.157, -0.025)], metal: [box(0.03, 0.02, 0.03, 0, 0.115, 0.02)] };
    const sm = assemble(S, true);
    sight.add(sm);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.036), M.glass);
    glass.position.set(0, 0.132, -0.05);
    sight.add(glass);
    const ret = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.03), M.reticle);
    ret.position.set(0, 0.132, -0.051);
    ret.renderOrder = 5;
    sight.add(ret);
    g.add(sight);
  } else {
    const S = { metalDark: [box(0.04, 0.05, 0.07, 0, 0.12, -0.02)] };
    g.add(assemble(S, false));
  }
  g.userData.muzzle = new THREE.Vector3(0, 0.045, -0.77);
  g.userData.eject = new THREE.Vector3(0.035, 0.05, -0.04);
  g.userData.grip = new THREE.Vector3(0, -0.06, 0.055);
  g.userData.fore = new THREE.Vector3(0, -0.01, -0.33);
  return g;
}

export function buildMagazine() {
  const P = { tan: [], metalDark: [] };
  for (let i = 0; i < 5; i++) {
    const a = 0.08 + i * 0.07;
    P.tan.push(box(0.03, 0.05, 0.075, 0, -0.025 - i * 0.042, -i * 0.012, a, 0, 0));
  }
  P.metalDark.push(box(0.034, 0.012, 0.085, 0, -0.235, -0.065, 0.38, 0, 0));
  return assemble(P, true);
}

export function buildLauncher({ detailed = true } = {}) {
  const P = { olive: [], oliveDark: [], metalDark: [], red: [], polymer: [], glass: [] };
  const seg = detailed ? 18 : 8;
  P.olive.push(cyl(0.062, 0.062, 0.95, 0, 0, -0.2, seg));
  P.oliveDark.push(cyl(0.074, 0.074, 0.07, 0, 0, -0.66, seg));
  P.oliveDark.push(cyl(0.07, 0.085, 0.12, 0, 0, 0.32, seg));
  P.oliveDark.push(cyl(0.068, 0.068, 0.04, 0, 0, 0.0, seg));
  if (detailed) for (let i = 0; i < 3; i++) P.oliveDark.push(cyl(0.065, 0.065, 0.015, 0, 0, -0.45 + i * 0.3, seg));
  // grips and trigger
  P.polymer.push(box(0.035, 0.12, 0.05, 0, -0.11, 0.05, 0.25, 0, 0, detailed ? 0.008 : 0));
  P.polymer.push(box(0.035, 0.1, 0.045, 0, -0.1, -0.32, -0.1, 0, 0, detailed ? 0.008 : 0));
  P.metalDark.push(box(0.008, 0.035, 0.012, 0, -0.07, 0.0));
  // shoulder pad
  P.polymer.push(box(0.03, 0.08, 0.22, 0.07, -0.02, 0.12, 0, 0, 0, detailed ? 0.01 : 0));
  // optic
  P.metalDark.push(box(0.04, 0.05, 0.16, -0.07, 0.06, -0.12, 0, 0, 0, detailed ? 0.008 : 0));
  P.metalDark.push(box(0.02, 0.04, 0.02, -0.05, 0.035, -0.1));
  if (detailed) P.glass.push(cyl(0.018, 0.018, 0.005, -0.07, 0.065, -0.205, 12));
  // warhead (visible when loaded)
  const g = assemble(P, detailed);
  const W = { oliveDark: [cyl(0.05, 0.05, 0.16, 0, 0, -0.76, seg)], red: [cyl(0.051, 0.051, 0.02, 0, 0, -0.72, seg)], metalDark: [] };
  const cone = new THREE.ConeGeometry(0.05, 0.2, seg);
  cone.rotateX(-Math.PI / 2);
  cone.translate(0, 0, -0.94);
  W.oliveDark.push(cone);
  const warhead = assemble(W, detailed);
  warhead.name = 'warhead';
  g.add(warhead);
  g.userData.warhead = warhead;
  g.userData.muzzle = new THREE.Vector3(0, 0, -0.72);
  g.userData.rear = new THREE.Vector3(0, 0, 0.4);
  return g;
}

// Projectile model used for rockets in flight.
export function buildRocketProjectile() {
  const W = { oliveDark: [cyl(0.045, 0.045, 0.32, 0, 0, 0, 10)], red: [cyl(0.046, 0.046, 0.02, 0, 0, -0.08, 10)], metalDark: [] };
  const cone = new THREE.ConeGeometry(0.045, 0.16, 10);
  cone.rotateX(-Math.PI / 2);
  cone.translate(0, 0, -0.24);
  W.oliveDark.push(cone);
  for (let i = 0; i < 4; i++) {
    const f = box(0.004, 0.07, 0.08, 0, 0, 0.14);
    f.translate(0, 0.045, 0);
    f.rotateZ((i * Math.PI) / 2);
    W.metalDark.push(f);
  }
  return assemble(W, true);
}
