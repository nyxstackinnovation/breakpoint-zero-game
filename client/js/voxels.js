// Chunked greedy voxel mesher with baked ambient occlusion, plus the renderer that keeps
// chunk meshes in sync with destruction and draws falling chunks.

import * as THREE from 'three';
import { VOXEL } from '/shared/constants.js';
import { VoxelWorld } from '/shared/voxelWorld.js';

const CS = 16;
const AO_CURVE = [0.42, 0.62, 0.82, 1.0];

// Greedy mesh a box region of the world. Faces are merged only when material and per-corner AO match.
export function meshRegion(world, ox, oy, oz, nx, ny, nz, palette) {
  const sx = world.sx, sy = world.sy, sz = world.sz, data = world.data, layer = sx * sz;
  const get = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) ? 0 : data[x + sx * z + layer * y];
  const pos = [], nor = [], col = [], idx = [];
  let vcount = 0;
  const dims = [nx, ny, nz];
  const origin = [ox, oy, oz];
  const p = [0, 0, 0], q = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const du = dims[u], dv = dims[v];
    const mask = new Uint32Array(du * dv);
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < dims[d]; k++) {
        let any = false;
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; i++) {
            p[d] = origin[d] + k; p[u] = origin[u] + i; p[v] = origin[v] + j;
            const a = get(p[0], p[1], p[2]);
            let m = 0;
            if (a !== 0) {
              q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
              q[d] += s;
              if (get(q[0], q[1], q[2]) === 0) {
                // AO samples in the layer in front of the face
                const c = (ou, ov) => { const r = [q[0], q[1], q[2]]; r[u] += ou; r[v] += ov; return get(r[0], r[1], r[2]) !== 0 ? 1 : 0; };
                const s_m0 = c(-1, 0), s_p0 = c(1, 0), s_0m = c(0, -1), s_0p = c(0, 1);
                const ao = (s1, s2, cn) => (s1 && s2) ? 0 : 3 - (s1 + s2 + cn);
                const a0 = ao(s_m0, s_0m, c(-1, -1));
                const a1 = ao(s_p0, s_0m, c(1, -1));
                const a2 = ao(s_p0, s_0p, c(1, 1));
                const a3 = ao(s_m0, s_0p, c(-1, 1));
                m = a | (a0 << 8) | (a1 << 10) | (a2 << 12) | (a3 << 14);
                any = true;
              }
            }
            mask[i + j * du] = m;
          }
        }
        if (!any) continue;
        // greedy merge
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du;) {
            const m = mask[i + j * du];
            if (!m) { i++; continue; }
            let w = 1;
            while (i + w < du && mask[i + w + j * du] === m) w++;
            let h = 1;
            outer: for (; j + h < dv; h++) {
              for (let t = 0; t < w; t++) if (mask[i + t + (j + h) * du] !== m) break outer;
            }
            const plane = origin[d] + k + (s > 0 ? 1 : 0);
            const c0 = [0, 0, 0], c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0];
            c0[d] = c1[d] = c2[d] = c3[d] = plane;
            c0[u] = origin[u] + i; c0[v] = origin[v] + j;
            c1[u] = origin[u] + i + w; c1[v] = origin[v] + j;
            c2[u] = origin[u] + i + w; c2[v] = origin[v] + j + h;
            c3[u] = origin[u] + i; c3[v] = origin[v] + j + h;
            const mat = m & 255;
            const color = palette[mat] || [1, 0, 1];
            const aos = [(m >> 8) & 3, (m >> 10) & 3, (m >> 12) & 3, (m >> 14) & 3];
            const corners = [c0, c1, c2, c3];
            for (let t = 0; t < 4; t++) {
              const cc = corners[t];
              pos.push(cc[0] * VOXEL, cc[1] * VOXEL, cc[2] * VOXEL);
              const n = [0, 0, 0]; n[d] = s;
              nor.push(n[0], n[1], n[2]);
              const f = AO_CURVE[aos[t]];
              col.push(color[0] * f, color[1] * f, color[2] * f);
            }
            const flip = aos[0] + aos[2] < aos[1] + aos[3];
            const b = vcount;
            if (s > 0) {
              if (flip) idx.push(b + 1, b + 2, b + 3, b + 1, b + 3, b);
              else idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
            } else {
              if (flip) idx.push(b + 1, b + 3, b + 2, b + 1, b, b + 3);
              else idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
            }
            vcount += 4;
            for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) mask[i + ii + (j + jj) * du] = 0;
            i += w;
          }
        }
      }
    }
  }
  if (!vcount) return null;
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    colors: new Float32Array(col),
    indices: vcount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
  };
}

export function buildGeometry(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// Lambert material with world-space per-voxel colour variation and subtle grid lines.
export function createVoxelMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVoxWorld;\nvarying vec3 vVoxNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvVoxWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvVoxNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVoxWorld;\nvarying vec3 vVoxNormal;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 vp = vVoxWorld / ${VOXEL.toFixed(2)};
          vec3 an = abs(vVoxNormal);
          vec3 cell = floor(vp - vVoxNormal * 0.02);
          float n = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          diffuseColor.rgb *= 0.9 + 0.17 * n;
          vec3 f = fract(vp);
          vec3 e = min(f, 1.0 - f);
          float edge = an.x > 0.5 ? min(e.y, e.z) : (an.y > 0.5 ? min(e.x, e.z) : min(e.x, e.y));
          vec3 fw = fwidth(vp);
          float aa = (fw.x + fw.y + fw.z) * 0.6;
          float line = smoothstep(0.0, 0.035 + aa, edge);
          float fade = clamp(aa * 2.5, 0.0, 1.0);
          diffuseColor.rgb *= mix(mix(0.8, 1.0, line), 0.95, fade);
          // fine grain
          float g = fract(sin(dot(floor(vp * 4.0), vec3(7.13, 157.1, 113.7))) * 9341.7);
          diffuseColor.rgb *= 0.97 + 0.05 * g;
        }`);
  };
  return mat;
}

export class VoxelRenderer {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'voxels';
    scene.add(this.group);
    this.material = createVoxelMaterial();
    this.chunks = new Map();
    this.dirty = new Set();
    this.world = null;
    this.palette = [];
    this.falling = new Map();
    this.shadows = true;
  }

  setWorld(world) {
    this.clear();
    this.world = world;
    this.palette = [];
    const c = new THREE.Color();
    for (let i = 0; i < 256; i++) { c.setHex(world.palette[i]); this.palette.push([c.r, c.g, c.b]); }
    this.ncx = Math.ceil(world.sx / CS); this.ncy = Math.ceil(world.sy / CS); this.ncz = Math.ceil(world.sz / CS);
    world.onChange = (x, y, z) => this.markDirty(x, y, z);
  }

  colorOf(v) { return this.palette[v] || [1, 1, 1]; }

  clear() {
    for (const m of this.chunks.values()) { m.geometry.dispose(); this.group.remove(m); }
    for (const f of this.falling.values()) { f.mesh.geometry.dispose(); this.group.remove(f.mesh); }
    this.chunks.clear(); this.falling.clear(); this.dirty.clear();
    if (this.world) this.world.onChange = null;
  }

  key(cx, cy, cz) { return cx + this.ncx * (cz + this.ncz * cy); }

  markDirty(x, y, z) {
    const x0 = Math.max(0, Math.floor((x - 1) / CS)), x1 = Math.min(this.ncx - 1, Math.floor((x + 1) / CS));
    const y0 = Math.max(0, Math.floor((y - 1) / CS)), y1 = Math.min(this.ncy - 1, Math.floor((y + 1) / CS));
    const z0 = Math.max(0, Math.floor((z - 1) / CS)), z1 = Math.min(this.ncz - 1, Math.floor((z + 1) / CS));
    for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) this.dirty.add(this.key(cx, cy, cz));
  }

  buildChunk(k) {
    const cx = k % this.ncx, t = Math.floor(k / this.ncx), cz = t % this.ncz, cy = Math.floor(t / this.ncz);
    const old = this.chunks.get(k);
    if (old) { old.geometry.dispose(); this.group.remove(old); this.chunks.delete(k); }
    const m = meshRegion(this.world, cx * CS, cy * CS, cz * CS, CS, CS, CS, this.palette);
    if (!m) return;
    const mesh = new THREE.Mesh(buildGeometry(m), this.material);
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.chunks.set(k, mesh);
  }

  async buildAll(onProgress) {
    const total = this.ncx * this.ncy * this.ncz;
    let done = 0;
    for (let k = 0; k < total; k++) {
      this.buildChunk(k);
      done++;
      if (done % 24 === 0) {
        if (onProgress) onProgress(done / total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.dirty.clear();
    if (onProgress) onProgress(1);
  }

  setShadows(on) {
    this.shadows = on;
    for (const m of this.chunks.values()) m.castShadow = on;
  }

  update(maxChunks = 10) {
    if (!this.dirty.size) return;
    let n = 0;
    for (const k of this.dirty) {
      this.dirty.delete(k);
      this.buildChunk(k);
      if (++n >= maxChunks) break;
    }
  }

  // Build a standalone mesh for a falling chunk.
  addFalling(cluster) {
    const pad = 1;
    const w = new VoxelWorld(cluster.bw + pad * 2, cluster.bh + pad * 2, cluster.bd + pad * 2);
    for (let k = 0; k < cluster.indices.length; k++) {
      w.data[w.index(cluster.xs[k] - cluster.min[0] + pad, cluster.ys[k] - cluster.min[1] + pad, cluster.zs[k] - cluster.min[2] + pad)] = cluster.colors[k];
    }
    const m = meshRegion(w, 0, 0, 0, w.sx, w.sy, w.sz, this.palette);
    if (!m) return;
    const mesh = new THREE.Mesh(buildGeometry(m), this.material);
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    const ox = (cluster.min[0] - pad) * VOXEL, oy = (cluster.min[1] - pad) * VOXEL, oz = (cluster.min[2] - pad) * VOXEL;
    mesh.position.set(ox, oy, oz);
    this.group.add(mesh);
    this.falling.set(cluster.id, { mesh, cluster, base: [ox, oy, oz], wobble: Math.random() * 6.28 });
  }

  removeFalling(id) {
    const f = this.falling.get(id);
    if (!f) return;
    f.mesh.geometry.dispose();
    this.group.remove(f.mesh);
    this.falling.delete(id);
  }

  updateFalling() {
    for (const f of this.falling.values()) {
      const c = f.cluster;
      f.mesh.position.y = f.base[1] - c.offset;
      // slight shudder while the chunk is moving
      const shake = c.landed ? 0 : Math.min(0.03, c.vel * 0.002);
      f.mesh.position.x = f.base[0] + Math.sin(performance.now() * 0.05 + f.wobble) * shake;
      f.mesh.position.z = f.base[2] + Math.cos(performance.now() * 0.043 + f.wobble) * shake;
    }
  }

  stats() {
    let tris = 0;
    for (const m of this.chunks.values()) tris += m.geometry.index.count / 3;
    return { chunks: this.chunks.size, tris };
  }
}
