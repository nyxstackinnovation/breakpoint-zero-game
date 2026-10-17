import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelWorld } from '../shared/voxelWorld.js';
import { createMoveState, stepPlayer, overlapsAt, applyImpulse } from '../shared/physics.js';
import { DT, BTN, PLAYER, VOXEL } from '../shared/constants.js';

function arena() {
  const w = new VoxelWorld(48, 32, 48);
  w.palette[1] = 0x999999;
  w.fillBox(0, 0, 0, 47, 3, 47, 1); // floor top surface at y = 4 voxels = 2.0 m
  return w;
}

const run = (s, w, buttons, yaw, ticks) => { for (let i = 0; i < ticks; i++) stepPlayer(s, buttons, yaw, w, DT); return s; };

test('player falls and lands on the floor', () => {
  const w = arena();
  const s = createMoveState(10, 8, 10);
  run(s, w, 0, 0, 120);
  assert.equal(s.onGround, true);
  assert.ok(Math.abs(s.y - 2.0) < 0.01, `y=${s.y}`);
  assert.equal(overlapsAt(w, s.x, s.y, s.z), false);
});

test('walking forward reaches walk speed and is blocked by walls', () => {
  const w = arena();
  w.fillBox(0, 4, 30, 47, 12, 30, 1); // wall at z = 30 voxels = 15 m
  const s = createMoveState(10, 2.0001, 5);
  run(s, w, 0, 0, 10);
  // yaw 0 faces -Z; turn around (yaw = PI) to walk toward +Z
  run(s, w, BTN.FORWARD, Math.PI, 30);
  assert.ok(Math.hypot(s.vx, s.vz) > PLAYER.walkSpeed * 0.9);
  run(s, w, BTN.FORWARD, Math.PI, 120);
  assert.ok(s.z < 15 - PLAYER.radius + 0.01, `z=${s.z}`);
  assert.ok(s.z > 15 - PLAYER.radius - 0.05);
});

test('automatic step-up onto a one voxel ledge, but not a two voxel wall', () => {
  const w = arena();
  w.fillBox(0, 4, 24, 47, 4, 47, 1); // 1 voxel step starting at z = 12 m
  const s = createMoveState(5, 2.0001, 10);
  run(s, w, BTN.FORWARD, Math.PI, 90);
  assert.ok(s.z > 13, 'climbed the step');
  assert.ok(Math.abs(s.y - 2.5) < 0.02, `y=${s.y}`);
  const w2 = arena();
  w2.fillBox(0, 4, 24, 47, 5, 47, 1); // 2 voxel ledge
  const s2 = createMoveState(5, 2.0001, 10);
  run(s2, w2, BTN.FORWARD, Math.PI, 90);
  assert.ok(s2.z < 12, 'blocked by the higher ledge');
});

test('jump apex matches v^2 / 2g', () => {
  const w = arena();
  const s = createMoveState(10, 2.0001, 10);
  run(s, w, 0, 0, 5);
  let maxY = s.y;
  stepPlayer(s, BTN.JUMP, 0, w, DT);
  for (let i = 0; i < 80; i++) { stepPlayer(s, 0, 0, w, DT); maxY = Math.max(maxY, s.y); }
  const expected = (PLAYER.jumpVelocity ** 2) / (2 * PLAYER.gravity);
  assert.ok(Math.abs(maxY - 2.0 - expected) < 0.12, `apex ${maxY - 2.0} vs ${expected}`);
  assert.equal(s.onGround, true);
});

test('ceilings stop upward motion', () => {
  const w = arena();
  w.fillBox(0, 9, 0, 47, 9, 47, 1); // ceiling 2.5 m above the floor
  const s = createMoveState(10, 2.0001, 10);
  run(s, w, 0, 0, 3);
  stepPlayer(s, BTN.JUMP, 0, w, DT);
  let maxY = 0;
  for (let i = 0; i < 60; i++) { stepPlayer(s, 0, 0, w, DT); maxY = Math.max(maxY, s.y + PLAYER.height); }
  assert.ok(maxY <= 9 * VOXEL + 1e-3);
});

test('rocket impulse launches the player (rocket jump)', () => {
  const w = arena();
  const s = createMoveState(10, 2.0001, 10);
  run(s, w, 0, 0, 3);
  applyImpulse(s, 0, 14, 0);
  let maxY = 0;
  for (let i = 0; i < 120; i++) { stepPlayer(s, 0, 0, w, DT); maxY = Math.max(maxY, s.y); }
  assert.ok(maxY > 5.5, `apex ${maxY}`);
});

test('simulation is deterministic for identical inputs', () => {
  const w = arena();
  w.fillBox(20, 4, 0, 21, 6, 47, 1);
  const a = createMoveState(10, 3, 10), b = createMoveState(10, 3, 10);
  const inputs = [];
  for (let i = 0; i < 400; i++) inputs.push([(i % 50 < 25 ? BTN.FORWARD : BTN.RIGHT) | (i % 37 === 0 ? BTN.JUMP : 0), (i * 0.013) % 6.28]);
  for (const [bt, yaw] of inputs) { stepPlayer(a, bt, yaw, w, DT); stepPlayer(b, bt, yaw, w, DT); }
  assert.deepEqual(a, b);
});

test('a player buried by settling rubble is pushed out on top', () => {
  const w = arena();
  const s = createMoveState(10, 2.0001, 10);
  w.fillBox(18, 4, 18, 22, 7, 22, 1); // rubble landed on the player
  stepPlayer(s, 0, 0, w, DT);
  assert.equal(overlapsAt(w, s.x, s.y, s.z), false);
  assert.ok(s.y >= 4.0 - 1e-3);
});
