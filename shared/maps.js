// Procedural, seeded map generators. Every map is built entirely from destructible voxels
// (except the bedrock layer and the arena boundary wall).

import { VoxelWorld, AIR } from './voxelWorld.js';
import { VOXEL, WORLD_X, WORLD_Y, WORLD_Z } from './constants.js';
import { makeRng, hash3 } from './util.js';

export const GROUND = 4; // first walkable cell above the base terrain

export const MAP_INFO = {
  skyline: { display: 'SKYLINE', blurb: 'Candy-coloured rooftops, sky bridges and a sunset plaza.' },
  harbor: { display: 'HARBOR', blurb: 'Container stacks, warehouses and a towering dock crane.' },
  quarry: { display: 'QUARRY', blurb: 'Terraced canyon, rock spires and rickety mine scaffolds.' },
  downtown: { display: 'DOWNTOWN', blurb: 'Concrete towers, parked cars and an elevated walkway.' },
};

class Palette {
  constructor(world) { this.world = world; this.next = 1; this.cache = new Map(); }
  add(color, hard = false) {
    const key = color * 2 + (hard ? 1 : 0);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.next > 254) return 1;
    const idx = this.next++;
    this.world.palette[idx] = color;
    this.world.hard[idx] = hard ? 1 : 0;
    this.cache.set(key, idx);
    return idx;
  }
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
  const bedrock = pal.add(0x2a2730, hardBase);
  w.fillBox(0, 0, 0, w.sx - 1, 0, w.sz - 1, bedrock);
  for (let z = 0; z < w.sz; z++) for (let x = 0; x < w.sx; x++) {
    const { h, color, sub } = topFn(x, z);
    for (let y = 1; y < h; y++) setV(w, x, y, z, y === h - 1 ? color : sub);
  }
}

function perimeter(w, pal, color, height) {
  const c = pal.add(color, true);
  const c2 = pal.add(shade(color, 1.25), true);
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
  const wall = pal.add(o.wall);
  const wallAlt = pal.add(shade(o.wall, 0.9));
  const trim = pal.add(o.trim);
  const floorC = pal.add(o.floor ?? 0x9a9184);
  const roofC = pal.add(o.roof ?? shade(o.wall, 0.75));
  const stairC = pal.add(o.stair ?? 0x8c8378);
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
    const propC = pal.add(o.prop ?? 0xcfd2d6);
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const pw = rng.int(2, 4), pd = rng.int(2, 4);
      const px = rng.int(x0 + 10, Math.max(x0 + 10, x1 - pw - 1));
      const pz = rng.int(z0 + 2, Math.max(z0 + 2, z1 - pd - 1));
      if (px + pw >= x1) continue;
      w.fillBox(px, top + 1, pz, px + pw - 1, top + rng.int(1, 3), pz + pd - 1, propC);
    }
  }
  return { x0, z0, x1, z1, top, base };
}

function cutParapet(w, x, z, y, len, alongX) {
  for (let i = 0; i < len; i++) {
    if (alongX) setV(w, x + i, y, z, AIR); else setV(w, x, y, z + i, AIR);
  }
}

function bridge(w, pal, ax, az, bx, bz, y, width, color, railColor) {
  const c = pal.add(color), rc = pal.add(railColor);
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

function tree(w, pal, rng, x, z, base = GROUND) {
  const trunk = pal.add(0x6b4a2f);
  const leaf1 = pal.add(0x3fae4a), leaf2 = pal.add(0x2f8f3d), leaf3 = pal.add(0x5cc95a);
  const h = rng.int(5, 8);
  for (let y = base; y < base + h; y++) setV(w, x, y, z, trunk);
  const r = rng.int(2, 3);
  const cy = base + h;
  for (let dy = -r; dy <= r + 1; dy++) for (let dz = -r - 1; dz <= r + 1; dz++) for (let dx = -r - 1; dx <= r + 1; dx++) {
    const d = dx * dx + dz * dz + (dy * 1.3) * (dy * 1.3);
    if (d > (r + 0.6) * (r + 0.6)) continue;
    const n = hash3(x + dx, cy + dy, z + dz, 5);
    if (d > r * r && n < 0.5) continue;
    setV(w, x + dx, cy + dy, z + dz, n < 0.33 ? leaf1 : n < 0.66 ? leaf2 : leaf3);
  }
}

function crate(w, pal, x, y, z, s, color) {
  const c = pal.add(color), e = pal.add(shade(color, 0.7));
  for (let dy = 0; dy < s; dy++) for (let dz = 0; dz < s; dz++) for (let dx = 0; dx < s; dx++) {
    const edge = (dx === 0 || dx === s - 1) + (dy === 0 || dy === s - 1) + (dz === 0 || dz === s - 1) >= 2;
    setV(w, x + dx, y + dy, z + dz, edge ? e : c);
  }
}

function container(w, pal, x, y, z, alongX, color, openEnds = true) {
  const L = 12, Wd = 5, Ht = 5;
  const c = pal.add(color), rib = pal.add(shade(color, 0.78)), frame = pal.add(shade(color, 0.6));
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

function car(w, pal, rng, x, z, alongX, color, base = GROUND) {
  const body = pal.add(color), dark = pal.add(0x1d1f24), glass = pal.add(0x7fb8d8), light = pal.add(0xfff2b0);
  const L = 9, Wd = 4;
  for (let a = 0; a < L; a++) for (let b = 0; b < Wd; b++) {
    const px = alongX ? x + a : x + b, pz = alongX ? z + b : z + a;
    const wheel = (a === 1 || a === L - 2) && (b === 0 || b === Wd - 1);
    setV(w, px, base, pz, wheel ? dark : body);
    setV(w, px, base + 1, pz, (a === 0 || a === L - 1) && (b === 0 || b === Wd - 1) ? light : body);
    if (a >= 2 && a <= 6) setV(w, px, base + 2, pz, (b === 0 || b === Wd - 1 || a === 2 || a === 6) ? glass : body);
    if (a >= 3 && a <= 5) setV(w, px, base + 3, pz, body);
  }
}

function lamp(w, pal, x, z, base = GROUND) {
  const pole = pal.add(0x3a3d44), bulb = pal.add(0xfff1a8);
  for (let y = base; y < base + 9; y++) setV(w, x, y, z, pole);
  setV(w, x + 1, base + 8, z, pole);
  setV(w, x + 1, base + 7, z, bulb);
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
  const tileA = pal.add(0xf4d6e4), tileB = pal.add(0xd6eef4), street = pal.add(0x6e6790), stripe = pal.add(0xffe066), sub = pal.add(0x8a7f8f);
  const blocks = [6, 48, 90];
  const inBlock = (v) => blocks.some((b) => v >= b && v < b + 34);
  baseTerrain(w, pal, (x, z) => {
    const ib = inBlock(x) && inBlock(z);
    let color;
    if (ib) color = ((x >> 2) + (z >> 2)) % 2 === 0 ? tileA : tileB;
    else color = (x % 12 < 5 && !inBlock(x) && (z % 6 === 0)) || (z % 12 < 5 && !inBlock(z) && (x % 6 === 0)) ? stripe : street;
    return { h: GROUND, color, sub };
  });
  perimeter(w, pal, 0x9d8fd0, 14);
  const colors = [0xff6f91, 0x36cfc9, 0xffc75f, 0xa78bfa, 0x7ee081, 0xff9f43, 0x4fc3f7, 0xf06bd6, 0xff5e5e];
  const trims = [0xffffff, 0xfff4e0, 0x2d2a4a];
  const roofs = [];
  for (let bi = 0; bi < 3; bi++) for (let bj = 0; bj < 3; bj++) {
    const bx = blocks[bi], bz = blocks[bj];
    if (bi === 1 && bj === 1) {
      // central plaza with fountain and trees
      const water = pal.add(0x3fa7ff), rim = pal.add(0xfafafa), stone = pal.add(0xe0c9a6);
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
    const b = building(w, pal, rng, { x: ox, z: oz, w: W, d: D, floors, wall: colors[(bi * 3 + bj + seed) % colors.length], trim: rng.pick(trims), floor: 0xe8dccb, roof: 0x9be7c4, prop: 0xffffff });
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
  return {
    world: w,
    spawns: collectSpawns(w, rng, 36),
    theme: {
      skyTop: 0x3b2a7a, skyHorizon: 0xff8fa3, skyBottom: 0xffc48a,
      fog: 0xf7a6b4, fogNear: 45, fogFar: 140,
      sun: 0xffd2a1, sunIntensity: 2.4, sunDir: [-0.55, 0.42, -0.35],
      hemiSky: 0xbfa6ff, hemiGround: 0xff9e7a, hemiIntensity: 1.25,
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
  const concrete = pal.add(0xb7b4ac), concrete2 = pal.add(0xa8a59d), seabed = pal.add(0x5b6b63), sub = pal.add(0x77736a), mark = pal.add(0xf2c230);
  const waterEdge = 38;
  baseTerrain(w, pal, (x, z) => {
    if (x < waterEdge) return { h: 2, color: seabed, sub };
    const m = (x === waterEdge + 2 || z % 24 === 0) ? mark : ((x + z) % 7 === 0 ? concrete2 : concrete);
    return { h: QUAY, color: m, sub };
  });
  perimeter(w, pal, 0x8d98a6, 14);
  const wood = pal.add(0x8b6a45), wood2 = pal.add(0x75573a), post = pal.add(0x4e3b28);
  // piers
  for (const pz of [14, 56, 98]) {
    for (let x = 6; x < waterEdge; x++) for (let z = pz; z < pz + 8; z++) setV(w, x, QUAY - 1, z, (x % 2) ? wood : wood2);
    for (let x = 6; x < waterEdge; x += 5) for (const z of [pz, pz + 7]) for (let y = 1; y < QUAY - 1; y++) setV(w, x, y, z, post);
    crate(w, pal, 10, QUAY, pz + 2, 3, 0xc8a165);
  }
  // ramps from water up to quay
  for (const rz of [34, 76]) for (let i = 0; i < 4; i++) for (let z = rz; z < rz + 4; z++) for (let y = 2; y <= 2 + i; y++) setV(w, waterEdge - 4 + i, y, z, concrete);
  // fishing boat
  const hull = pal.add(0xd94f4f), hullW = pal.add(0xf4f4f4), cabin = pal.add(0x2f6fb5);
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
  building(w, pal, rng, { x: 92, z: 8, w: 30, d: 22, floors: 2, floorHeight: 10, base: QUAY - 1, wall: 0x8a9bb0, trim: 0xe9ecef, floor: 0x9ea3a8, roof: 0x6d7f94, doors: ['n', 'w', 's'] });
  building(w, pal, rng, { x: 92, z: 92, w: 28, d: 26, floors: 2, floorHeight: 9, base: QUAY - 1, wall: 0xb5654a, trim: 0xf1e3c8, floor: 0x9ea3a8, roof: 0x7b4636, doors: ['n', 'w', 's'] });
  // office block
  building(w, pal, rng, { x: 100, z: 46, w: 16, d: 30, floors: 3, base: QUAY - 1, wall: 0xe8e1d0, trim: 0x33506b, floor: 0xa9a49a, doors: ['w', 'e'] });
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
  const crane = pal.add(0xf2b632), crane2 = pal.add(0xd1931c), cab = pal.add(0x30343b);
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
  for (let z = 6; z < 122; z += 10) setV(w, waterEdge, QUAY, z, pal.add(0x2b2b2b));
  for (let z = 20; z < 120; z += 30) lamp(w, pal, 88, z, QUAY);
  return {
    world: w,
    spawns: collectSpawns(w, rng, 36, (x, y) => y >= QUAY || x > waterEdge),
    theme: {
      skyTop: 0x2c6fb7, skyHorizon: 0xbcdcf2, skyBottom: 0xd9e6ee,
      fog: 0xb8cfdf, fogNear: 50, fogFar: 150,
      sun: 0xfff3dd, sunIntensity: 2.6, sunDir: [0.5, 0.65, 0.3],
      hemiSky: 0xbcdcff, hemiGround: 0x8a8670, hemiIntensity: 1.1,
      water: { level: 2.65, color: 0x1f6f8b, deep: 0x0d3b52 },
      backdrop: 'sea', backdropColors: [0x5a6d7d, 0x6d8190, 0x4b5d6d],
      sunVisible: true,
    },
  };
}

function valueNoise2(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = hash3(xi, 0, zi, seed), b = hash3(xi + 1, 0, zi, seed), c = hash3(xi, 0, zi + 1, seed), d = hash3(xi + 1, 0, zi + 1, seed);
  const u = s(xf), v = s(zf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function genQuarry(seed) {
  const w = new VoxelWorld(WORLD_X, WORLD_Y, WORLD_Z);
  const pal = new Palette(w);
  const rng = makeRng(seed);
  const bands = [0xc9a26b, 0xd8b47c, 0xb9814f, 0xe5c99a, 0xa86b3c, 0xcf9a62].map((c) => pal.add(c));
  const sand = pal.add(0xe7c28c), gravel = pal.add(0x9c8b78);
  const heightAt = (x, z) => {
    const cx = x - 64, cz = z - 64;
    const r = Math.hypot(cx, cz);
    let h = 8 + valueNoise2(x / 18, z / 18, seed) * 6 + valueNoise2(x / 7, z / 7, seed + 1) * 2;
    // central pit with terraces
    if (r < 40) h = Math.min(h, 3 + Math.floor(Math.max(0, r - 14) / 6) * 1.5);
    // outer ridge
    if (r > 50) h += (r - 50) * 0.35;
    return Math.max(2, Math.min(26, Math.round(h)));
  };
  baseTerrain(w, pal, (x, z) => {
    const h = heightAt(x, z);
    return { h, color: h <= 4 ? gravel : sand, sub: bands[Math.floor(h / 2) % bands.length] };
  });
  // colour terrace bands on exposed faces
  for (let z = 0; z < w.sz; z++) for (let x = 0; x < w.sx; x++) {
    const top = w.topSolid(x, z);
    for (let y = 1; y < top; y++) w.data[w.index(x, y, z)] = bands[Math.floor((y + (hash3(x >> 3, 0, z >> 3, 2) * 2 | 0)) / 2) % bands.length];
  }
  perimeter(w, pal, 0xb07a52, 30);
  // rock spires
  const rock = pal.add(0xa0785a), rock2 = pal.add(0x8a6448), rock3 = pal.add(0xb98f6b);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rr = rng.range(22, 34);
    const px = Math.round(64 + Math.cos(a) * rr), pz = Math.round(64 + Math.sin(a) * rr);
    const baseY = w.topSolid(px, pz) + 1;
    const hgt = rng.int(16, 28);
    for (let y = baseY; y < baseY + hgt && y < w.sy - 2; y++) {
      const rad = 2.4 + Math.sin(y * 0.4 + i) * 0.8 + (y - baseY < 3 ? 1 : 0) + (y > baseY + hgt - 4 ? 1.2 : 0);
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dz * dz > rad * rad) continue;
        const n = hash3(px + dx, y, pz + dz, 9);
        setV(w, px + dx, y, pz + dz, n < 0.33 ? rock : n < 0.66 ? rock2 : rock3);
      }
    }
  }
  // scaffolding towers
  const beam = pal.add(0x7a5a36), plank = pal.add(0xb08a58);
  const towers = [[30, 30], [96, 34], [34, 96], [94, 94]];
  for (const [tx, tz] of towers) {
    const baseY = w.topSolid(tx + 3, tz + 3) + 1;
    const levels = 3, LH = 7;
    for (let y = baseY - 2; y < baseY + levels * LH; y++) for (const [dx, dz] of [[0, 0], [8, 0], [0, 8], [8, 8]]) setV(w, tx + dx, y, tz + dz, beam);
    for (let l = 1; l <= levels; l++) {
      const y = baseY - 1 + l * LH;
      w.fillBox(tx, y, tz, tx + 8, y, tz + 8, plank);
      for (let i = 0; i <= 8; i++) { setV(w, tx + i, y + 1, tz, beam); setV(w, tx + i, y + 1, tz + 8, beam); setV(w, tx, y + 1, tz + i, beam); }
      // stair hole + steps along the open side
      for (let i = 0; i < LH; i++) for (let q = 0; q < 2; q++) setV(w, tx + 9 + q, y - LH + 1 + i, tz + 1 + i, plank);
      for (let i = 0; i < 2; i++) setV(w, tx + 8, y + 1, tz + 7 - i, AIR);
    }
  }
  // conveyor bridge across the pit
  const steel = pal.add(0x5d6670), belt = pal.add(0x2b2b2b);
  const by = 16;
  for (let x = 12; x < 116; x++) for (let z = 62; z < 66; z++) {
    setV(w, x, by, z, z === 62 || z === 65 ? steel : belt);
    if (z === 62 || z === 65) setV(w, x, by + 1, z, steel);
  }
  for (let x = 24; x < 110; x += 14) for (let y = w.topSolid(x, 63) + 1; y < by; y++) { setV(w, x, y, 62, steel); setV(w, x, y, 65, steel); }
  // bunkers
  const conc = 0xb8b2a6;
  building(w, pal, rng, { x: 54, z: 54, w: 20, d: 20, floors: 1, floorHeight: 7, base: w.topSolid(64, 64), wall: conc, trim: 0x6e665a, roofProps: false, stairs: true });
  building(w, pal, rng, { x: 8, z: 56, w: 12, d: 16, floors: 2, base: w.topSolid(14, 64), wall: 0xd9cbb0, trim: 0x8a5a36 });
  building(w, pal, rng, { x: 108, z: 56, w: 12, d: 16, floors: 2, base: w.topSolid(114, 64), wall: 0xd9cbb0, trim: 0x8a5a36 });
  for (let i = 0; i < 14; i++) {
    const x = rng.int(8, 118), z = rng.int(8, 118);
    crate(w, pal, x, w.topSolid(x, z) + 1, z, rng.int(2, 3), rng.pick([0xc8a165, 0x8f6a3e, 0x6f7f5a]));
  }
  return {
    world: w,
    spawns: collectSpawns(w, rng, 36),
    theme: {
      skyTop: 0x4f8fd6, skyHorizon: 0xf6d9a8, skyBottom: 0xe9c08a,
      fog: 0xe8c99c, fogNear: 40, fogFar: 130,
      sun: 0xffe6b8, sunIntensity: 2.9, sunDir: [0.3, 0.8, -0.4],
      hemiSky: 0xcfe3ff, hemiGround: 0xc98d55, hemiIntensity: 1.1,
      backdrop: 'mesa', backdropColors: [0xb5794a, 0xc98c5a, 0xa66a40],
      sunVisible: true,
    },
  };
}

function genDowntown(seed) {
  const w = new VoxelWorld(WORLD_X, WORLD_Y, WORLD_Z);
  const pal = new Palette(w);
  const rng = makeRng(seed);
  const asphalt = pal.add(0x3a3c42), asphalt2 = pal.add(0x34363b), yellow = pal.add(0xf2c230), white = pal.add(0xf0f0f0);
  const walk = pal.add(0xb9b6ae), walk2 = pal.add(0xa9a69e), sub = pal.add(0x6f6c66), grass = pal.add(0x4f9d4a);
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
  const trims = [0x2d3a4a, 0xf2f2f2, 0x40362e];
  let idx = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const [ax, bx] = lots[i], [az, bz] = lots[j];
    if (i === 1 && j === 1) {
      // plaza with statue and planters
      const stone = pal.add(0xd8d2c4), bronze = pal.add(0x8a6a3a);
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
      const pc = pal.add(0x9a9ea3), pr = pal.add(0x7d8186);
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
    building(w, pal, rng, { x: ox, z: oz, w: W, d: D, floors, base: GROUND, wall: walls[idx++ % walls.length], trim: rng.pick(trims), floor: 0xa7a39b, roof: 0x5e6266, windowSpacing: 3 });
  }
  // elevated walkway across the plaza between two towers
  const walkC = 0x5f87a8;
  bridge(w, pal, 40, 62, 50, 62, GROUND + 16, 4, walkC, 0xdfe7ee);
  bridge(w, pal, 82, 62, 92, 62, GROUND + 16, 4, walkC, 0xdfe7ee);
  for (const x of [42, 47, 84, 89]) for (let y = GROUND + 1; y < GROUND + 16; y++) { setV(w, x, y, 62, pal.add(0x4a6c88)); setV(w, x, y, 65, pal.add(0x4a6c88)); }
  // street cars
  const carCols = [0xd23c3c, 0x3c7bd2, 0xf2f2f2, 0x222222, 0xf2c230, 0x3cae6a];
  for (let k = 0; k < 10; k++) {
    const alongX = rng.chance(0.5);
    const road = rng.pick([42, 84]);
    const t = rng.int(6, 112);
    if (alongX) car(w, pal, rng, t, road + rng.int(0, 2), true, rng.pick(carCols));
    else car(w, pal, rng, road + rng.int(0, 2), t, false, rng.pick(carCols));
  }
  for (const [x, z] of [[41, 20], [41, 100], [91, 20], [91, 100], [20, 41], [100, 91]]) lamp(w, pal, x, z);
  return {
    world: w,
    spawns: collectSpawns(w, rng, 36),
    theme: {
      skyTop: 0x1f4f99, skyHorizon: 0x9fd0f2, skyBottom: 0xc7dbe6,
      fog: 0xa9c4d8, fogNear: 45, fogFar: 140,
      sun: 0xfff1d6, sunIntensity: 2.7, sunDir: [-0.4, 0.7, 0.45],
      hemiSky: 0xcfe2ff, hemiGround: 0x7d7a74, hemiIntensity: 1.1,
      backdrop: 'city', backdropColors: [0x56677a, 0x6b7d90, 0x485869, 0x7b8a9a],
      sunVisible: true,
    },
  };
}

const GENERATORS = { skyline: genSkyline, harbor: genHarbor, quarry: genQuarry, downtown: genDowntown };

export function generateMap(name, seed = 1) {
  const gen = GENERATORS[name] || GENERATORS.skyline;
  const key = GENERATORS[name] ? name : 'skyline';
  const m = gen(seed >>> 0);
  return { name: key, display: MAP_INFO[key].display, seed: seed >>> 0, ...m };
}

export const MAP_NAMES = Object.keys(GENERATORS);
