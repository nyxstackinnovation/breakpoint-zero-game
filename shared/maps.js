// Procedural, seeded map generators. Every map is built from voxels. The ground (terrain), bedrock and
// the arena boundary wall are indestructible; buildings and everything standing on the ground can be
// blown apart.

import { VoxelWorld, AIR } from './voxelWorld.js';
import { VOXEL, WORLD_X, WORLD_Y, WORLD_Z } from './constants.js';
import { makeRng, hash3 } from './util.js';
import { MAT } from './materials.js';
import { placeProp } from './props.js';

export const GROUND = 4; // first walkable cell above the base terrain

export const MAP_INFO = {
  skyline: { display: 'SKYLINE', blurb: 'Candy-coloured rooftops, sky bridges and a sunset plaza.' },
  harbor: { display: 'HARBOR', blurb: 'Container stacks, warehouses and a towering dock crane.' },
  downtown: { display: 'DOWNTOWN', blurb: 'Concrete towers, parked cars and an elevated walkway.' },
};

class Palette {
  constructor(world) { this.world = world; this.next = 1; this.cache = new Map(); }
  add(color, hard = false, mat = 'plain') {
    const m = MAT[mat] ?? 0;
    const key = `${color}:${hard ? 1 : 0}:${m}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.next > 254) return 1;
    const idx = this.next++;
    this.world.palette[idx] = color;
    this.world.hard[idx] = hard ? 1 : 0;
    this.world.material[idx] = m;
    this.cache.set(key, idx);
    return idx;
  }
  // indestructible twin of a palette entry (same colour and surface): used for the ground
  solid(idx) {
    if (this.world.hard[idx]) return idx;
    const key = `solid:${idx}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.next > 254) return idx;
    const s = this.next++;
    this.world.palette[s] = this.world.palette[idx];
    this.world.material[s] = this.world.material[idx];
    this.world.hard[s] = 1;
    this.cache.set(key, s);
    return s;
  }
  ghost(mat) {
    const key = `ghost:${mat}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const idx = this.add(0x808080, false, mat);
    this.world.ghost[idx] = 1;
    this.cache.set(key, idx);
    return idx;
  }
}

// first free cell at or above y0 with solid ground below
function floorAt(w, x, z, y0) {
  for (let y = Math.max(1, y0); y < w.sy - 2; y++) if (w.get(x, y, z) === 0 && w.get(x, y - 1, z) !== 0) return y;
  return -1;
}

function scatter(w, pal, rng, props, type, count, sample, tries = 40) {
  let placed = 0;
  for (let i = 0; i < count * tries && placed < count; i++) {
    const s = sample();
    if (!s) continue;
    const [x, z, y0, rot] = s;
    const y = floorAt(w, x, z, y0);
    if (y < 0 || (s[4] !== undefined && y !== s[4])) continue;
    if (placeProp(w, props, (m) => pal.ghost(m), type, x, y, z, rot ?? rng.int(0, 3))) placed++;
  }
  return placed;
}

function roofDressing(w, pal, rng, props, b) {
  const y = b.top + 1;
  const inside = () => [rng.int(b.x0 + 2, b.x1 - 2), rng.int(b.z0 + 2, b.z1 - 2), y, rng.int(0, 3), y];
  scatter(w, pal, rng, props, 'ACUnit', rng.int(1, 3), inside);
  scatter(w, pal, rng, props, 'Vent', rng.int(1, 2), inside);
  if (rng.chance(0.6)) scatter(w, pal, rng, props, 'Antenna', 1, inside);
  if (rng.chance(0.5)) scatter(w, pal, rng, props, 'SatDish', 1, inside);
  if (rng.chance(0.35) && b.x1 - b.x0 > 14) scatter(w, pal, rng, props, 'WaterTank', 1, inside);
}

function shade(color, f) {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((color & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------- primitives

function setV(w, x, y, z, v) {
  if (x < 0 || y < 0 || z < 0 || x >= w.sx || y >= w.sy || z >= w.sz) return;
  w.data[w.index(x, y, z)] = v;
}

function baseTerrain(w, pal, topFn, hardBase = true) {
  const bedrock = pal.add(0x2a2730, hardBase, 'rock');
  w.fillBox(0, 0, 0, w.sx - 1, 0, w.sz - 1, bedrock);
  w.terrainTop = new Uint8Array(w.sx * w.sz);
  for (let z = 0; z < w.sz; z++) for (let x = 0; x < w.sx; x++) {
    const { h, color, sub } = topFn(x, z);
    w.terrainTop[z * w.sx + x] = Math.max(1, h);
    // the ground never breaks: rockets blow up buildings and everything on top, but leave no craters
    const top = pal.solid(color), fill = pal.solid(sub);
    for (let y = 1; y < h; y++) setV(w, x, y, z, y === h - 1 ? top : fill);
  }
}

function perimeter(w, pal, color, height) {
  const c = pal.add(color, true, 'concrete');
  const c2 = pal.add(shade(color, 1.25), true, 'concrete');
  for (let y = 1; y < height; y++) {
    const col = y % 4 === 0 ? c2 : c;
    for (let i = 0; i < w.sx; i++) { setV(w, i, y, 0, col); setV(w, i, y, w.sz - 1, col); }
    for (let i = 0; i < w.sz; i++) { setV(w, 0, y, i, col); setV(w, w.sx - 1, y, i, col); }
  }
}

function building(w, pal, rng, o) {
  const W = o.w, D = o.d, floors = o.floors, FH = o.floorHeight ?? 8;
  const x0 = o.x, z0 = o.z, x1 = x0 + W - 1, z1 = z0 + D - 1;
  const base = o.base ?? GROUND - 1;
  const top = base + floors * FH;
  const wm = o.wallMat ?? 'plaster';
  const wall = pal.add(o.wall, false, wm);
  const wallAlt = pal.add(shade(o.wall, 0.94), false, wm);
  const trim = pal.add(o.trim, false, o.trimMat ?? 'concrete');
  const floorC = pal.add(o.floor ?? 0x9a9184, false, 'floor');
  const roofC = pal.add(o.roof ?? shade(o.wall, 0.75), false, o.roofMat ?? 'concrete');
  const stairC = pal.add(o.stair ?? 0x8c8378, false, 'concrete');
  // walls
  for (let y = base + 1; y <= top; y++) {
    const band = (y - base) % FH === 0;
    const col = band ? trim : ((y >> 1) % 2 === 0 ? wall : wallAlt);
    for (let x = x0; x <= x1; x++) { setV(w, x, y, z0, col); setV(w, x, y, z1, col); }
    for (let z = z0; z <= z1; z++) { setV(w, x0, y, z, col); setV(w, x1, y, z, col); }
  }
  // corner pillars
  for (let y = base + 1; y <= top + 1; y++) {
    setV(w, x0, y, z0, trim); setV(w, x1, y, z0, trim); setV(w, x0, y, z1, trim); setV(w, x1, y, z1, trim);
  }
  // slabs
  for (let k = 1; k <= floors; k++) {
    const y = base + k * FH;
    w.fillBox(x0 + 1, y, z0 + 1, x1 - 1, y, z1 - 1, k === floors ? roofC : floorC);
  }
  // parapet
  if (o.parapet !== false) {
    for (let x = x0; x <= x1; x++) { setV(w, x, top + 1, z0, trim); setV(w, x, top + 1, z1, trim); }
    for (let z = z0; z <= z1; z++) { setV(w, x0, top + 1, z, trim); setV(w, x1, top + 1, z, trim); }
  }
  // interior support columns for big footprints
  if (W >= 18 && D >= 14) {
    const cx = x0 + Math.floor(W / 2), cz = z0 + Math.floor(D / 2) + 2;
    for (let y = base + 1; y < top; y++) { setV(w, cx, y, cz, wallAlt); setV(w, cx + 1, y, cz, wallAlt); }
  }
  // windows
  const winSpacing = o.windowSpacing ?? 4;
  const winW = o.windowWidth ?? 2;
  for (let k = 0; k < floors; k++) {
    const yb = base + k * FH;
    for (let y = yb + 3; y <= yb + 5; y++) {
      for (let x = x0 + 2; x <= x1 - 2 - (winW - 1); x += winSpacing) {
        for (let q = 0; q < winW; q++) { setV(w, x + q, y, z0, AIR); setV(w, x + q, y, z1, AIR); }
      }
      for (let z = z0 + 2; z <= z1 - 2 - (winW - 1); z += winSpacing) {
        for (let q = 0; q < winW; q++) { setV(w, x0, y, z + q, AIR); setV(w, x1, y, z + q, AIR); }
      }
    }
  }
  // doors (ground floor), 3 wide x 5 tall
  const doors = o.doors ?? ['n', 's', 'e', 'w'];
  const doorW = 3;
  for (const side of doors) {
    for (let y = base + 1; y <= base + 5; y++) for (let q = 0; q < doorW; q++) {
      const mx = x0 + Math.floor(W / 2) - 1 + q, mz = z0 + Math.floor(D / 2) - 1 + q;
      if (side === 'n') setV(w, mx, y, z0, AIR);
      if (side === 's') setV(w, mx, y, z1, AIR);
      if (side === 'w') setV(w, x0, y, mz, AIR);
      if (side === 'e') setV(w, x1, y, mz, AIR);
    }
  }
  // stairs, alternating bands so flights never block the opening above the previous one
  if (o.stairs !== false && W >= 11 && D >= 10) {
    for (let k = 0; k < floors; k++) {
      const yf = base + k * FH;
      const zb = k % 2 === 0 ? z0 + 1 : z0 + 5;
      for (let i = 0; i < FH - 1; i++) {
        const sx = x0 + 1 + i;
        for (let y = yf + 1; y <= yf + 1 + i; y++) for (let zz = zb; zz < zb + 3; zz++) setV(w, sx, y, zz, stairC);
      }
      const slabY = yf + FH;
      for (let i = 2; i <= FH - 2; i++) for (let zz = zb; zz < zb + 3; zz++) setV(w, x0 + 1 + i, slabY, zz, AIR);
    }
  }
  // rooftop props
  if (o.roofProps !== false) {
    const propC = pal.add(o.prop ?? 0xcfd2d6, false, 'metal');
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const pw = rng.int(2, 4), pd = rng.int(2, 4);
      const px = rng.int(x0 + 10, Math.max(x0 + 10, x1 - pw - 1));
      const pz = rng.int(z0 + 2, Math.max(z0 + 2, z1 - pd - 1));
      if (px + pw >= x1) continue;
      w.fillBox(px, top + 1, pz, px + pw - 1, top + rng.int(1, 3), pz + pd - 1, propC);
    }
  }
  (w.structures || (w.structures = [])).push({ x0, z0, x1, z1, y0: base + 1, y1: top + 4, fh: FH });
  return { x0, z0, x1, z1, top, base };
}

function cutParapet(w, x, z, y, len, alongX) {
  for (let i = 0; i < len; i++) {
    if (alongX) setV(w, x + i, y, z, AIR); else setV(w, x, y, z + i, AIR);
  }
}

function bridge(w, pal, ax, az, bx, bz, y, width, color, railColor) {
  const c = pal.add(color, false, 'metal'), rc = pal.add(railColor, false, 'metal');
  const alongX = az === bz || Math.abs(bx - ax) >= Math.abs(bz - az);
  if (alongX) {
    const xa = Math.min(ax, bx), xb = Math.max(ax, bx);
    for (let x = xa; x <= xb; x++) {
      for (let q = 0; q < width; q++) setV(w, x, y, az + q, c);
      setV(w, x, y + 1, az - 1, rc); setV(w, x, y + 1, az + width, rc);
      setV(w, x, y, az - 1, rc); setV(w, x, y, az + width, rc);
    }
  } else {
    const za = Math.min(az, bz), zb = Math.max(az, bz);
    for (let z = za; z <= zb; z++) {
      for (let q = 0; q < width; q++) setV(w, ax + q, y, z, c);
      setV(w, ax - 1, y + 1, z, rc); setV(w, ax + width, y + 1, z, rc);
      setV(w, ax - 1, y, z, rc); setV(w, ax + width, y, z, rc);
    }
  }
}

// Trees and parked cars are Blender models now (props.glb); generators queue them while laying out the
// voxel city and placeQueued() puts them down with the rest of the set dressing.
function tree(w, pal, rng, x, z, base = GROUND) {
  (w.propQueue || (w.propQueue = [])).push({ tree: true, x, z, base });
}

function crate(w, pal, x, y, z, s, color) {
  const c = pal.add(color, false, 'wood'), e = pal.add(shade(color, 0.7), false, 'wood');
  for (let dy = 0; dy < s; dy++) for (let dz = 0; dz < s; dz++) for (let dx = 0; dx < s; dx++) {
    const edge = (dx === 0 || dx === s - 1) + (dy === 0 || dy === s - 1) + (dz === 0 || dz === s - 1) >= 2;
    setV(w, x + dx, y + dy, z + dz, edge ? e : c);
  }
}

function container(w, pal, x, y, z, alongX, color, openEnds = true) {
  const L = 12, Wd = 5, Ht = 5;
  const c = pal.add(color, false, 'corrugated'), rib = pal.add(shade(color, 0.85), false, 'corrugated'), frame = pal.add(shade(color, 0.6), false, 'metal');
  const sx = alongX ? L : Wd, sz = alongX ? Wd : L;
  for (let dy = 0; dy < Ht; dy++) for (let dz = 0; dz < sz; dz++) for (let dx = 0; dx < sx; dx++) {
    const shell = dx === 0 || dx === sx - 1 || dz === 0 || dz === sz - 1 || dy === 0 || dy === Ht - 1;
    if (!shell) continue;
    const along = alongX ? dx : dz;
    const isEnd = along === 0 || along === L - 1;
    const across = alongX ? dz : dx;
    if (openEnds && isEnd && dy > 0 && dy < Ht - 1 && across > 0 && across < Wd - 1) continue;
    const corner = (isEnd && (across === 0 || across === Wd - 1)) || ((dy === 0 || dy === Ht - 1) && (across === 0 || across === Wd - 1));
    setV(w, x + dx, y + dy, z + dz, corner ? frame : (along % 2 === 0 ? rib : c));
  }
}

const CAR_BY_COLOR = { 0xd23c3c: 'SedanRed', 0x3c7bd2: 'SedanBlue', 0xf2f2f2: 'SedanWhite', 0xe6e6e6: 'SedanWhite', 0x222222: 'Van', 0xf2c230: 'Taxi', 0x3cae6a: 'Van' };

function car(w, pal, rng, x, z, alongX, color, base = GROUND) {
  // same footprint as the old 9 x 4 voxel car starting at (x, z)
  const type = CAR_BY_COLOR[color] || 'SedanWhite';
  (w.propQueue || (w.propQueue = [])).push({ type, x: alongX ? x + 4 : x + 1, z: alongX ? z + 1 : z + 4, base, r: alongX ? rng.pick([1, 3]) : rng.pick([0, 2]) });
}

function placeQueued(w, pal, rng, props, treeTypes) {
  for (const q of w.propQueue || []) {
    const y = floorAt(w, q.x, q.z, q.base);
    if (y < 0 || y !== q.base) continue;
    placeProp(w, props, (m) => pal.ghost(m), q.tree ? rng.pick(treeTypes) : q.type, q.x, y, q.z, q.r ?? rng.int(0, 3));
  }
  w.propQueue = [];
}

function propAt(w, pal, props, type, x, z, y0, r) {
  const y = floorAt(w, x, z, y0);
  return y >= 0 && y <= y0 + 1 && placeProp(w, props, (m) => pal.ghost(m), type, x, y, z, r);
}

function collectSpawns(w, rng, count, filter) {
  const spawns = [];
  let tries = 0;
  while (spawns.length < count && tries < count * 60) {
    tries++;
    const x = rng.int(4, w.sx - 5), z = rng.int(4, w.sz - 5);
    const ys = [];
    for (let y = 1; y < w.sy - 4; y++) if (w.standable(x, y, z)) ys.push(y);
    if (!ys.length) continue;
    const y = rng.chance(0.65) ? ys[0] : rng.pick(ys);
    // require some room around
    let ok = true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) if (!w.standable(x + dx, y, z + dz)) { ok = false; break; }
    if (!ok) continue;
    if (filter && !filter(x, y, z)) continue;
    if (spawns.some((s) => Math.abs(s[0] - x) + Math.abs(s[2] - z) < 6 && Math.abs(s[1] - y) < 4)) continue;
    spawns.push([x, y, z]);
  }
  return spawns.map(([x, y, z]) => [(x + 0.5) * VOXEL, y * VOXEL + 0.001, (z + 0.5) * VOXEL]);
}

// ---------------------------------------------------------------- maps

function genSkyline(seed) {
  const w = new VoxelWorld(WORLD_X, WORLD_Y, WORLD_Z);
  const pal = new Palette(w);
  const rng = makeRng(seed);
  const tileA = pal.add(0xf4d6e4, false, 'paving'), tileB = pal.add(0xd6eef4, false, 'paving'), street = pal.add(0x6a6d78, false, 'asphalt'), stripe = pal.add(0xffe066, false, 'asphalt'), sub = pal.add(0x8a7f8f, false, 'concrete');
  const blocks = [6, 48, 90];
  const inBlock = (v) => blocks.some((b) => v >= b && v < b + 34);
  baseTerrain(w, pal, (x, z) => {
    const ib = inBlock(x) && inBlock(z);
    let color;
    if (ib) color = ((x >> 2) + (z >> 2)) % 2 === 0 ? tileA : tileB;
    else color = (x % 12 < 5 && !inBlock(x) && (z % 6 === 0)) || (z % 12 < 5 && !inBlock(z) && (x % 6 === 0)) ? stripe : street;
    return { h: GROUND, color, sub };
  });
  perimeter(w, pal, 0xcfc8e0, 14);
  const colors = [0xff6f91, 0x36cfc9, 0xffc75f, 0xa78bfa, 0x7ee081, 0xff9f43, 0x4fc3f7, 0xf06bd6, 0xff5e5e];
  const trims = [0xffffff, 0xfff4e0, 0x2d2a4a];
  const roofs = [];
  for (let bi = 0; bi < 3; bi++) for (let bj = 0; bj < 3; bj++) {
    const bx = blocks[bi], bz = blocks[bj];
    if (bi === 1 && bj === 1) {
      // central plaza with fountain and trees
      const water = pal.add(0x3fa7ff), rim = pal.add(0xfafafa, false, 'concrete'), stone = pal.add(0xe0c9a6, false, 'concrete');
      const cx = bx + 17, cz = bz + 17;
      for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) {
        const d = Math.hypot(dx, dz);
        if (d <= 6.8 && d > 5.6) { setV(w, cx + dx, GROUND, cz + dz, rim); setV(w, cx + dx, GROUND + 1, cz + dz, rim); }
        else if (d <= 5.6) setV(w, cx + dx, GROUND - 1, cz + dz, water);
      }
      for (let y = GROUND; y < GROUND + 6; y++) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) setV(w, cx + dx, y, cz + dz, stone);
      for (let dz = -2; dz <= 3; dz++) for (let dx = -2; dx <= 3; dx++) setV(w, cx + dx, GROUND + 6, cz + dz, water);
      tree(w, pal, rng, bx + 4, bz + 4); tree(w, pal, rng, bx + 29, bz + 4); tree(w, pal, rng, bx + 4, bz + 29); tree(w, pal, rng, bx + 29, bz + 29);
      // low pavilion cover
      building(w, pal, rng, { x: bx + 2, z: bz + 12, w: 6, d: 10, floors: 1, floorHeight: 6, wall: 0xffffff, trim: 0xff6f91, stairs: false, roofProps: false, doors: ['e', 'w'] });
      building(w, pal, rng, { x: bx + 26, z: bz + 12, w: 6, d: 10, floors: 1, floorHeight: 6, wall: 0xffffff, trim: 0x36cfc9, stairs: false, roofProps: false, doors: ['e', 'w'] });
      continue;
    }
    const corner = (bi !== 1 && bj !== 1);
    const floors = corner ? rng.int(3, 4) : rng.int(2, 3);
    const W = rng.int(18, 24), D = rng.int(16, 22);
    const ox = bx + rng.int(1, 34 - W - 1), oz = bz + rng.int(1, 34 - D - 1);
    const b = building(w, pal, rng, { x: ox, z: oz, w: W, d: D, floors, wall: colors[(bi * 3 + bj + seed) % colors.length], trim: rng.pick(trims), floor: 0xe8dccb, roof: 0x9be7c4, roofMat: 'grass', prop: 0xffffff, wallMat: 'plaster' });
    roofs.push({ ...b, bi, bj, floors });
    // small kiosk / cover
    const kx = bx + (ox - bx > 8 ? 2 : 34 - 6), kz = bz + rng.int(2, 26);
    if (!(kx + 3 >= ox && kx <= ox + W && kz + 3 >= oz && kz <= oz + D)) crate(w, pal, kx, GROUND, kz, 3, rng.pick(colors));
    tree(w, pal, rng, bx + (ox - bx > 5 ? 2 : 32), bz + (oz - bz > 5 ? 2 : 32));
  }
  // sky bridges between neighbouring roofs of equal-ish height
  for (const a of roofs) for (const b of roofs) {
    if (a === b) continue;
    if (b.bi === a.bi + 1 && b.bj === a.bj && a.bj !== 1) {
      const y = Math.min(a.top, b.top);
      const z = Math.max(a.z0, b.z0) + 3;
      if (z + 3 > Math.min(a.z1, b.z1) - 2) continue;
      bridge(w, pal, a.x1 + 1, z, b.x0 - 1, z, y, 3, 0xffe066, 0xffffff);
      for (let yy = y + 1; yy <= a.top + 1; yy++) cutParapet(w, a.x1, z, yy, 3, false);
      for (let yy = y + 1; yy <= b.top + 1; yy++) cutParapet(w, b.x0, z, yy, 3, false);
      // carve doorway if heights differ
      for (let yy = y + 1; yy <= y + 5; yy++) { cutParapet(w, a.x1, z, yy, 3, false); cutParapet(w, b.x0, z, yy, 3, false); }
    }
    if (b.bj === a.bj + 1 && b.bi === a.bi && a.bi !== 1) {
      const y = Math.min(a.top, b.top);
      const x = Math.max(a.x0, b.x0) + 12;
      if (x + 3 > Math.min(a.x1, b.x1) - 2) continue;
      bridge(w, pal, x, a.z1 + 1, x, b.z0 - 1, y, 3, 0xffe066, 0xffffff);
      for (let yy = y + 1; yy <= y + 5; yy++) { cutParapet(w, x, a.z1, yy, 3, true); cutParapet(w, x, b.z0, yy, 3, true); }
    }
  }
  // set dressing
  const props = [];
  placeQueued(w, pal, rng, props, ['OakTree', 'OakTree', 'PalmTree']);
  // traffic lights on two corners of every crossing, cars parked along the streets
  for (const ix of [40, 82]) for (const iz of [40, 82]) {
    propAt(w, pal, props, 'TrafficLight', ix - 1, iz - 1, GROUND, 0);
    propAt(w, pal, props, 'TrafficLight', ix + 8, iz + 8, GROUND, 2);
  }
  const parkSpots = () => { const lane = rng.pick([41, 45, 83, 87]); const t = rng.pick([rng.int(8, 30), rng.int(52, 72), rng.int(94, 114)]); return rng.chance(0.5) ? [lane, t, GROUND, rng.pick([0, 2]), GROUND] : [t, lane, GROUND, rng.pick([1, 3]), GROUND]; };
  for (const t of ['SedanRed', 'SedanBlue', 'SedanWhite', 'Taxi', 'SedanBlue', 'Van', 'SedanWhite', 'SedanRed']) scatter(w, pal, rng, props, t, 1, parkSpots);
  for (const b of roofs) roofDressing(w, pal, rng, props, b);
  const edge = () => { const bk = rng.pick(blocks), t = rng.int(2, 31), side = rng.int(0, 3); const pos = [[bk + t, rng.pick(blocks) + 0], [bk + t, rng.pick(blocks) + 33], [rng.pick(blocks) + 0, bk + t], [rng.pick(blocks) + 33, bk + t]][side]; return [pos[0], pos[1], GROUND, [2, 0, 1, 3][side], GROUND]; };
  scatter(w, pal, rng, props, 'StreetLamp', 18, edge);
  const plaza = () => [rng.int(50, 80), rng.int(50, 80), GROUND, rng.int(0, 3), GROUND];
  scatter(w, pal, rng, props, 'CafeSet', 5, plaza);
  scatter(w, pal, rng, props, 'Bench', 6, plaza);
  scatter(w, pal, rng, props, 'Planter', 6, plaza);
  scatter(w, pal, rng, props, 'TrashBin', 5, plaza);
  const roadPos = () => { const sx = rng.chance(0.5); const a = rng.pick([41, 44, 83, 86]), t = rng.int(6, 120); return sx ? [a, t, GROUND] : [t, a, GROUND]; };
  scatter(w, pal, rng, props, 'TrafficCone', 10, roadPos);
  scatter(w, pal, rng, props, 'Hydrant', 6, edge);
  scatter(w, pal, rng, props, 'Barrier', 5, roadPos);
  scatter(w, pal, rng, props, 'NewsBox', 4, edge);
  scatter(w, pal, rng, props, 'BusStop', 3, edge);
  scatter(w, pal, rng, props, 'Dumpster', 3, edge);
  scatter(w, pal, rng, props, 'OakTree', 6, edge);
  return {
    world: w,
    props,
    spawns: collectSpawns(w, rng, 36),
    theme: {
      skyTop: 0x3f7fd8, skyHorizon: 0xffd1dc, skyBottom: 0xffe0c2,
      fog: 0xf3d6e2, fogNear: 60, fogFar: 170,
      sun: 0xfff0dc, sunIntensity: 2.8, sunDir: [-0.5, 0.7, -0.35],
      hemiSky: 0xeef0ff, hemiGround: 0xd9c4b8, hemiIntensity: 1.25,
      backdrop: 'city', backdropColors: [0x6c4f9e, 0x8e5fa8, 0xb86b9e, 0x5a4a8a],
      sunVisible: true,
    },
  };
}

function genHarbor(seed) {
  const w = new VoxelWorld(WORLD_X, WORLD_Y, WORLD_Z);
  const pal = new Palette(w);
  const rng = makeRng(seed);
  const QUAY = 6; // quay surface cell
  const concrete = pal.add(0xb7b4ac, false, 'concrete'), concrete2 = pal.add(0xa8a59d, false, 'concrete'), seabed = pal.add(0x5b6b63, false, 'sand'), sub = pal.add(0x77736a, false, 'rock'), mark = pal.add(0xf2c230, false, 'concrete');
  const waterEdge = 38;
  baseTerrain(w, pal, (x, z) => {
    if (x < waterEdge) return { h: 2, color: seabed, sub };
    const m = (x === waterEdge + 2 || z % 24 === 0) ? mark : ((x + z) % 7 === 0 ? concrete2 : concrete);
    return { h: QUAY, color: m, sub };
  });
  perimeter(w, pal, 0x8d98a6, 14);
  const wood = pal.add(0x8b6a45, false, 'wood'), wood2 = pal.add(0x75573a, false, 'wood'), post = pal.add(0x4e3b28, false, 'wood');
  // piers
  for (const pz of [14, 56, 98]) {
    for (let x = 6; x < waterEdge; x++) for (let z = pz; z < pz + 8; z++) setV(w, x, QUAY - 1, z, (x % 2) ? wood : wood2);
    for (let x = 6; x < waterEdge; x += 5) for (const z of [pz, pz + 7]) for (let y = 1; y < QUAY - 1; y++) setV(w, x, y, z, post);
    crate(w, pal, 10, QUAY, pz + 2, 3, 0xc8a165);
  }
  // ramps from water up to quay
  for (const rz of [34, 76]) for (let i = 0; i < 4; i++) for (let z = rz; z < rz + 4; z++) for (let y = 2; y <= 2 + i; y++) setV(w, waterEdge - 4 + i, y, z, concrete);
  // fishing boat
  const hull = pal.add(0xd94f4f, false, 'metal'), hullW = pal.add(0xf4f4f4, false, 'metal'), cabin = pal.add(0x2f6fb5, false, 'metal');
  for (let x = 14; x < 32; x++) for (let z = 30; z < 38; z++) {
    const taper = Math.max(0, (x - 27));
    if (z < 30 + Math.floor(taper / 1.5) || z > 37 - Math.floor(taper / 1.5)) continue;
    for (let y = 1; y <= 4; y++) {
      const edge = z === 30 + Math.floor(taper / 1.5) || z === 37 - Math.floor(taper / 1.5) || x === 14 || y === 1;
      if (edge || y === 1) setV(w, x, y, z, y >= 4 ? hullW : hull);
    }
    setV(w, x, 3, z, wood);
  }
  for (let x = 16; x < 21; x++) for (let z = 32; z < 36; z++) for (let y = 4; y < 8; y++) {
    if (x === 16 || x === 20 || z === 32 || z === 35 || y === 7) setV(w, x, y, z, cabin);
  }
  // warehouses
  building(w, pal, rng, { x: 92, z: 8, w: 30, d: 22, floors: 2, floorHeight: 10, base: QUAY - 1, wall: 0x8a9bb0, trim: 0xe9ecef, floor: 0x9ea3a8, roof: 0x6d7f94, doors: ['n', 'w', 's'], wallMat: 'corrugated', roofMat: 'metal' });
  building(w, pal, rng, { x: 92, z: 92, w: 28, d: 26, floors: 2, floorHeight: 9, base: QUAY - 1, wall: 0xb5654a, trim: 0xf1e3c8, floor: 0x9ea3a8, roof: 0x7b4636, doors: ['n', 'w', 's'], wallMat: 'brick', roofMat: 'shingles' });
  // office block
  building(w, pal, rng, { x: 100, z: 46, w: 16, d: 30, floors: 3, base: QUAY - 1, wall: 0xe8e1d0, trim: 0x33506b, floor: 0xa9a49a, doors: ['w', 'e'], wallMat: 'concrete' });
  // container yard
  const ccols = [0xd9483b, 0x2f7fd1, 0xf29d35, 0x3fae6a, 0xf2d03b, 0x8a5ac2, 0x22a6a6];
  const slots = [];
  for (let gx = 46; gx < 86; gx += 14) for (let gz = 10; gz < 118; gz += 9) slots.push([gx, gz]);
  for (const [gx, gz] of slots) {
    if (rng.chance(0.28)) continue;
    const stack = rng.int(1, 3);
    for (let s = 0; s < stack; s++) container(w, pal, gx, QUAY + s * 5, gz, true, rng.pick(ccols), s === 0 || rng.chance(0.5));
  }
  // crane on the quay edge
  const crane = pal.add(0xf2b632, false, 'metal'), crane2 = pal.add(0xd1931c, false, 'metal'), cab = pal.add(0x30343b, false, 'metal');
  const cx = waterEdge + 3, cz = 62, H = 44;
  for (let y = QUAY; y < QUAY + H; y++) for (const [dx, dz] of [[0, 0], [3, 0], [0, 3], [3, 3]]) setV(w, cx + dx, y, cz + dz, crane);
  for (let y = QUAY; y < QUAY + H; y += 4) {
    for (let i = 0; i < 4; i++) { setV(w, cx + i, y, cz, crane2); setV(w, cx + i, y, cz + 3, crane2); setV(w, cx, y, cz + i, crane2); setV(w, cx + 3, y, cz + i, crane2); }
    for (let i = 1; i < 3; i++) { setV(w, cx + i, y + i, cz, crane2); setV(w, cx + 3 - i, y + i, cz + 3, crane2); }
  }
  const by = QUAY + H;
  for (let x = cx - 26; x < cx + 14; x++) for (let z = cz; z < cz + 4; z++) {
    if (z === cz || z === cz + 3 || x % 3 === 0) setV(w, x, by, z, crane);
    if ((z === cz || z === cz + 3) && x % 3 === 0) setV(w, x, by + 1, z, crane2);
  }
  w.fillBox(cx + 9, by + 1, cz, cx + 13, by + 3, cz + 3, cab);
  w.fillBox(cx + 1, QUAY + H - 6, cz - 2, cx + 4, QUAY + H - 2, cz - 1, cab);
  // bollards & lamps
  const props = [];
  for (let z = 6; z < 122; z += 9) placeProp(w, props, (m) => pal.ghost(m), 'Mooring', waterEdge + 1, QUAY, z, 0);
  for (let z = 14; z < 120; z += 18) placeProp(w, props, (m) => pal.ghost(m), 'StreetLamp', 89, QUAY, z, 1);
  const yard = () => [rng.int(42, 90), rng.int(6, 122), QUAY];
  scatter(w, pal, rng, props, 'OilDrum', 18, yard);
  scatter(w, pal, rng, props, 'Pallet', 10, yard);
  scatter(w, pal, rng, props, 'Crate', 10, yard);
  scatter(w, pal, rng, props, 'TireStack', 6, yard);
  scatter(w, pal, rng, props, 'Barrier', 6, yard);
  scatter(w, pal, rng, props, 'TrafficCone', 8, yard);
  scatter(w, pal, rng, props, 'Sandbags', 4, yard);
  scatter(w, pal, rng, props, 'Forklift', 4, yard);
  scatter(w, pal, rng, props, 'Dumpster', 3, yard);
  scatter(w, pal, rng, props, 'Van', 2, yard);
  scatter(w, pal, rng, props, 'SedanWhite', 1, yard);
  scatter(w, pal, rng, props, 'SedanBlue', 1, yard);
  const quayEdge = () => [rng.int(42, 44), rng.int(6, 122), QUAY, rng.int(0, 3), QUAY];
  scatter(w, pal, rng, props, 'PalmTree', 7, quayEdge);
  for (const b of [{ x0: 92, z0: 8, x1: 121, z1: 29, top: QUAY - 1 + 20 }, { x0: 100, z0: 46, x1: 115, z1: 75, top: QUAY - 1 + 24 }]) roofDressing(w, pal, rng, props, b);
  return {
    world: w,
    props,
    spawns: collectSpawns(w, rng, 36, (x, y) => y >= QUAY || x > waterEdge),
    theme: {
      skyTop: 0x2c6fb7, skyHorizon: 0xbcdcf2, skyBottom: 0xd9e6ee,
      fog: 0xc4d8e6, fogNear: 60, fogFar: 170,
      sun: 0xfff3dd, sunIntensity: 2.6, sunDir: [0.5, 0.65, 0.3],
      hemiSky: 0xbcdcff, hemiGround: 0x8a8670, hemiIntensity: 1.1,
      // sea only west of the quay: craters dug into the quay are dry, not flooded
      water: { level: 2.65, color: 0x1f6f8b, deep: 0x0d3b52, maxX: waterEdge * VOXEL },
      backdrop: 'sea', backdropColors: [0x5a6d7d, 0x6d8190, 0x4b5d6d],
      sunVisible: true,
    },
  };
}

function genDowntown(seed) {
  const w = new VoxelWorld(WORLD_X, WORLD_Y, WORLD_Z);
  const pal = new Palette(w);
  const rng = makeRng(seed);
  const asphalt = pal.add(0x4a4c52, false, 'asphalt'), asphalt2 = pal.add(0x44464b, false, 'asphalt'), yellow = pal.add(0xf2c230, false, 'asphalt'), white = pal.add(0xf0f0f0, false, 'asphalt');
  const walk = pal.add(0xb9b6ae, false, 'paving'), walk2 = pal.add(0xa9a69e, false, 'paving'), sub = pal.add(0x6f6c66, false, 'concrete'), grass = pal.add(0x4f9d4a, false, 'grass');
  const lots = [[4, 40], [50, 82], [92, 124]];
  const inLot = (v) => lots.some(([a, b]) => v >= a && v < b);
  const lotEdge = (v) => lots.some(([a, b]) => v === a || v === b - 1);
  baseTerrain(w, pal, (x, z) => {
    const lx = inLot(x), lz = inLot(z);
    if (lx && lz) return { h: GROUND + 1, color: (lotEdge(x) || lotEdge(z)) ? walk2 : walk, sub };
    // road
    let color = (x + z) % 9 === 0 ? asphalt2 : asphalt;
    if (!lx && lz && (x === 45 || x === 87) && z % 6 < 3) color = yellow;
    if (!lz && lx && (z === 45 || z === 87) && x % 6 < 3) color = yellow;
    if (!lx && !lz && ((x % 2 === 0 && (z === 41 || z === 49 || z === 83 || z === 91)) || (z % 2 === 0 && (x === 41 || x === 49 || x === 83 || x === 91)))) color = white;
    return { h: GROUND, color, sub };
  });
  perimeter(w, pal, 0x9aa3ae, 16);
  const walls = [0xc9c4ba, 0x8e9aa6, 0xb5654a, 0xd8cfb8, 0x6b7c8f, 0xe3dccd, 0x9c6b54];
  const dtRoofs = [];
  const trims = [0x2d3a4a, 0xf2f2f2, 0x40362e];
  let idx = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const [ax, bx] = lots[i], [az, bz] = lots[j];
    if (i === 1 && j === 1) {
      // plaza with statue and planters
      const stone = pal.add(0xd8d2c4, false, 'concrete'), bronze = pal.add(0x8a6a3a, false, 'metal');
      for (let y = GROUND + 1; y < GROUND + 4; y++) w.fillBox(64, y, 64, 67, y, 67, stone);
      for (let y = GROUND + 4; y < GROUND + 11; y++) w.fillBox(65, y, 65, 66, y, 66, bronze);
      w.fillBox(64, GROUND + 9, 65, 67, GROUND + 9, 66, bronze);
      for (const [px, pz] of [[54, 54], [76, 54], [54, 76], [76, 76]]) {
        w.fillBox(px - 2, GROUND + 1, pz - 2, px + 2, GROUND + 2, pz + 2, stone);
        w.fillBox(px - 1, GROUND + 2, pz - 1, px + 1, GROUND + 2, pz + 1, grass);
        tree(w, pal, rng, px, pz, GROUND + 3);
      }
      // elevated walkway pillars
      continue;
    }
    if (i === 2 && j === 1) {
      // open parking structure with ramps
      const pc = pal.add(0x9a9ea3, false, 'concrete'), pr = pal.add(0x7d8186, false, 'concrete');
      const base = GROUND;
      for (let lvl = 1; lvl <= 2; lvl++) {
        const y = base + lvl * 7;
        w.fillBox(ax + 1, y, az + 1, bx - 2, y, bz - 2, pc);
        for (let x = ax + 1; x <= bx - 2; x++) { setV(w, x, y + 1, az + 1, pr); setV(w, x, y + 1, bz - 2, pr); }
        for (const [px, pz] of [[ax + 1, az + 1], [bx - 2, az + 1], [ax + 1, bz - 2], [bx - 2, bz - 2], [ax + 16, az + 1], [ax + 16, bz - 2], [ax + 1, az + 16], [bx - 2, az + 16]]) {
          for (let yy = y - 6; yy < y; yy++) { setV(w, px, yy, pz, pr); }
        }
        // ramp (stairs) from previous level
        for (let s = 0; s < 7; s++) for (let q = 0; q < 4; q++) {
          for (let yy = y - 7 + 1; yy <= y - 7 + 1 + s; yy++) setV(w, ax + 4 + s, yy, az + 6 + q + (lvl - 1) * 10, pc);
        }
        for (let s = 2; s < 7; s++) for (let q = 0; q < 4; q++) setV(w, ax + 4 + s, y, az + 6 + q + (lvl - 1) * 10, AIR);
      }
      car(w, pal, rng, ax + 18, az + 4, true, 0xd23c3c, GROUND + 8);
      car(w, pal, rng, ax + 6, az + 24, true, 0x3c7bd2, GROUND + 8);
      car(w, pal, rng, ax + 20, az + 22, false, 0xe6e6e6, GROUND + 1);
      continue;
    }
    const W = rng.int(20, 30), D = rng.int(20, 30);
    const ox = ax + rng.int(1, Math.max(1, (bx - ax) - W - 1)), oz = az + rng.int(1, Math.max(1, (bz - az) - D - 1));
    const floors = rng.int(3, 5);
    const wc = walls[idx++ % walls.length];
    dtRoofs.push(building(w, pal, rng, { x: ox, z: oz, w: W, d: D, floors, base: GROUND, wall: wc, trim: rng.pick(trims), floor: 0xa7a39b, roof: 0x5e6266, windowSpacing: 3, wallMat: (wc === 0xb5654a || wc === 0x9c6b54) ? 'brick' : 'concrete' }));
  }
  // elevated walkway across the plaza between two towers
  const walkC = 0x5f87a8;
  bridge(w, pal, 40, 62, 50, 62, GROUND + 16, 4, walkC, 0xdfe7ee);
  bridge(w, pal, 82, 62, 92, 62, GROUND + 16, 4, walkC, 0xdfe7ee);
  for (const x of [42, 47, 84, 89]) for (let y = GROUND; y < GROUND + 16; y++) { setV(w, x, y, 62, pal.add(0x4a6c88, false, 'metal')); setV(w, x, y, 65, pal.add(0x4a6c88, false, 'metal')); }
  // street cars
  const carCols = [0xd23c3c, 0x3c7bd2, 0xf2f2f2, 0x222222, 0xf2c230, 0x3cae6a];
  for (let k = 0; k < 10; k++) {
    const alongX = rng.chance(0.5);
    const road = rng.pick([42, 84]);
    const t = rng.int(6, 112);
    if (alongX) car(w, pal, rng, t, road + rng.int(0, 2), true, rng.pick(carCols));
    else car(w, pal, rng, road + rng.int(0, 2), t, false, rng.pick(carCols));
  }
  const props = [];
  placeQueued(w, pal, rng, props, ['OakTree']);
  for (const [ix, iz] of [[39, 39], [50, 50], [81, 81], [92, 92], [39, 92], [50, 81], [81, 50], [92, 39]]) propAt(w, pal, props, 'TrafficLight', ix, iz, GROUND + 1, ix < 64 === iz < 64 ? 0 : 1);
  for (const b of dtRoofs) roofDressing(w, pal, rng, props, b);
  const lotEdges = [4, 39, 50, 81, 92, 123];
  const sidewalk = () => { const a = rng.pick(lotEdges), t = rng.int(5, 122); return rng.chance(0.5) ? [a, t, GROUND + 1, a === 4 || a === 50 || a === 92 ? 1 : 3, GROUND + 1] : [t, a, GROUND + 1, a === 4 || a === 50 || a === 92 ? 2 : 0, GROUND + 1]; };
  scatter(w, pal, rng, props, 'StreetLamp', 16, sidewalk);
  scatter(w, pal, rng, props, 'Hydrant', 8, sidewalk);
  scatter(w, pal, rng, props, 'TrashBin', 8, sidewalk);
  scatter(w, pal, rng, props, 'Bench', 6, sidewalk);
  scatter(w, pal, rng, props, 'NewsBox', 5, sidewalk);
  scatter(w, pal, rng, props, 'Bollard', 10, sidewalk);
  scatter(w, pal, rng, props, 'RoadSign', 6, sidewalk);
  scatter(w, pal, rng, props, 'BusStop', 3, sidewalk);
  scatter(w, pal, rng, props, 'Dumpster', 4, sidewalk);
  scatter(w, pal, rng, props, 'OakTree', 8, sidewalk);
  const road = () => { const a = rng.pick([42, 44, 46, 84, 86, 88]), t = rng.int(6, 122); return rng.chance(0.5) ? [a, t, GROUND, rng.int(0, 3), GROUND] : [t, a, GROUND, rng.int(0, 3), GROUND]; };
  scatter(w, pal, rng, props, 'TrafficCone', 12, road);
  scatter(w, pal, rng, props, 'Barrier', 6, road);
  const plaza = () => [rng.int(52, 78), rng.int(52, 78), GROUND + 1, rng.int(0, 3), GROUND + 1];
  scatter(w, pal, rng, props, 'Bench', 4, plaza);
  scatter(w, pal, rng, props, 'TrashBin', 3, plaza);
  return {
    world: w,
    props,
    spawns: collectSpawns(w, rng, 36),
    theme: {
      skyTop: 0x1f4f99, skyHorizon: 0x9fd0f2, skyBottom: 0xc7dbe6,
      fog: 0xb6cee0, fogNear: 60, fogFar: 170,
      sun: 0xfff1d6, sunIntensity: 2.7, sunDir: [-0.4, 0.7, 0.45],
      hemiSky: 0xdfeaff, hemiGround: 0xa9a49a, hemiIntensity: 1.3,
      backdrop: 'city', backdropColors: [0x56677a, 0x6b7d90, 0x485869, 0x7b8a9a],
      sunVisible: true,
    },
  };
}

const GENERATORS = { skyline: genSkyline, harbor: genHarbor, downtown: genDowntown };

export function generateMap(name, seed = 1) {
  const gen = GENERATORS[name] || GENERATORS.skyline;
  const key = GENERATORS[name] ? name : 'skyline';
  const m = gen(seed >>> 0);
  // anything the generator left hanging (only touching diagonally, or one cell above the ground) would
  // stay in the air forever once its surroundings are shot away: remove it up front
  const w = m.world, all = [];
  for (let i = 0; i < w.size; i++) { const v = w.data[i]; if (v && !w.ghost[v]) all.push(i); }
  for (const idx of w.findFloatingClusters(all)) for (const i of idx) w.data[i] = 0;
  m.world.measureStructures();
  return { name: key, display: MAP_INFO[key].display, seed: seed >>> 0, ...m };
}

export const MAP_NAMES = Object.keys(GENERATORS);
