import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelWorld, AIR } from '../shared/voxelWorld.js';
import { VOXEL } from '../shared/constants.js';
import { bytesToBase64, base64ToBytes, int32ToBase64, base64ToInt32 } from '../shared/util.js';

function flatWorld() {
  const w = new VoxelWorld(32, 24, 32);
  w.palette[1] = 0x888888; w.palette[2] = 0x333333; w.hard[2] = 1;
  w.fillBox(0, 0, 0, 31, 0, 31, 2); // indestructible bedrock
  w.fillBox(0, 1, 0, 31, 3, 31, 1); // ground
  return w;
}

test('index / coords round trip', () => {
  const w = new VoxelWorld(16, 8, 12);
  for (const [x, y, z] of [[0, 0, 0], [15, 7, 11], [3, 5, 9]]) {
    assert.deepEqual(w.coords(w.index(x, y, z)), [x, y, z]);
  }
});

test('solidAt treats map edges and below-world as solid', () => {
  const w = new VoxelWorld(8, 8, 8);
  assert.equal(w.solidAt(-1, 3, 3), true);
  assert.equal(w.solidAt(3, -1, 3), true);
  assert.equal(w.solidAt(3, 8, 3), false);
  assert.equal(w.solidAt(3, 3, 3), false);
});

test('raycast hits a wall at the right distance with the right normal', () => {
  const w = flatWorld();
  w.fillBox(20, 4, 0, 20, 10, 31, 1); // wall at x = 20 voxels = 10 m
  const hit = w.raycast(2, 3, 8, 1, 0, 0, 50);
  assert.ok(hit);
  assert.equal(hit.x, 20);
  assert.equal(hit.nx, -1);
  assert.ok(Math.abs(hit.dist - (10 - 2)) < 1e-6);
  assert.equal(w.raycast(2, 3, 8, -1, 0, 0, 0.5), null);
});

test('raycast straight down hits the ground surface', () => {
  const w = flatWorld();
  const hit = w.raycast(5, 6, 5, 0, -1, 0, 20);
  assert.equal(hit.y, 3);
  assert.ok(Math.abs(hit.py - 4 * VOXEL) < 1e-6);
});

test('carve is deterministic and never removes indestructible voxels', () => {
  const a = flatWorld(), b = flatWorld();
  const ra = a.carve(10, 2, 10, 4.4);
  const rb = b.carve(10, 2, 10, 4.4);
  assert.ok(ra.length > 50);
  assert.deepEqual(ra, rb);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) assert.equal(a.get(x, 0, z), 2);
  for (const i of ra) assert.equal(a.data[i], AIR);
});

test('carve reports the removed materials', () => {
  const w = flatWorld();
  const colors = [];
  const removed = w.carve(10, 3, 10, 3, colors);
  assert.equal(colors.length, removed.length);
  assert.ok(colors.every((c) => c === 1));
});

test('RLE encoding round trips the grid exactly', () => {
  const w = flatWorld();
  w.fillBox(4, 4, 4, 9, 14, 9, 1);
  w.carve(6, 8, 6, 3);
  const bytes = w.encodeRLE();
  const copy = new VoxelWorld(32, 24, 32);
  copy.decodeRLE(base64ToBytes(bytesToBase64(bytes)));
  assert.deepEqual(copy.data, w.data);
});

test('base64 helpers round trip binary data', () => {
  const bytes = new Uint8Array(1000).map((_, i) => (i * 37) & 255);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  const ints = Int32Array.from([0, 1, -5, 123456789, 2 ** 31 - 1]);
  assert.deepEqual(base64ToInt32(int32ToBase64(ints)), ints);
});
