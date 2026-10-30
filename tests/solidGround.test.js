import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.js';
import { VOXEL } from '../shared/constants.js';

test('rockets leave no craters in the ground but still break buildings', () => {
  const g = new Game({ players: new Map(), settings: { rotation: true }, hostId: 0 });
  g.loadMap('downtown', 7);
  const w = g.world, sx = w.sx;
  const below = (i) => { const [x, y, z] = w.coords(i); return y < w.terrainTop[z * sx + x]; };
  const count = (ground) => { let n = 0; for (let i = 0; i < w.size; i++) { const v = w.data[i]; if (v && !w.ghost[v] && below(i) === ground) n++; } return n; };
  let wall = -1, road = -1;
  for (let i = 0; i < w.size && (wall < 0 || road < 0); i++) {
    const v = w.data[i]; if (!v || w.ghost[v]) continue;
    const [x, y, z] = w.coords(i);
    if (x < 10 || z < 10 || x > sx - 10 || z > w.sz - 10) continue;
    if (wall < 0 && !below(i) && y > 10 && !w.hard[v]) wall = i;
    if (road < 0 && below(i) && !w.get(x, y + 1, z) && !w.get(x, y + 2, z)) road = i;
  }
  const g0 = count(true), b0 = count(false);
  for (const i of [wall, road, road]) { const [x, y, z] = w.coords(i); g.explode((x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL, 0, null, 0); }
  assert.equal(count(true), g0, 'ground untouched');
  assert.ok(count(false) < b0, 'building damaged');
});
