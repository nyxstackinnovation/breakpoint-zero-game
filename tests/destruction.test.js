import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelWorld, FallingCluster, AIR } from '../shared/voxelWorld.js';
import { DT, VOXEL, WEAPON, CRUSH } from '../shared/constants.js';
import { Game, createPlayer } from '../server/game.js';

function baseWorld() {
  const w = new VoxelWorld(40, 40, 40);
  w.palette[1] = 0xaaaaaa; w.palette[2] = 0x222222; w.hard[2] = 1;
  w.fillBox(0, 0, 0, 39, 0, 39, 2);
  w.fillBox(0, 1, 0, 39, 3, 39, 1);
  return w;
}

test('cutting a tower at its base leaves the top floating', () => {
  const w = baseWorld();
  w.fillBox(18, 4, 18, 21, 20, 21, 1); // 4x4 tower, 17 tall
  const removed = [];
  for (let z = 18; z <= 21; z++) for (let x = 18; x <= 21; x++) { removed.push(w.index(x, 6, z)); w.set(x, 6, z, AIR); }
  const clusters = w.findFloatingClusters(removed);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 4 * 4 * (20 - 6));
  // the stump below the cut is still anchored
  for (const i of clusters[0]) assert.ok(w.coords(i)[1] > 6);
});

test('a partially cut structure that still touches the ground does not fall', () => {
  const w = baseWorld();
  w.fillBox(18, 4, 18, 21, 20, 21, 1);
  const removed = [];
  for (let z = 18; z <= 21; z++) for (let x = 18; x <= 20; x++) { removed.push(w.index(x, 6, z)); w.set(x, 6, z, AIR); }
  assert.equal(w.findFloatingClusters(removed).length, 0);
});

test('overhang connected sideways to an anchored column stays up', () => {
  const w = baseWorld();
  w.fillBox(10, 4, 10, 10, 15, 10, 1);   // column
  w.fillBox(11, 15, 10, 16, 15, 10, 1);  // beam
  w.fillBox(16, 10, 10, 16, 14, 10, 1);  // hanging part
  const removed = [w.index(16, 9, 10)];
  assert.equal(w.findFloatingClusters(removed).length, 0);
  // cutting the beam drops the hanging part
  w.set(12, 15, 10, AIR);
  const c = w.findFloatingClusters([w.index(12, 15, 10)]);
  assert.equal(c.length, 1);
  assert.equal(c[0].length, 4 + 5);
});

test('falling clusters drop under gravity and settle on the floor', () => {
  const w = baseWorld();
  w.fillBox(5, 15, 5, 7, 17, 7, 1);
  const idx = w.findFloatingClusters([w.index(5, 14, 5)]);
  assert.equal(idx.length, 1);
  const colors = w.extract(idx[0]);
  const c = new FallingCluster(1, w, idx[0], colors, 0);
  let steps = 0;
  while (!c.step(w, DT) && steps < 1000) steps++;
  assert.ok(c.landed);
  assert.equal(c.drop, 15 - 4); // bottom lands on the ground surface (y = 4)
  const placed = c.settle(w);
  const shattered = idx[0].length - placed.length;
  assert.ok(placed.length > 0 && shattered >= 0);
  for (const i of placed) assert.notEqual(w.data[i], AIR);
  // identical shatter pattern on another machine
  const c2 = new FallingCluster(1, w, idx[0], colors, 0);
  for (let k = 0; k < idx[0].length; k++) assert.equal(c.shatters(k), c2.shatters(k));
});

function testRoom() {
  const players = new Map();
  return { players, settings: { rotation: true }, hostId: 0 };
}

function setupGame(buildFn) {
  const room = testRoom();
  const g = new Game(room);
  g.loadMap('skyline', 1);
  const w = g.world;
  // replace the map with a controlled test arena
  w.data.fill(0);
  const bedrock = 1, mat = 2;
  w.palette[bedrock] = 0x222222; w.hard[bedrock] = 1;
  w.palette[mat] = 0xbbbbbb; w.hard[mat] = 0;
  w.fillBox(0, 0, 0, w.sx - 1, 0, w.sz - 1, bedrock);
  w.fillBox(0, 1, 0, w.sx - 1, 3, w.sz - 1, mat);
  g.map.spawns = [[10, 2.001, 10], [20, 2.001, 20], [30, 2.001, 30]];
  buildFn(w, mat);
  return g;
}

test('a collapsing slab crushes the player beneath it and credits the attacker', () => {
  // slab held up by a single pillar; the victim stands under the slab
  const g = setupGame((w, mat) => {
    w.fillBox(40, 4, 40, 41, 9, 41, mat);    // short pillar
    w.fillBox(36, 10, 36, 52, 11, 52, mat);  // slab
  });
  const attacker = createPlayer(1, 'A', false, null);
  const victim = createPlayer(2, 'V', false, null);
  g.players.set(1, attacker); g.players.set(2, victim);
  g.spawn(attacker); g.spawn(victim);
  attacker.move.x = 10; attacker.move.y = 2.001; attacker.move.z = 10;
  victim.move.x = 25.2; victim.move.y = 2.001; victim.move.z = 25.2; // under the slab (36..52 voxels = 18..26 m)
  victim.protectUntil = 0; attacker.protectUntil = 0;
  // blow out the pillar from the side
  g.explode(20.5, 3.4, 20.5, attacker.id, null);
  assert.ok(g.clusters.length >= 1, 'slab should start falling');
  const before = victim.deaths;
  for (let i = 0; i < 240 && g.clusters.length; i++) g.update();
  assert.equal(g.clusters.length, 0, 'slab should have settled');
  assert.equal(victim.deaths, before + 1, 'victim should be crushed');
  assert.equal(attacker.kills, 1, 'attacker gets the crush kill');
  assert.ok(g.stats.crushKills >= 1);
});

test('crushing is reported as its own weapon type', () => {
  assert.equal(WEAPON.CRUSH, 3);
  assert.ok(CRUSH.baseDamage + CRUSH.speedDamage * 10 > 100);
  assert.ok(VOXEL > 0);
});
