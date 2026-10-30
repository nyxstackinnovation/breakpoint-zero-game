import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, createPlayer } from '../server/game.js';
import { BotBrain } from '../server/bot.js';
import { BTN, TICK_RATE, ROUND_SECONDS, INTERMISSION_SECONDS, RESPAWN_SECONDS, KILL_HEAL, MAX_HEALTH, MAP_ROTATION, WEAPON, RIFLE } from '../shared/constants.js';

function makeGame(map = 'skyline') {
  const room = { players: new Map(), settings: { rotation: true }, hostId: 0 };
  const g = new Game(room);
  g.loadMap(map, 7);
  return g;
}

// flat test arena so line of sight is guaranteed
function flatten(g) {
  const w = g.world;
  w.data.fill(0);
  w.palette[1] = 0x222222; w.hard[1] = 1;
  w.palette[2] = 0xcccccc; w.hard[2] = 0;
  w.fillBox(0, 0, 0, w.sx - 1, 0, w.sz - 1, 1);
  w.fillBox(0, 1, 0, w.sx - 1, 3, w.sz - 1, 2);
}

function addPlayer(g, id, x, z) {
  const p = createPlayer(id, `P${id}`, false, null);
  g.players.set(id, p);
  g.spawn(p);
  p.move.x = x; p.move.y = 2.001; p.move.z = z; p.move.vx = p.move.vy = p.move.vz = 0;
  p.protectUntil = 0;
  return p;
}

let seq = 1000;
const inp = (buttons, yaw = 0, pitch = 0, renderTick = 0) => ({ seq: seq++, buttons, yaw, pitch, renderTick });

test('rifle hits damage the target and kills restore the killer\'s health', () => {
  const g = makeGame();
  flatten(g);
  const a = addPlayer(g, 1, 20, 30);
  const b = addPlayer(g, 2, 20, 20); // 10 m straight ahead (yaw 0 looks toward -Z)
  a.health = 40;
  // aim at chest height
  const pitch = Math.atan2(1.0 - 1.62, 10);
  let ticks = 0;
  while (b.state === 'alive' && ticks < 600) {
    a.inputQueue.push(inp(BTN.FIRE, 0, pitch, g.tick));
    b.inputQueue.push(inp(0));
    g.update();
    ticks++;
  }
  assert.equal(b.state, 'dead');
  assert.equal(a.kills, 1);
  assert.equal(b.deaths, 1);
  assert.equal(a.health, Math.min(MAX_HEALTH, 40 + KILL_HEAL));
  // ~7 body shots at 600 rpm
  assert.ok(ticks < 60, `took ${ticks} ticks`);
});

test('headshots deal double damage', () => {
  const g = makeGame();
  flatten(g);
  const a = addPlayer(g, 1, 20, 30);
  const b = addPlayer(g, 2, 20, 20);
  const pitch = Math.atan2(1.65 - 1.62, 10);
  a.inputQueue.push(inp(BTN.FIRE, 0, pitch, g.tick));
  g.update();
  assert.equal(MAX_HEALTH - b.health, RIFLE.damage * RIFLE.headMultiplier);
});

test('lag compensation rewinds targets to what the shooter saw', () => {
  const g = makeGame();
  flatten(g);
  const a = addPlayer(g, 1, 20, 30);
  const b = addPlayer(g, 2, 20, 20);
  for (let i = 0; i < 10; i++) g.update();
  const seenTick = g.tick;
  // target moves 3 m to the side after the shooter's view tick
  b.move.x = 23;
  for (let i = 0; i < 5; i++) g.update();
  const pitch = Math.atan2(1.0 - 1.62, 10);
  a.inputQueue.push(inp(BTN.FIRE, 0, pitch, seenTick));
  g.update();
  assert.ok(b.health < MAX_HEALTH, 'rewound hit registers');
  const b2h = b.health;
  a.inputQueue.push(...Array.from({ length: 6 }, () => inp(0, 0, pitch, g.tick)));
  for (let i = 0; i < 6; i++) g.update();
  a.inputQueue.push(inp(BTN.FIRE, 0, pitch, g.tick));
  g.update();
  assert.equal(b.health, b2h, 'present-time shot at the old position misses');
});

test('rocket at your feet launches you upward with reduced self damage (rocket jump)', () => {
  const g = makeGame();
  flatten(g);
  const a = addPlayer(g, 1, 20, 20);
  for (let i = 0; i < 5; i++) { a.inputQueue.push(inp(0)); g.update(); }
  a.inputQueue.push(inp(BTN.ROCKET | BTN.JUMP, 0, -1.5, g.tick));
  let maxY = a.move.y;
  for (let i = 0; i < 90; i++) { a.inputQueue.push(inp(0, 0, -1.5)); g.update(); maxY = Math.max(maxY, a.move.y); }
  assert.ok(maxY > 2.0 + 2.5, `rocket jump apex ${maxY}`);
  assert.equal(a.state, 'alive');
  assert.ok(a.health < MAX_HEALTH && a.health > 50, `health ${a.health}`);
});

test('rocket explosions destroy voxels and are broadcast', () => {
  const g = makeGame();
  flatten(g);
  g.world.fillBox(30, 4, 10, 50, 20, 10, 2); // wall 10 voxels ahead
  const a = addPlayer(g, 1, 20, 15);
  a.inputQueue.push(inp(BTN.ROCKET, 0, 0, g.tick));
  const before = g.world.revision;
  let boom = null;
  for (let i = 0; i < 60 && !boom; i++) { g.update(); boom = g.stats.booms; }
  assert.ok(g.stats.booms >= 1);
  assert.ok(g.world.revision > before);
  assert.ok(g.stats.voxelsDestroyed > 40);
});

test('dead players respawn after the respawn delay', () => {
  const g = makeGame();
  flatten(g);
  const a = addPlayer(g, 1, 20, 20);
  g.kill(a, 0, WEAPON.FALL, false);
  assert.equal(a.state, 'dead');
  for (let i = 0; i < RESPAWN_SECONDS * TICK_RATE - 2; i++) g.update();
  assert.equal(a.state, 'dead');
  for (let i = 0; i < 4; i++) g.update();
  assert.equal(a.state, 'alive');
  assert.equal(a.health, MAX_HEALTH);
});

test('rounds last four minutes, then intermission, then the next map in rotation', () => {
  const g = makeGame('skyline');
  addPlayer(g, 1, 20, 20);
  g.players.get(1).kills = 3;
  assert.equal(ROUND_SECONDS, 240);
  for (let i = 0; i < ROUND_SECONDS * TICK_RATE; i++) g.update();
  assert.equal(g.state, 'intermission');
  for (let i = 0; i < INTERMISSION_SECONDS * TICK_RATE + 1; i++) g.update();
  assert.equal(g.state, 'playing');
  assert.equal(g.mapName, MAP_ROTATION[(MAP_ROTATION.indexOf('skyline') + 1) % MAP_ROTATION.length]);
  assert.equal(g.players.get(1).kills, 0, 'scores reset for the new round');
});

test('eight bots play a full minute without errors and land hits', () => {
  for (const diff of ['easy', 'medium', 'hard']) {
    const g = makeGame('downtown');
    for (let id = 1; id <= 8; id++) {
      const p = createPlayer(id, `Bot${id}`, true, null);
      p.brain = new BotBrain(g, p, diff);
      g.players.set(id, p);
      g.spawn(p);
    }
    let dealt = 0;
    const dmg = g.damage.bind(g);
    g.damage = (q, ...rest) => { const hp = q.health; dmg(q, ...rest); dealt += hp - q.health; };
    for (let i = 0; i < TICK_RATE * 60; i++) g.update();
    // bots are deliberately weak, but medium and hard ones still have to fight
    if (diff !== 'easy') assert.ok(dealt > 0, `${diff} bots should hit each other`);
    if (diff === 'hard') assert.ok(g.stats.kills > 0, 'hard bots should get kills');
    for (const p of g.players.values()) {
      assert.ok(Number.isFinite(p.move.x) && Number.isFinite(p.move.y) && Number.isFinite(p.move.z));
    }
  }
});

test('input budget prevents speed hacking', () => {
  const g = makeGame();
  flatten(g);
  const a = addPlayer(g, 1, 20, 40);
  for (let i = 0; i < 600; i++) a.inputQueue.push(inp(BTN.FORWARD, 0));
  for (let i = 0; i < 60; i++) g.update();
  // one second of real time can never move more than ~walk speed plus burst allowance
  assert.ok(40 - a.move.z < 7.2 * 1.4, `moved ${40 - a.move.z}`);
});

test('a stuttering server still applies every input instead of falling behind', () => {
  const g = makeGame();
  flatten(g);
  const a = addPlayer(g, 1, 20, 60);
  let now = 0;
  g.clock = () => now;
  const step = 1000 / TICK_RATE;
  let sent = 0;
  // 10 s of real time; the client sends one input per tick, but the server loses a 150 ms burst every second
  for (let t = 0; t < TICK_RATE * 10; t++) {
    now += step;
    a.inputQueue.push(inp(BTN.FORWARD, 0)); sent++;
    const stalled = t % TICK_RATE < 9;
    if (!stalled) g.update();
  }
  for (let i = 0; i < 40; i++) { now += step; g.update(); }
  assert.ok(a.inputQueue.length <= 2, `queue drained (${a.inputQueue.length} left)`);
  assert.equal(a.lastSeq, a.inputQueue.length ? a.inputQueue[0].seq - 1 : seq - 1, 'no input was skipped');
});
