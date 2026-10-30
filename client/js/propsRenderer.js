// Map set dressing: instanced Blender-made props (props.glb) with procedural fallbacks.
// A prop breaks into debris when one of its voxels or the ground under it is destroyed,
// or when an explosion goes off next to it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { VOXEL } from '/shared/constants.js';
import { PROP_DEFS, propCells, propIndices } from '/shared/props.js';

const FALLBACK_COLORS = {
  metal: 0x5d6168, wood: 0x9a6b43, concrete: 0xb9b4aa, fabric: 0xb8a47a,
};

function fallbackGeometry(type) {
  const parts = [];
  const add = (g, color, x = 0, y = 0, z = 0) => {
    g.translate(x, y, z);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const C = (r1, r2, h, s = 12) => new THREE.CylinderGeometry(r1, r2, h, s);
  switch (type) {
    case 'StreetLamp': add(C(0.06, 0.08, 4.2, 8), 0x2e3135, 0, 2.1); add(B(0.25, 0.1, 0.5), 0x2e3135, 0, 4.2, 0.4); add(B(0.2, 0.02, 0.4), 0xfff1c4, 0, 4.14, 0.4); break;
    case 'Bench': add(B(1.6, 0.05, 0.42), 0x9a6b43, 0, 0.45); add(B(1.6, 0.25, 0.04), 0x9a6b43, 0, 0.65, -0.2); add(B(0.06, 0.45, 0.4), 0x2e3135, -0.65, 0.22); add(B(0.06, 0.45, 0.4), 0x2e3135, 0.65, 0.22); break;
    case 'TrashBin': add(C(0.25, 0.22, 0.88, 14), 0x2f5a3c, 0, 0.44); break;
    case 'TrafficCone': add(C(0.035, 0.17, 0.7, 12), 0xff6a1a, 0, 0.35); add(B(0.4, 0.04, 0.4), 0xff6a1a, 0, 0.02); break;
    case 'Barrier': add(B(2, 0.8, 0.3), 0xb9b4aa, 0, 0.4); add(B(2, 0.2, 0.6), 0xb9b4aa, 0, 0.1); break;
    case 'Hydrant': add(C(0.11, 0.12, 0.65, 12), 0xc4231d, 0, 0.33); break;
    case 'Planter': add(B(0.9, 0.55, 0.9), 0x8f8a80, 0, 0.275); add(new THREE.IcosahedronGeometry(0.45, 1), 0x3f8f3a, 0, 0.85); break;
    case 'ACUnit': add(B(1, 0.8, 0.6), 0xeeeeee, 0, 0.4); break;
    case 'WaterTank': add(C(0.9, 0.9, 1.6, 16), 0x6e4a2c, 0, 2.3); add(C(0.05, 0.95, 0.5, 16), 0x2e3135, 0, 3.35); add(B(1.7, 1.5, 1.7), 0x2e3135, 0, 0.75); break;
    case 'SatDish': add(C(0.04, 0.04, 1.3, 6), 0x2e3135, 0, 0.65); add(C(0.5, 0.1, 0.15, 14), 0xeeeeee, 0, 1.45); break;
    case 'OilDrum': add(C(0.29, 0.29, 0.88, 14), 0x2f5f9f, 0, 0.44); break;
    case 'Sandbags': add(B(1.6, 0.45, 0.3), 0xb8a47a, 0, 0.225); break;
    case 'Pallet': add(B(1.2, 0.14, 1.0), 0x9a6b43, 0, 0.07); break;
    case 'Crate': add(B(1, 1, 1), 0x9a6b43, 0, 0.5); break;
    case 'CafeSet': add(C(0.42, 0.42, 0.03, 16), 0xeeeeee, 0, 0.74); add(C(0.03, 0.03, 0.72, 6), 0x2e3135, 0, 0.37); add(C(1.25, 0.02, 0.4, 8), 0xff6f91, 0, 2.15); add(C(0.02, 0.02, 2.2, 6), 0xeeeeee, 0, 1.1); break;
    case 'Bollard': add(C(0.1, 0.1, 0.9, 10), 0x2e3135, 0, 0.45); break;
    case 'RoadSign': add(C(0.035, 0.035, 2.6, 6), 0x5d6168, 0, 1.3); add(C(0.32, 0.32, 0.02, 8).rotateX(Math.PI / 2), 0xc4231d, 0, 2.35, 0.04); break;
    case 'Antenna': add(C(0.02, 0.03, 3, 6), 0x5d6168, 0, 1.5); break;
    case 'Vent': add(C(0.18, 0.18, 0.9, 12), 0x5d6168, 0, 0.45); add(C(0.2, 0.28, 0.18, 12), 0x5d6168, 0, 0.98); break;
    case 'Mooring': add(C(0.18, 0.16, 0.5, 12), 0x2e3135, 0, 0.25); add(C(0.22, 0.22, 0.08, 12), 0x2e3135, 0, 0.52); break;
    case 'NewsBox': add(B(0.45, 0.9, 0.4), 0xf2c230, 0, 0.55); break;
    case 'TireStack': add(C(0.32, 0.32, 0.66, 14), 0x1a1a1a, 0, 0.33); break;
    default: add(B(0.5, 0.5, 0.5), 0x888888, 0, 0.25);
  }
  return mergeGeometries(parts, false);
}

export class PropRenderer {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'props';
    scene.add(this.group);
    this.templates = new Map(); // type -> { geometry, material(s) }
    this.meshes = new Map();
    this.props = [];
    this.cellToProp = new Map();
    this.loaded = this.loadModels();
    this.fallbackMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.shadows = true;
  }

  async loadModels() {
    try {
      const gltf = await new GLTFLoader().loadAsync('/assets/models/props.glb');
      gltf.scene.updateWorldMatrix(true, true);
      gltf.scene.traverse((o) => {
        const name = o.name.replace(/_\d+$/, '');
        if (!PROP_DEFS[name] || this.templates.has(name)) return;
        const geos = [], mats = [];
        o.traverse((c) => {
          if (!c.isMesh) return;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', c.geometry.attributes.position.clone());
          if (c.geometry.attributes.normal) g.setAttribute('normal', c.geometry.attributes.normal.clone());
          if (c.geometry.index) g.setIndex(c.geometry.index.clone());
          g.applyMatrix4(c.matrixWorld);
          if (!g.attributes.normal) g.computeVertexNormals();
          geos.push(g.index ? g.toNonIndexed() : g);
          mats.push(c.material);
        });
        if (!geos.length) return;
        const merged = mergeGeometries(geos, true);
        this.templates.set(name, { geometry: merged, material: mats.length === 1 ? mats[0] : mats });
      });
      this.fromBlender = this.templates.size > 0;
    } catch {
      this.fromBlender = false;
    }
  }

  clear() {
    for (const m of this.meshes.values()) { this.group.remove(m); m.dispose?.(); }
    this.meshes.clear();
    this.props = [];
    this.cellToProp.clear();
  }

  template(type) {
    if (!this.templates.has(type)) this.templates.set(type, { geometry: fallbackGeometry(type), material: this.fallbackMat });
    return this.templates.get(type);
  }

  async build(world, list) {
    await this.loaded;
    this.clear();
    this.world = world;
    const byType = new Map();
    this.byId = new Map();
    list.forEach((p, i) => {
      const id = p.id ?? i;
      if (p.dead) return;
      const cells = propCells(p.t, p.r);
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (const [dx, , dz] of cells) { minx = Math.min(minx, dx); maxx = Math.max(maxx, dx); minz = Math.min(minz, dz); maxz = Math.max(maxz, dz); }
      const idx = propIndices(world, p);
      const pos = new THREE.Vector3((p.x + (minx + maxx + 1) / 2) * VOXEL, p.y * VOXEL, (p.z + (minz + maxz + 1) / 2) * VOXEL);
      const rec = { ...p, id, pos, alive: true, slot: 0, cells: idx.cells };
      for (const c of idx.cells) this.cellToProp.set(c, rec);
      for (const c of idx.ground) this.cellToProp.set(c, rec);
      this.props.push(rec);
      this.byId.set(id, rec);
      if (!byType.has(p.t)) byType.set(p.t, []);
      byType.get(p.t).push(rec);
    });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    for (const [type, recs] of byType) {
      const t = this.template(type);
      const mesh = new THREE.InstancedMesh(t.geometry, t.material, recs.length);
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = true;
      recs.forEach((r, k) => {
        r.slot = k;
        r.mesh = mesh;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (r.r || 0) * Math.PI / 2);
        m4.compose(r.pos, q, one);
        mesh.setMatrixAt(k, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.meshes.set(type, mesh);
    }
  }

  setShadows(on) {
    this.shadows = on;
    for (const m of this.meshes.values()) m.castShadow = on;
  }

  // world.onChange hook: voxel (x,y,z) changed
  voxelChanged(x, y, z) {
    if (!this.world || !this.cellToProp.size) return null;
    const i = this.world.index(x, y, z);
    const rec = this.cellToProp.get(i);
    if (!rec || !rec.alive || this.world.data[i] !== 0) return null;
    return this.breakProp(rec);
  }

  breakProp(rec) {
    rec.alive = false;
    const m4 = new THREE.Matrix4().makeScale(0, 0, 0);
    rec.mesh.setMatrixAt(rec.slot, m4);
    rec.mesh.instanceMatrix.needsUpdate = true;
    if (this.onBreak) this.onBreak(rec);
    return rec;
  }

  // authoritative break from the server: hide it and clear its invisible collision voxels
  breakById(id) {
    const rec = this.byId?.get(id);
    if (!rec) return null;
    if (this.world) for (const i of rec.cells) if (this.world.ghost[this.world.data[i]]) this.world.setIndex(i, 0);
    if (rec.alive) return this.breakProp(rec);
    return rec;
  }

  explode(p, radius) {
    for (const rec of this.props) {
      if (!rec.alive) continue;
      const dx = rec.pos.x - p.x, dz = rec.pos.z - p.z, dy = rec.pos.y + 0.5 - p.y;
      if (dx * dx + dy * dy + dz * dz < radius * radius) this.breakProp(rec);
    }
  }

  colorFor(rec) {
    const c = new THREE.Color(FALLBACK_COLORS[PROP_DEFS[rec.t]?.mat] ?? 0x888888);
    return [c.r, c.g, c.b];
  }
}
