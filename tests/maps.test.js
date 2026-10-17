import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, MAP_NAMES } from '../shared/maps.js';
import { VOXEL, MAP_ROTATION } from '../shared/constants.js';
import { findPath } from '../server/nav.js';

test('four maps exist and match the rotation', () => {
  assert.equal(MAP_NAMES.length, 4);
  assert.deepEqual([...MAP_NAMES].sort(), [...MAP_ROTATION].sort());
  assert.ok(MAP_NAMES.includes('skyline'));
});

for (const name of MAP_NAMES) {
  test(`${name}: deterministic generation, bedrock, spawns and destructible structures`, () => {
    const a = generateMap(name, 42), b = generateMap(name, 42);
    assert.deepEqual(a.world.data, b.world.data);
    const w = a.world;
    // indestructible bedrock everywhere
    for (let x = 0; x < w.sx; x += 7) for (let z = 0; z < w.sz; z += 7) assert.equal(w.hard[w.get(x, 0, z)], 1);
    // plenty of standable spawn points
    assert.ok(a.spawns.length >= 16, `${a.spawns.length} spawns`);
    for (const s of a.spawns) assert.ok(w.standable(Math.floor(s[0] / VOXEL), Math.round(s[1] / VOXEL), Math.floor(s[2] / VOXEL)));
    // everything inside the arena above the bedrock is destructible
    let solid = 0, soft = 0;
    for (let y = 1; y < w.sy; y++) for (let z = 1; z < w.sz - 1; z++) for (let x = 1; x < w.sx - 1; x++) {
      const v = w.data[w.index(x, y, z)];
      if (v) { solid++; if (!w.hard[v]) soft++; }
    }
    assert.equal(soft, solid);
    // tall buildings exist
    let tall = 0;
    for (let x = 0; x < w.sx; x += 2) for (let z = 0; z < w.sz; z += 2) if (w.topSolid(x, z) > 18) tall++;
    assert.ok(tall > 50, `${tall} tall columns`);
    // theme is complete
    for (const k of ['skyTop', 'skyHorizon', 'fog', 'sun', 'sunDir', 'hemiSky']) assert.ok(a.theme[k] !== undefined, k);
  });
}

test('A* navigation finds paths between spawns', () => {
  for (const name of MAP_NAMES) {
    const m = generateMap(name, 5);
    const w = m.world;
    let found = 0;
    for (let i = 0; i < 6; i++) {
      const s = m.spawns[i], g = m.spawns[m.spawns.length - 1 - i];
      const path = findPath(w, [Math.floor(s[0] / VOXEL), Math.round(s[1] / VOXEL), Math.floor(s[2] / VOXEL)], [Math.floor(g[0] / VOXEL), Math.round(g[1] / VOXEL), Math.floor(g[2] / VOXEL)], 20000);
      if (path && path.length > 1) {
        const end = path[path.length - 1];
        if (Math.abs(end[0] - Math.floor(g[0] / VOXEL)) <= 3 && Math.abs(end[2] - Math.floor(g[2] / VOXEL)) <= 3) found++;
      }
    }
    assert.ok(found >= 3, `${name}: ${found}/6 paths reached their goal`);
  }
});
