// Set-dressing props (Blender-modelled, see tools/blender/build_props.py).
// Solid props reserve invisible "ghost" voxels so players collide with them and bullets hit them;
// a prop breaks apart when any of its voxels, or the voxel it stands on, is destroyed.

export const PROP_DEFS = {
  StreetLamp: { size: [1, 8, 1], solid: false, mat: 'metal' },
  Bench: { size: [3, 1, 1], solid: true, mat: 'wood' },
  TrashBin: { size: [1, 2, 1], solid: true, mat: 'metal' },
  TrafficCone: { size: [1, 1, 1], solid: false, mat: 'fabric' },
  Barrier: { size: [4, 2, 1], solid: true, mat: 'concrete' },
  Hydrant: { size: [1, 1, 1], solid: true, mat: 'metal' },
  Planter: { size: [2, 2, 2], solid: true, mat: 'concrete' },
  ACUnit: { size: [2, 2, 1], solid: true, mat: 'metal' },
  WaterTank: { size: [4, 7, 4], solid: true, mat: 'wood' },
  SatDish: { size: [1, 3, 1], solid: false, mat: 'metal' },
  OilDrum: { size: [1, 2, 1], solid: true, mat: 'metal' },
  Sandbags: { size: [3, 2, 1], solid: true, mat: 'fabric' },
  Pallet: { size: [2, 1, 2], solid: false, mat: 'wood' },
  Crate: { size: [2, 2, 2], solid: true, mat: 'wood' },
  CafeSet: { size: [1, 2, 1], solid: false, mat: 'wood' },
  Bollard: { size: [1, 2, 1], solid: true, mat: 'metal' },
  RoadSign: { size: [1, 5, 1], solid: false, mat: 'metal' },
  Antenna: { size: [1, 6, 1], solid: false, mat: 'metal' },
  Vent: { size: [1, 2, 1], solid: true, mat: 'metal' },
  Mooring: { size: [1, 1, 1], solid: true, mat: 'metal' },
  NewsBox: { size: [1, 2, 1], solid: true, mat: 'metal' },
  TireStack: { size: [1, 2, 1], solid: true, mat: 'fabric' },
  // realistic set dressing (Blender): trees, vehicles, street furniture
  OakTree: { size: [1, 6, 1], solid: true, mat: 'wood' },
  PineTree: { size: [1, 8, 1], solid: true, mat: 'wood' },
  PalmTree: { size: [1, 8, 1], solid: true, mat: 'wood' },
  SedanRed: { size: [4, 3, 9], solid: true, mat: 'metal' },
  SedanBlue: { size: [4, 3, 9], solid: true, mat: 'metal' },
  SedanWhite: { size: [4, 3, 9], solid: true, mat: 'metal' },
  Taxi: { size: [4, 3, 9], solid: true, mat: 'metal' },
  Van: { size: [4, 5, 10], solid: true, mat: 'metal' },
  Dumpster: { size: [4, 3, 2], solid: true, mat: 'metal' },
  TrafficLight: { size: [1, 10, 1], solid: true, mat: 'metal' },
  BusStop: { size: [7, 5, 3], solid: false, mat: 'metal' },
  Forklift: { size: [3, 4, 7], solid: true, mat: 'metal' },
  PowerPole: { size: [1, 16, 1], solid: true, mat: 'wood' },
  Boulder: { size: [4, 3, 4], solid: true, mat: 'concrete' },
};

export const PROP_TYPES = Object.keys(PROP_DEFS);

// Footprint cells (relative voxel offsets) for a prop rotated by r quarter turns.
export function propCells(type, r = 0) {
  const d = PROP_DEFS[type];
  if (!d) return [];
  let [w, h, dd] = d.size;
  if (r % 2 === 1) [w, dd] = [dd, w];
  const cells = [];
  const ox = Math.floor((w - 1) / 2), oz = Math.floor((dd - 1) / 2);
  for (let y = 0; y < h; y++) for (let z = 0; z < dd; z++) for (let x = 0; x < w; x++) cells.push([x - ox, y, z - oz]);
  return cells;
}

// Try to place a prop at voxel (x, y, z) = first free cell above the ground. Returns true on success.
export function placeProp(world, props, ghostIndex, type, x, y, z, r = 0) {
  const def = PROP_DEFS[type];
  if (!def) return false;
  const cells = propCells(type, r);
  for (const [dx, dy, dz] of cells) {
    const cx = x + dx, cy = y + dy, cz = z + dz;
    if (!world.inBounds(cx, cy, cz) || world.get(cx, cy, cz) !== 0) return false;
    if (dy === 0 && world.get(cx, cy - 1, cz) === 0) return false;
  }
  for (const p of props) if (Math.abs(p.x - x) < 2 && Math.abs(p.z - z) < 2 && Math.abs(p.y - y) < 3) return false;
  if (def.solid) for (const [dx, dy, dz] of cells) world.data[world.index(x + dx, y + dy, z + dz)] = ghostIndex(def.mat);
  props.push({ t: type, x, y, z, r });
  return true;
}

// Voxel indices a placed prop occupies (only solid props reserve ghost cells) and the cells it stands on.
export function propIndices(world, p) {
  const def = PROP_DEFS[p.t];
  const cells = [], ground = [];
  if (!def) return { cells, ground, center: [p.x, p.y, p.z] };
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const [dx, dy, dz] of propCells(p.t, p.r)) {
    const x = p.x + dx, y = p.y + dy, z = p.z + dz;
    if (!world.inBounds(x, y, z)) continue;
    if (def.solid) cells.push(world.index(x, y, z));
    if (dy === 0 && world.inBounds(x, y - 1, z)) ground.push(world.index(x, y - 1, z));
    sx += x + 0.5; sy += y; sz += z + 0.5; n++;
  }
  return { cells, ground, center: n ? [sx / n, sy / n, sz / n] : [p.x, p.y, p.z] };
}
