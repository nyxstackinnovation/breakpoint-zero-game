// Voxel grid with raycasting, deterministic carving, structural-integrity analysis
// and falling-chunk simulation. Used by the authoritative server and mirrored on clients.

import { VOXEL, WORLD_X, WORLD_Y, WORLD_Z, CRUSH, PLAYER } from './constants.js';
import { hash3 } from './util.js';

export const AIR = 0;

export class VoxelWorld {
  constructor(sx = WORLD_X, sy = WORLD_Y, sz = WORLD_Z) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.layer = sx * sz;
    this.size = sx * sy * sz;
    this.data = new Uint8Array(this.size);
    this.palette = new Uint32Array(256);   // 0xRRGGBB per material index
    this.hard = new Uint8Array(256);        // 1 = indestructible material
    this.material = new Uint8Array(256);    // surface material (shared/materials.js)
    this.ghost = new Uint8Array(256);       // 1 = invisible collision voxel (used under props)
    this.mark = null;                       // lazily allocated search buffer
    this.searchId = 0;
    this.onChange = null;                   // (x, y, z) => void, used by client mesher
    this.revision = 0;
  }

  index(x, y, z) { return x + this.sx * (z + this.sz * y); }
  inBounds(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz; }

  coords(i, out = [0, 0, 0]) {
    out[0] = i % this.sx;
    const t = (i / this.sx) | 0;
    out[2] = t % this.sz;
    out[1] = (t / this.sz) | 0;
    return out;
  }

  get(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return AIR;
    return this.data[x + this.sx * (z + this.sz * y)];
  }

  // Physics query: the floor below the world and the map edges are solid.
  solidAt(x, y, z) {
    if (y < 0) return true;
    if (y >= this.sy) return false;
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return true;
    return this.data[x + this.sx * (z + this.sz * y)] !== AIR;
  }

  set(x, y, z, v) {
    if (!this.inBounds(x, y, z)) return;
    const i = x + this.sx * (z + this.sz * y);
    if (this.data[i] === v) return;
    this.data[i] = v;
    if (this.onChange) this.onChange(x, y, z);
  }

  setIndex(i, v) {
    if (this.data[i] === v) return;
    this.data[i] = v;
    if (this.onChange) {
      const x = i % this.sx, t = (i / this.sx) | 0;
      this.onChange(x, (t / this.sz) | 0, t % this.sz);
    }
  }

  fillBox(x0, y0, z0, x1, y1, z1, v) {
    const ax = Math.max(0, Math.min(x0, x1)), bx = Math.min(this.sx - 1, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1)), by = Math.min(this.sy - 1, Math.max(y0, y1));
    const az = Math.max(0, Math.min(z0, z1)), bz = Math.min(this.sz - 1, Math.max(z0, z1));
    for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) {
      const base = this.sx * (z + this.sz * y);
      for (let x = ax; x <= bx; x++) this.data[base + x] = v;
    }
  }

  // Highest solid voxel in a column, or -1.
  topSolid(x, z) {
    for (let y = this.sy - 1; y >= 0; y--) if (this.get(x, y, z) !== AIR) return y;
    return -1;
  }

  // A cell where a player can stand: solid below, 4 free cells above.
  standable(x, y, z) {
    if (y < 1 || y + 3 >= this.sy) return false;
    if (!this.inBounds(x, y, z)) return false;
    if (this.data[this.index(x, y - 1, z)] === AIR) return false;
    for (let k = 0; k < 4; k++) if (this.data[this.index(x, y + k, z)] !== AIR) return false;
    return true;
  }

  // Amanatides & Woo voxel traversal. Origin/direction in metres, direction normalised.
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    const V = VOXEL;
    const px = ox / V, py = oy / V, pz = oz / V;
    let x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx > 0 ? (x + 1 - px) * tdx : dx < 0 ? (px - x) * tdx : Infinity;
    let tmy = dy > 0 ? (y + 1 - py) * tdy : dy < 0 ? (py - y) * tdy : Infinity;
    let tmz = dz > 0 ? (z + 1 - pz) * tdz : dz < 0 ? (pz - z) * tdz : Infinity;
    const maxT = maxDist / V;
    let t = 0, nx = 0, ny = 0, nz = 0;
    for (let iter = 0; iter < 2048; iter++) {
      if (y < 0) return this._hit(x, y, z, nx, ny, nz, t, ox, oy, oz, dx, dy, dz);
      if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return null;
      if (y >= this.sy && dy >= 0) return null;
      if (y < this.sy && this.data[x + this.sx * (z + this.sz * y)] !== AIR) {
        return this._hit(x, y, z, nx, ny, nz, t, ox, oy, oz, dx, dy, dz);
      }
      if (tmx < tmy && tmx < tmz) {
        t = tmx; tmx += tdx; x += stepX; nx = -stepX; ny = 0; nz = 0;
      } else if (tmy < tmz) {
        t = tmy; tmy += tdy; y += stepY; nx = 0; ny = -stepY; nz = 0;
      } else {
        t = tmz; tmz += tdz; z += stepZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxT) return null;
    }
    return null;
  }

  _hit(x, y, z, nx, ny, nz, t, ox, oy, oz, dx, dy, dz) {
    const dist = t * VOXEL;
    return { x, y, z, nx, ny, nz, dist, px: ox + dx * dist, py: oy + dy * dist, pz: oz + dz * dist, v: this.get(x, y, z) };
  }

  // Line of sight between two points (metres).
  clearLine(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    const hit = this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len);
    return !hit || hit.dist >= len - 1e-3;
  }

  // Deterministic spherical carve around voxel (cx, cy, cz) with radius rv voxels.
  // Returns removed voxel indices. Server and clients produce identical results.
  carve(cx, cy, cz, rv, colorsOut = null) {
    const removed = [];
    const r = Math.ceil(rv * 1.15);
    const r2 = rv * rv;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.sy) continue;
      for (let dz = -r; dz <= r; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= this.sz) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= this.sx) continue;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2 * 1.3) continue;
          const n = hash3(x, y, z, 77);
          if (d2 > r2 * (0.72 + 0.55 * n)) continue;
          const i = x + this.sx * (z + this.sz * y);
          const v = this.data[i];
          if (v === AIR || this.hard[v]) continue;
          removed.push(i);
          if (colorsOut) colorsOut.push(v);
        }
      }
    }
    for (const i of removed) this.setIndex(i, AIR);
    if (removed.length) this.revision++;
    return removed;
  }

  // After voxels were removed, find connected components adjacent to the removed cells
  // that are no longer connected to an anchor (bedrock layer or indestructible material).
  findFloatingClusters(removed, maxSearch = CRUSH.maxClusterSearch) {
    if (!this.mark) this.mark = new Uint32Array(this.size);
    const mark = this.mark, data = this.data, hard = this.hard, ghost = this.ghost;
    const sx = this.sx, sz = this.sz, layer = this.layer;
    const callBase = this.searchId + 1;
    const clusters = [];
    const stack = [];
    const tmp = [0, 0, 0];
    const candidates = [];
    for (const i of removed) {
      this.coords(i, tmp);
      const [x, y, z] = tmp;
      if (x > 0) candidates.push(i - 1);
      if (x < sx - 1) candidates.push(i + 1);
      if (z > 0) candidates.push(i - sx);
      if (z < sz - 1) candidates.push(i + sx);
      if (y > 0) candidates.push(i - layer);
      if (y < this.sy - 1) candidates.push(i + layer);
    }
    for (const cand of candidates) {
      if (data[cand] === AIR || ghost[data[cand]]) continue;
      if (mark[cand] >= callBase) continue;
      const sid = ++this.searchId;
      mark[cand] = sid;
      stack.length = 0;
      stack.push(cand);
      const list = [];
      let anchored = false;
      while (stack.length) {
        const i = stack.pop();
        list.push(i);
        const x = i % sx, t = (i / sx) | 0, z = t % sz, y = (t / sz) | 0;
        if (y <= 0 || hard[data[i]]) { anchored = true; break; }
        if (list.length > maxSearch) { anchored = true; break; }
        // push order: up first, down last (popped first) to reach the ground quickly
        let n;
        if (y < this.sy - 1) { n = i + layer; if (data[n] !== AIR && !ghost[data[n]]) { const m = mark[n]; if (m >= callBase && m !== sid) { anchored = true; break; } if (m !== sid) { mark[n] = sid; stack.push(n); } } }
        if (x > 0) { n = i - 1; if (data[n] !== AIR && !ghost[data[n]]) { const m = mark[n]; if (m >= callBase && m !== sid) { anchored = true; break; } if (m !== sid) { mark[n] = sid; stack.push(n); } } }
        if (x < sx - 1) { n = i + 1; if (data[n] !== AIR && !ghost[data[n]]) { const m = mark[n]; if (m >= callBase && m !== sid) { anchored = true; break; } if (m !== sid) { mark[n] = sid; stack.push(n); } } }
        if (z > 0) { n = i - sx; if (data[n] !== AIR && !ghost[data[n]]) { const m = mark[n]; if (m >= callBase && m !== sid) { anchored = true; break; } if (m !== sid) { mark[n] = sid; stack.push(n); } } }
        if (z < sz - 1) { n = i + sx; if (data[n] !== AIR && !ghost[data[n]]) { const m = mark[n]; if (m >= callBase && m !== sid) { anchored = true; break; } if (m !== sid) { mark[n] = sid; stack.push(n); } } }
        n = i - layer; if (data[n] !== AIR && !ghost[data[n]]) { const m = mark[n]; if (m >= callBase && m !== sid) { anchored = true; break; } if (m !== sid) { mark[n] = sid; stack.push(n); } }
      }
      if (!anchored) {
        // drain anything still on the stack (already marked, belongs to the component)
        clusters.push(Int32Array.from(list));
      }
    }
    return clusters;
  }
  // Loose bits left hanging after a blast: a block (or a short strand) with nothing underneath that holds
  // on by a single face, like a brick stuck to the side of a wall. They are attached, so the floating
  // check keeps them, but they look like they hover. Returns them so the caller can crumble them.
  findDangling(x0, y0, z0, x1, y1, z1, passes = 3) {
    const { sx, sy, sz, layer, data, ghost, hard } = this;
    x0 = Math.max(1, x0); y0 = Math.max(1, y0); z0 = Math.max(1, z0);
    x1 = Math.min(sx - 2, x1); y1 = Math.min(sy - 2, y1); z1 = Math.min(sz - 2, z1);
    const solid = (i) => { const v = data[i]; return v !== AIR && !ghost[v]; };
    const out = [];
    const gone = new Set();
    const isSolid = (i) => solid(i) && !gone.has(i);
    for (let pass = 0; pass < passes; pass++) {
      let found = 0;
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const i = x + z * sx + y * layer;
        if (!isSolid(i) || hard[data[i]]) continue;
        if (isSolid(i - layer)) continue;                       // resting on something
        let n = 0;
        if (isSolid(i + layer)) n++;
        if (isSolid(i - 1)) n++;
        if (isSolid(i + 1)) n++;
        if (isSolid(i - sx)) n++;
        if (isSolid(i + sx)) n++;
        if (n <= 1) { gone.add(i); out.push(i); found++; }
      }
      if (!found) break;
    }
    return out;
  }

  // Buildings that still touch the ground, but too little of it to carry their weight: shoot away the
  // ground-floor walls and a building is left standing on its stairs and one thin column, or hanging off
  // a sky bridge. Each building registered by the map generator (this.structures: its box) is judged on
  // its own: every voxel inside the box resting on or against terrain is a support contact, every link
  // leaving the box (bridge, neighbour) counts as one contact. A piece falls when its weight per contact
  // gets well above what the intact building had (baseline ratio from measureStructures()).
  measureStructures() {
    for (const st of this.structures || []) {
      const r = this.structurePieces(st);
      let mass = 0, contacts = 0;
      for (const p of r) { mass += p.list.length; contacts += p.contacts; }
      st.ratio0 = contacts > 0 ? mass / contacts : 0;
    }
  }

  structurePieces(st) {
    const top = this.terrainTop;
    const { sx, sy, sz, layer, data, ghost } = this;
    if (!this.mark) this.mark = new Uint32Array(this.size);
    const mark = this.mark;
    const x0 = Math.max(0, st.x0 - 1), x1 = Math.min(sx - 1, st.x1 + 1);
    const z0 = Math.max(0, st.z0 - 1), z1 = Math.min(sz - 1, st.z1 + 1);
    const y0 = Math.max(1, st.y0), y1 = Math.min(sy - 1, st.y1);
    const sid = ++this.searchId;
    const pieces = [];
    const stack = [];
    const solid = (v) => v !== AIR && !ghost[v];
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const i0 = x + z * sx + y * layer;
      if (!solid(data[i0]) || mark[i0] === sid || y < top[z * sx + x]) continue;
      mark[i0] = sid;
      stack.length = 0;
      stack.push(i0);
      const list = [];
      let contacts = 0, strong = false;
      while (stack.length) {
        const i = stack.pop();
        list.push(i);
        if (this.hard[data[i]]) strong = true;
        const x = i % sx, t = (i / sx) | 0, z = t % sz, y = (t / sz) | 0;
        let touch = 0;
        const nb = [[i - layer, x, y - 1, z, y > 0], [i + layer, x, y + 1, z, y < sy - 1], [i - 1, x - 1, y, z, x > 0], [i + 1, x + 1, y, z, x < sx - 1], [i - sx, x, y, z - 1, z > 0], [i + sx, x, y, z + 1, z < sz - 1]];
        for (const [n, nx, ny, nz, ok] of nb) {
          if (!ok || !solid(data[n])) continue;
          if (ny < top[nz * sx + nx]) { touch = 1; continue; }
          if (nx < x0 || nx > x1 || nz < z0 || nz > z1 || ny < y0 || ny > y1) { touch = 1; continue; } // link out of the box
          if (mark[n] !== sid) { mark[n] = sid; stack.push(n); }
        }
        contacts += touch;
      }
      pieces.push({ list, contacts, strong });
    }
    return pieces;
  }

  findWeakStructures(removed) {
    const out = [];
    if (!this.terrainTop || !this.structures || !removed.length) return out;
    const tmp = [0, 0, 0];
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const i of removed) {
      this.coords(i, tmp);
      bx0 = Math.min(bx0, tmp[0]); bx1 = Math.max(bx1, tmp[0]);
      by0 = Math.min(by0, tmp[1]); by1 = Math.max(by1, tmp[1]);
      bz0 = Math.min(bz0, tmp[2]); bz1 = Math.max(bz1, tmp[2]);
    }
    for (const st of this.structures) {
      if (!st.ratio0) continue;
      if (bx1 < st.x0 - 2 || bx0 > st.x1 + 2 || bz1 < st.z0 - 2 || bz0 > st.z1 + 2 || by1 < st.y0 - 2 || by0 > st.y1 + 2) continue;
      const limit = Math.max(CRUSH.supportRatio, st.ratio0 * CRUSH.supportLoss);
      for (const p of this.structurePieces(st)) {
        if (p.strong || p.list.length < CRUSH.supportMinMass) continue;
        if (p.list.length / Math.max(0.5, p.contacts) <= limit) continue;
        // what is left of the ground floor (stairs, columns, wall stubs) gives way; everything from the
        // first floor up drops onto the rubble
        const cut = st.y0 + (st.fh || 8) - 1;
        const fall = [], crush = [];
        for (const i of p.list) (Math.floor(i / this.layer) < cut ? crush : fall).push(i);
        out.push({ fall: Int32Array.from(fall), crush: Int32Array.from(crush) });
      }
    }
    return out;
  }


  // Remove voxels; returns their material values.
  extract(indices) {
    const colors = new Uint8Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
      colors[k] = this.data[indices[k]];
      this.setIndex(indices[k], AIR);
    }
    this.revision++;
    return colors;
  }

  // Run-length encode the grid: pairs of (value, runLength 1..255).
  encodeRLE() {
    const d = this.data;
    const out = new Uint8Array(Math.max(1024, d.length >> 2));
    let buf = out, o = 0;
    const ensure = (n) => {
      if (o + n > buf.length) {
        const nb = new Uint8Array(buf.length * 2);
        nb.set(buf.subarray(0, o));
        buf = nb;
      }
    };
    let i = 0;
    while (i < d.length) {
      const v = d[i];
      let run = 1;
      while (run < 255 && i + run < d.length && d[i + run] === v) run++;
      ensure(2);
      buf[o++] = v; buf[o++] = run;
      i += run;
    }
    return buf.slice(0, o);
  }

  decodeRLE(bytes) {
    const d = this.data;
    let o = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const v = bytes[i], run = bytes[i + 1];
      d.fill(v, o, o + run);
      o += run;
    }
    this.revision++;
  }
}

// A disconnected chunk of voxels falling as one rigid body under gravity.
// It deals crushing damage to anything it passes through and settles into rubble.
export class FallingCluster {
  constructor(id, world, indices, colors, owner = 0) {
    this.id = id;
    this.owner = owner;
    this.indices = indices;
    this.colors = colors;
    this.offset = 0;   // metres fallen
    this.vel = 0;
    this.drop = 0;     // whole voxels fallen
    this.landed = false;
    this.age = 0;
    const tmp = [0, 0, 0];
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1, maxY = -1, maxZ = -1;
    const n = indices.length;
    this.xs = new Int16Array(n); this.ys = new Int16Array(n); this.zs = new Int16Array(n);
    for (let k = 0; k < n; k++) {
      world.coords(indices[k], tmp);
      this.xs[k] = tmp[0]; this.ys[k] = tmp[1]; this.zs[k] = tmp[2];
      if (tmp[0] < minX) minX = tmp[0]; if (tmp[0] > maxX) maxX = tmp[0];
      if (tmp[1] < minY) minY = tmp[1]; if (tmp[1] > maxY) maxY = tmp[1];
      if (tmp[2] < minZ) minZ = tmp[2]; if (tmp[2] > maxZ) maxZ = tmp[2];
    }
    this.min = [minX, minY, minZ];
    this.max = [maxX, maxY, maxZ];
    this.bw = maxX - minX + 1; this.bh = maxY - minY + 1; this.bd = maxZ - minZ + 1;
    this.bitmap = new Uint8Array(this.bw * this.bh * this.bd);
    for (let k = 0; k < n; k++) {
      this.bitmap[this._bi(this.xs[k], this.ys[k], this.zs[k])] = 1;
    }
    const bottoms = [];
    for (let k = 0; k < n; k++) {
      const x = this.xs[k], y = this.ys[k], z = this.zs[k];
      if (y === minY || !this.bitmap[this._bi(x, y - 1, z)]) bottoms.push(k);
    }
    this.bottoms = Int32Array.from(bottoms);
    this.lastHit = new Map(); // playerId -> age of last crush hit
  }

  _bi(x, y, z) {
    return (x - this.min[0]) + this.bw * ((z - this.min[2]) + this.bd * (y - this.min[1]));
  }

  contains(x, y, z) {
    if (x < this.min[0] || x > this.max[0] || y < this.min[1] || y > this.max[1] || z < this.min[2] || z > this.max[2]) return false;
    return this.bitmap[this._bi(x, y, z)] === 1;
  }

  collidesAt(world, d) {
    for (let k = 0; k < this.bottoms.length; k++) {
      const b = this.bottoms[k];
      const ny = this.ys[b] - d;
      if (ny < 0) return true;
      if (world.data[world.index(this.xs[b], ny, this.zs[b])] !== AIR) return true;
    }
    return false;
  }

  // Advance the fall; returns true on the step it lands.
  step(world, dt, gravity = PLAYER.gravity) {
    if (this.landed) return false;
    this.age += dt;
    this.vel = Math.min(this.vel + gravity * dt, 40);
    const next = this.offset + this.vel * dt;
    const target = Math.floor(next / VOXEL);
    for (let d = this.drop + 1; d <= target; d++) {
      if (this.collidesAt(world, d)) {
        this.drop = d - 1;
        this.offset = this.drop * VOXEL;
        this.landed = true;
        return true;
      }
    }
    this.drop = target;
    this.offset = next;
    if (this.age > 12) { this.landed = true; return true; }
    return false;
  }

  // Does the moving chunk currently occupy voxel cell (x, y, z)?
  occupies(x, y, z) {
    const d0 = Math.floor(this.offset / VOXEL);
    return this.contains(x, y + d0, z) || this.contains(x, y + d0 + 1, z);
  }

  // Is voxel k destroyed on impact (deterministic on every machine)?
  shatters(k) {
    return hash3(this.xs[k], this.ys[k], this.zs[k], this.id * 7919 + 13) < CRUSH.shatterFraction;
  }

  // Write the surviving voxels into the world at the landed position.
  settle(world, drop = this.drop) {
    this.drop = drop;
    this.offset = drop * VOXEL;
    this.landed = true;
    const placed = [];
    for (let k = 0; k < this.indices.length; k++) {
      if (this.shatters(k) || world.ghost[this.colors[k]]) continue;
      const x = this.xs[k], y = this.ys[k] - drop, z = this.zs[k];
      if (y < 0 || !world.inBounds(x, y, z)) continue;
      const i = world.index(x, y, z);
      if (world.data[i] !== AIR) continue;
      world.setIndex(i, this.colors[k]);
      placed.push(i);
    }
    world.revision++;
    return placed;
  }
}
