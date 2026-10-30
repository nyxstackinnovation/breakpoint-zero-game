import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelWorld } from '../shared/voxelWorld.js';
import { stepPlayer, createMoveState } from '../shared/physics.js';
import { BTN, DT, VOXEL } from '../shared/constants.js';
import { generateMap } from '../shared/maps.js';

function runToward(world, s, yaw, seconds) {
  for (let i = 0; i < seconds / DT; i++) stepPlayer(s, BTN.FORWARD | BTN.JUMP, yaw, world, DT);
  return s;
}

test('a player can jump and pull himself out of a 2 m deep pit', () => {
  const w = new VoxelWorld(40, 30, 40);
  w.palette[1] = 0x888888; w.hard[1] = 1;
  w.fillBox(0, 0, 0, 39, 9, 39, 1);          // ground top at y = 10 voxels
  w.fillBox(16, 6, 16, 23, 9, 23, 0);        // 4-voxel (2 m) deep pit
  const s = createMoveState(20 * VOXEL, 6 * VOXEL + 0.001, 20 * VOXEL);
  runToward(w, s, -Math.PI / 2, 4);          // toward +x
  assert.ok(s.y >= 10 * VOXEL - 0.01, `still in the pit at y=${s.y.toFixed(2)}`);
  assert.ok(s.x > 24 * VOXEL);
});

test('harbor: out of the water and back onto the quay', () => {
  const w = generateMap('harbor', 3).world;
  const s = createMoveState(30 * VOXEL, 2 * VOXEL + 0.001, 45 * VOXEL);
  runToward(w, s, -Math.PI / 2, 4);
  assert.ok(s.y >= 6 * VOXEL - 0.01, `stuck at y=${s.y.toFixed(2)} x=${(s.x / VOXEL).toFixed(1)}`);
});
