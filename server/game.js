// Authoritative match simulation: movement, weapons, rockets, destruction, crushing,
// lag-compensated hitscan, respawns, rounds and map rotation.

import {
  DT, TICK_RATE, SNAPSHOT_EVERY, HISTORY_TICKS, VOXEL, PLAYER, RIFLE, ROCKET, CRUSH,
  ROUND_SECONDS, INTERMISSION_SECONDS, RESPAWN_SECONDS, SPAWN_PROTECT_SECONDS, KILL_HEAL,
  MAX_HEALTH, BTN, WEAPON, MAP_ROTATION,
} from '../shared/constants.js';
import { generateMap, MAP_INFO } from '../shared/maps.js';
import { FallingCluster } from '../shared/voxelWorld.js';
import { createMoveState, stepPlayer, applyImpulse, overlapsAt } from '../shared/physics.js';
import { createWeaponState, resetWeapons, stepWeapons, shotSpread, addBloom, applySpread } from '../shared/weapons.js';
import { encodeSnapshot, PF } from '../shared/protocol.js';
import { dirFromYawPitch, bytesToBase64, int32ToBase64 } from '../shared/util.js';
import { nearestStandable } from './nav.js';
import { propIndices } from '../shared/props.js';

const MAX_QUEUED_INPUTS = 120;
// Each player may apply one input per tick of REAL time, with up to half a second of catch-up.
// Counting real time (not server ticks) matters when the server itself stutters, e.g. when the game and
// the server share a busy laptop: otherwise every hitch leaves inputs queued for good, latency climbs and
// the queue finally overflows, so moves get dropped and the player snaps to a different spot.
const INPUT_BUDGET_CAP = 30;

export function createPlayer(id, name, isBot, conn = null) {
  return {
    id, name, isBot, conn,
    color: (id - 1) % 10,
    state: 'idle',
    move: createMoveState(),
    yaw: 0, pitch: 0,
    health: MAX_HEALTH,
    kills: 0, deaths: 0, streak: 0,
    weapons: createWeaponState(),
    inputQueue: [],
    lastSeq: 0,
    inputBudget: 0,
    renderTick: 0,
    respawnTick: 0,
    protectUntil: 0,
    history: new Float32Array(HISTORY_TICKS * 4),
    lastFireTick: -100,
    lastRocketTick: -1000,
    ping: 0,
    brain: null,
    events: [],
    lastDamager: 0,
    lastDamageTick: -1000,
  };
}

// Ray vs axis aligned box, returns entry distance or -1.
function rayBox(ox, oy, oz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], mn = [minx, miny, minz], mx = [maxx, maxy, maxz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < mn[a] || o[a] > mx[a]) return -1;
    } else {
      let t1 = (mn[a] - o[a]) / d[a], t2 = (mx[a] - o[a]) / d[a];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

export class Game {
  constructor(room) {
    this.room = room;
    this.players = room.players;
    this.tick = 0;
    this.rockets = [];
    this.clusters = [];
    this.broadcast = [];
    this.nextRocketId = 1;
    this.nextClusterId = 1;
    this.nextBoomId = 1;
    this.state = 'playing';
    this.roundEndTick = 0;
    this.nextRoundTick = 0;
    this.map = null;
    this.world = null;
    this.mapName = null;
    this.rotationIndex = 0;
    this.stats = { kills: 0, rockets: 0, booms: 0, voxelsDestroyed: 0, collapses: 0, crushKills: 0 };
    this.clock = null;      // () => ms; set by the room so input budgets follow real time
    this.lastClock = null;
  }

  // ------------------------------------------------------------ map / round flow

  loadMap(name, seed = (Math.random() * 1e9) >>> 0) {
    const m = generateMap(name, seed);
    this.map = m;
    this.world = m.world;
    this.mapName = m.name;
    const ri = MAP_ROTATION.indexOf(m.name);
    if (ri >= 0) this.rotationIndex = ri;
    this.rockets = [];
    this.clusters = [];
    this.props = (m.props || []).map((p, i) => ({ ...p, id: i, alive: true, ...propIndices(m.world, p) }));
    this.state = 'playing';
    this.roundEndTick = this.tick + ROUND_SECONDS * TICK_RATE;
    this.mapPayload = null;
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.streak = 0;
      p.inputQueue.length = 0;
      if (p.isBot) this.spawn(p);
      else { p.state = 'loading'; this.sendMap(p); }
    }
  }

  nextMapName() {
    const rot = MAP_ROTATION;
    if (this.room.settings.rotation === false) return this.mapName;
    return rot[(this.rotationIndex + 1) % rot.length];
  }

  endRound() {
    this.state = 'intermission';
    this.nextRoundTick = this.tick + INTERMISSION_SECONDS * TICK_RATE;
    const standings = this.standings();
    const next = this.nextMapName();
    this.emit({ t: 'round', s: 'end', winner: standings[0]?.id ?? 0, standings, next, nextName: MAP_INFO[next].display, secs: INTERMISSION_SECONDS });
    for (const p of this.players.values()) { p.inputQueue.length = 0; }
    this.rockets.length = 0;
  }

  standings() {
    return [...this.players.values()]
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id)
      .map((p) => ({ id: p.id, name: p.name, k: p.kills, d: p.deaths, bot: p.isBot }));
  }

  buildMapPayload() {
    if (this.mapPayload && this.mapPayload.rev === this.world.revision && !this.clusters.length) return this.mapPayload.msg;
    const w = this.world;
    const msg = {
      t: 'map',
      name: this.mapName,
      display: this.map.display,
      seed: this.map.seed,
      size: [w.sx, w.sy, w.sz],
      palette: Array.from(w.palette.subarray(0, 256)),
      hard: Array.from(w.hard),
      mat: Array.from(w.material),
      ghost: Array.from(w.ghost),
      props: (this.props || []).map((p) => ({ t: p.t, x: p.x, y: p.y, z: p.z, r: p.r, id: p.id, dead: !p.alive })),
      grid: bytesToBase64(w.encodeRLE()),
      theme: this.map.theme,
      tick: this.tick,
      roundEnd: this.roundEndTick,
      state: this.state,
      clusters: this.clusters.map((c) => ({
        id: c.id, owner: c.owner, i: int32ToBase64(c.indices), c: bytesToBase64(c.colors), off: c.offset, vel: c.vel, drop: c.drop,
      })),
    };
    this.mapPayload = { rev: w.revision, msg };
    return msg;
  }

  sendMap(p) {
    if (!p.conn) return;
    p.conn.send(this.buildMapPayload());
    p.conn.send(this.rosterMessage());
  }

  rosterMessage() {
    return {
      t: 'roster',
      host: this.room.hostId,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.isBot, k: p.kills, d: p.deaths })),
    };
  }

  // A human finished loading the map and is ready to play.
  playerReady(p) {
    if (p.state !== 'loading') return;
    if (this.state === 'intermission') { p.state = 'dead'; p.respawnTick = this.nextRoundTick; return; }
    this.spawn(p);
  }

  addPlayer(p) {
    p.kills = 0; p.deaths = 0;
    if (p.isBot) this.spawn(p);
    else { p.state = 'loading'; this.sendMap(p); }
    this.emitRoster();
  }

  removePlayer(p) {
    for (const r of this.rockets) if (r.owner === p.id) r.owner = 0;
    this.emitRoster();
  }

  emitRoster() { this.emit(this.rosterMessage()); }

  // ------------------------------------------------------------ spawning

  pickSpawn(p) {
    const w = this.world;
    const others = [...this.players.values()].filter((q) => q !== p && q.state === 'alive');
    let best = null, bestScore = -Infinity;
    for (const s of this.map.spawns) {
      const vx = Math.floor(s[0] / VOXEL), vy = Math.floor(s[1] / VOXEL), vz = Math.floor(s[2] / VOXEL);
      const ok = nearestStandable(w, vx, vy, vz, 4);
      if (!ok) continue;
      const pos = [(ok[0] + 0.5) * VOXEL, ok[1] * VOXEL + 0.001, (ok[2] + 0.5) * VOXEL];
      let minD = 80;
      for (const q of others) minD = Math.min(minD, Math.hypot(q.move.x - pos[0], q.move.y - pos[1], q.move.z - pos[2]));
      const score = minD + Math.random() * 10;
      if (score > bestScore) { bestScore = score; best = pos; }
    }
    if (!best) {
      // fallback: top of a random column
      for (let i = 0; i < 200 && !best; i++) {
        const x = 4 + Math.floor(Math.random() * (w.sx - 8)), z = 4 + Math.floor(Math.random() * (w.sz - 8));
        const y = w.topSolid(x, z) + 1;
        if (y > 0 && w.standable(x, y, z)) best = [(x + 0.5) * VOXEL, y * VOXEL + 0.001, (z + 0.5) * VOXEL];
      }
    }
    return best || [w.sx * VOXEL / 2, (w.sy - 4) * VOXEL, w.sz * VOXEL / 2];
  }

  spawn(p) {
    const pos = this.pickSpawn(p);
    const m = p.move;
    m.x = pos[0]; m.y = pos[1]; m.z = pos[2];
    m.vx = 0; m.vy = 0; m.vz = 0; m.onGround = false;
    const cx = this.world.sx * VOXEL / 2, cz = this.world.sz * VOXEL / 2;
    p.yaw = Math.atan2(-(cx - m.x), -(cz - m.z));
    p.pitch = 0;
    p.health = MAX_HEALTH;
    resetWeapons(p.weapons);
    p.state = 'alive';
    p.protectUntil = this.tick + Math.round(SPAWN_PROTECT_SECONDS * TICK_RATE);
    p.history.fill(0);
    if (p.brain) p.brain.onSpawn();
    this.emit({ t: 'spawn', id: p.id, p: [m.x, m.y, m.z], yaw: p.yaw });
  }

  // ------------------------------------------------------------ events

  emit(ev) { this.broadcast.push(ev); }
  emitTo(p, ev) { if (p.conn) p.events.push(ev); }

  flushEvents() {
    const shared = this.broadcast;
    for (const p of this.players.values()) {
      if (!p.conn) { p.events.length = 0; continue; }
      if (!shared.length && !p.events.length) continue;
      const list = p.events.length ? shared.concat(p.events) : shared;
      p.conn.send({ t: 'ev', l: list });
      p.events.length = 0;
    }
    this.broadcast = [];
  }

  // ------------------------------------------------------------ main loop

  update() {
    this.tick++;
    let gain = 1;
    if (this.clock) {
      const now = this.clock();
      gain = this.lastClock === null ? 1 : Math.min(INPUT_BUDGET_CAP, Math.max(0, (now - this.lastClock) * TICK_RATE / 1000));
      this.lastClock = now;
    }
    if (this.state === 'playing') {
      for (const p of this.players.values()) {
        if (p.brain) p.inputQueue.push(p.brain.think(this.tick));
        p.inputBudget = Math.min(INPUT_BUDGET_CAP, p.inputBudget + (p.brain ? 1 : gain));
        while (p.inputQueue.length && p.inputBudget >= 1) {
          p.inputBudget -= 1;
          this.processInput(p, p.inputQueue.shift());
        }
        if (p.inputQueue.length > MAX_QUEUED_INPUTS) p.inputQueue.splice(0, p.inputQueue.length - MAX_QUEUED_INPUTS);
        if (p.state === 'dead' && this.tick >= p.respawnTick) this.spawn(p);
        this.recordHistory(p);
      }
      this.updateRockets();
      this.updateClusters();
      if (this.tick >= this.roundEndTick) this.endRound();
    } else if (this.state === 'intermission') {
      for (const p of this.players.values()) {
        // acknowledge inputs so client prediction does not pile up
        while (p.inputQueue.length) p.lastSeq = p.inputQueue.shift().seq;
      }
      this.updateClusters();
      if (this.tick >= this.nextRoundTick) this.loadMap(this.nextMapName());
    }
    if (this.tick % SNAPSHOT_EVERY === 0) this.sendSnapshot();
    if (this.tick % TICK_RATE === 0) this.sendScores();
    this.flushEvents();
  }

  recordHistory(p) {
    const o = (this.tick % HISTORY_TICKS) * 4;
    p.history[o] = p.move.x; p.history[o + 1] = p.move.y; p.history[o + 2] = p.move.z; p.history[o + 3] = p.state === 'alive' ? 1 : 0;
  }

  historyAt(p, tick) {
    if (tick > this.tick || tick <= this.tick - HISTORY_TICKS) return null;
    const o = (tick % HISTORY_TICKS) * 4;
    if (p.history[o + 3] !== 1) return null;
    return [p.history[o], p.history[o + 1], p.history[o + 2]];
  }

  processInput(p, inp) {
    p.lastSeq = inp.seq;
    if (p.state !== 'alive') return;
    p.yaw = inp.yaw; p.pitch = inp.pitch;
    p.renderTick = inp.renderTick;
    stepPlayer(p.move, inp.buttons, inp.yaw, this.world, DT);
    if (p.move.y < -6) { this.kill(p, p.lastDamageTick > this.tick - 300 ? p.lastDamager : 0, WEAPON.FALL, false); return; }
    const res = stepWeapons(p.weapons, inp.buttons);
    if (res & 1) this.fireRifle(p, inp);
    if (res & 2) this.fireRocket(p, inp);
    if ((inp.buttons & (BTN.FIRE | BTN.ROCKET)) && this.tick < p.protectUntil) p.protectUntil = this.tick;
  }

  // ------------------------------------------------------------ weapons

  fireRifle(p, inp) {
    const m = p.move;
    const ox = m.x, oy = m.y + PLAYER.eye, oz = m.z;
    const base = dirFromYawPitch(inp.yaw, inp.pitch);
    const cone = shotSpread(p.weapons, m);
    const dir = applySpread(base, cone, p.id, p.weapons.shots);
    addBloom(p.weapons);
    p.lastFireTick = this.tick;
    const wall = this.world.raycast(ox, oy, oz, dir[0], dir[1], dir[2], RIFLE.range);
    let maxDist = wall ? wall.dist : RIFLE.range;
    let victim = null, head = false;
    const rewind = Math.max(this.tick - HISTORY_TICKS + 1, Math.min(this.tick, inp.renderTick || this.tick));
    for (const q of this.players.values()) {
      if (q === p || q.state !== 'alive') continue;
      const pos = this.historyAt(q, rewind) || [q.move.x, q.move.y, q.move.z];
      const [qx, qy, qz] = pos;
      const hh = PLAYER.headHalf + 0.03;
      const th = rayBox(ox, oy, oz, dir[0], dir[1], dir[2], qx - hh, qy + PLAYER.headBottom, qz - hh, qx + hh, qy + PLAYER.headTop, qz + hh);
      const bw = PLAYER.radius + 0.06;
      const tb = rayBox(ox, oy, oz, dir[0], dir[1], dir[2], qx - bw, qy, qz - bw, qx + bw, qy + PLAYER.headBottom, qz + bw);
      let t = -1, isHead = false;
      if (th >= 0 && (tb < 0 || th <= tb)) { t = th; isHead = true; } else if (tb >= 0) { t = tb; }
      if (t >= 0 && t < maxDist) { maxDist = t; victim = q; head = isHead; }
    }
    const ex = ox + dir[0] * maxDist, ey = oy + dir[1] * maxDist, ez = oz + dir[2] * maxDist;
    const ev = { t: 'shot', id: p.id, o: [r3(ox), r3(oy), r3(oz)], e: [r3(ex), r3(ey), r3(ez)] };
    if (victim) {
      ev.h = victim.id;
      let dmg = RIFLE.damage * (head ? RIFLE.headMultiplier : 1);
      if (maxDist > RIFLE.falloffStart) {
        const f = Math.min(1, (maxDist - RIFLE.falloffStart) / (RIFLE.falloffEnd - RIFLE.falloffStart));
        dmg *= 1 - f * (1 - RIFLE.falloffMin);
      }
      this.damage(victim, dmg, p, WEAPON.RIFLE, head, [ox, oy, oz]);
    } else if (wall) {
      ev.n = [wall.nx, wall.ny, wall.nz];
      ev.v = wall.v;
    }
    this.emit(ev);
  }

  fireRocket(p, inp) {
    const m = p.move;
    const dir = dirFromYawPitch(inp.yaw, inp.pitch);
    const rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
    const ex = m.x, ey = m.y + PLAYER.eye, ez = m.z;
    let sx = ex + dir[0] * 0.45 + rx * 0.16, sy = ey + dir[1] * 0.45 - 0.1, sz = ez + dir[2] * 0.45 + rz * 0.16;
    p.lastRocketTick = this.tick;
    this.stats.rockets++;
    // if the muzzle is inside a wall, explode at the wall surface immediately
    const block = this.world.raycast(ex, ey, ez, dir[0], dir[1], dir[2], 0.75);
    const r = {
      id: (this.nextRocketId++) & 0xffff, owner: p.id, seq: inp.seq,
      x: sx, y: sy, z: sz, vx: dir[0] * ROCKET.speed, vy: dir[1] * ROCKET.speed, vz: dir[2] * ROCKET.speed,
      born: this.tick, dead: false,
    };
    this.emit({ t: 'rocket', id: r.id, owner: p.id, seq: inp.seq, p: [r3(sx), r3(sy), r3(sz)], v: [r3(r.vx), r3(r.vy), r3(r.vz)] });
    if (block) {
      this.explode(block.px - dir[0] * 0.1, block.py - dir[1] * 0.1, block.pz - dir[2] * 0.1, p.id, null, r.id);
      return;
    }
    this.rockets.push(r);
  }

  updateRockets() {
    const w = this.world;
    for (const r of this.rockets) {
      if (r.dead) continue;
      const speed = Math.hypot(r.vx, r.vy, r.vz);
      const dx = r.vx / speed, dy = r.vy / speed, dz = r.vz / speed;
      const step = speed * DT;
      const hit = w.raycast(r.x, r.y, r.z, dx, dy, dz, step);
      let tHit = hit ? hit.dist : Infinity;
      let victim = null;
      const age = this.tick - r.born;
      for (const q of this.players.values()) {
        if (q.state !== 'alive') continue;
        if (q.id === r.owner && age < 15) continue;
        const pad = ROCKET.hitRadius;
        const t = rayBox(r.x, r.y, r.z, dx, dy, dz, q.move.x - PLAYER.radius - pad, q.move.y - pad, q.move.z - PLAYER.radius - pad,
          q.move.x + PLAYER.radius + pad, q.move.y + PLAYER.headTop + pad, q.move.z + PLAYER.radius + pad);
        if (t >= 0 && t <= step && t < tHit) { tHit = t; victim = q; }
      }
      if (tHit <= step) {
        const back = victim ? 0 : 0.08;
        this.explode(r.x + dx * (tHit - back), r.y + dy * (tHit - back), r.z + dz * (tHit - back), r.owner, victim, r.id);
        r.dead = true;
        continue;
      }
      r.x += r.vx * DT; r.y += r.vy * DT; r.z += r.vz * DT;
      const outside = r.x < -2 || r.z < -2 || r.x > w.sx * VOXEL + 2 || r.z > w.sz * VOXEL + 2 || r.y > w.sy * VOXEL + 30;
      if (age > ROCKET.lifetime * TICK_RATE || outside) {
        r.dead = true;
        this.emit({ t: 'rgone', id: r.id });
      }
    }
    this.rockets = this.rockets.filter((r) => !r.dead);
  }

  explode(x, y, z, ownerId, directVictim, rocketId = 0) {
    const owner = this.players.get(ownerId) || null;
    this.stats.booms++;
    for (const q of this.players.values()) {
      if (q.state !== 'alive') continue;
      const cx = q.move.x, cy = q.move.y + 0.9, cz = q.move.z;
      const dx = cx - x, dy = cy - y, dz = cz - z;
      const d = Math.hypot(dx, dy, dz);
      const isDirect = q === directVictim;
      if (d > ROCKET.radius && !isDirect) continue;
      const f = isDirect ? 1 : Math.max(0, 1 - d / ROCKET.radius);
      let dmg = ROCKET.minDamage + (ROCKET.damage - ROCKET.minDamage) * f;
      if (isDirect) dmg += ROCKET.directHitBonus;
      if (!isDirect && !this.world.clearLine(x, y, z, cx, cy, cz) && !this.world.clearLine(x, y, z, cx, q.move.y + 1.6, cz)) dmg *= 0.5;
      const self = q.id === ownerId;
      if (self) dmg *= ROCKET.selfDamageMultiplier;
      let nx = dx, ny = dy, nz = dz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      ny += ROCKET.upBias;
      const nl2 = Math.hypot(nx, ny, nz);
      const k = ROCKET.knockback * (0.25 + 0.75 * f) * (self ? ROCKET.selfKnockMultiplier : 1);
      applyImpulse(q.move, (nx / nl2) * k, (ny / nl2) * k, (nz / nl2) * k);
      this.damage(q, dmg, owner, WEAPON.ROCKET, false, [x, y, z]);
    }
    // destruction
    const w = this.world;
    const cx = Math.floor(x / VOXEL), cy = Math.floor(y / VOXEL), cz = Math.floor(z / VOXEL);
    const rv = ROCKET.carveRadius / VOXEL;
    const removed = w.carve(cx, cy, cz, rv);
    this.stats.voxelsDestroyed += removed.length;
    const clusterEvents = [];
    if (removed.length) {
      // pieces cut off from the ground fall; then buildings left standing on too little (stairs, one
      // column, a sky bridge) come down too
      const drops = [];
      for (const idx of w.findFloatingClusters(removed)) drops.push([idx, w.extract(idx)]);
      for (const { fall, crush } of w.findWeakStructures(removed)) {
        if (crush.length) drops.push([crush, w.extract(crush), true]);
        if (fall.length) drops.push([fall, w.extract(fall)]);
      }
      // blocks left dangling off a wall around the crater crumble too
      const r = Math.ceil(rv) + 3;
      const dang = w.findDangling(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r);
      if (dang.length) { const idx = Int32Array.from(dang); drops.push([idx, w.extract(idx), true]); }
      for (const [idx, colors, crumble] of drops) {
        const id = this.nextClusterId++;
        if (crumble || idx.length < CRUSH.minClusterForFall) {
          clusterEvents.push({ id, i: int32ToBase64(idx), d: 1 });
          this.stats.voxelsDestroyed += idx.length;
          continue;
        }
        const c = new FallingCluster(id, w, idx, colors, ownerId);
        this.clusters.push(c);
        this.stats.collapses++;
        clusterEvents.push({ id, i: int32ToBase64(idx) });
      }
    }
    this.emit({ t: 'boom', id: this.nextBoomId++, r: rocketId, owner: ownerId, p: [r3(x), r3(y), r3(z)], c: [cx, cy, cz], rv, cl: clusterEvents, n: removed.length });
    this.checkProps(x, y, z);
  }

  // Props break when a blast goes off next to them, or when their voxels / the ground under them are removed.
  // Their invisible collision voxels are cleared on every machine via the 'props' event.
  checkProps(ex, ey, ez) {
    if (!this.props || !this.props.length) return;
    const w = this.world;
    const gone = [];
    for (const p of this.props) {
      if (!p.alive) continue;
      let broken = false;
      if (ex !== undefined) {
        const d = Math.hypot(p.center[0] * VOXEL - ex, (p.center[1] + 0.5) * VOXEL - ey, p.center[2] * VOXEL - ez);
        if (d < 2.6) broken = true;
      }
      if (!broken) for (const i of p.cells) if (!w.ghost[w.data[i]]) { broken = true; break; }
      if (!broken) for (const i of p.ground) if (w.data[i] === 0) { broken = true; break; }
      if (!broken) continue;
      p.alive = false;
      for (const i of p.cells) if (w.ghost[w.data[i]]) w.setIndex(i, 0);
      gone.push(p.id);
    }
    if (gone.length) { w.revision++; this.emit({ t: 'props', gone }); }
  }

  updateClusters() {
    if (!this.clusters.length) return;
    const w = this.world;
    for (const c of this.clusters) {
      const landed = c.step(w, DT);
      if (c.vel > CRUSH.minSpeed && this.state === 'playing') {
        for (const q of this.players.values()) {
          if (q.state !== 'alive') continue;
          const m = q.move;
          const x0 = Math.floor((m.x - PLAYER.radius) / VOXEL), x1 = Math.floor((m.x + PLAYER.radius) / VOXEL);
          const y0 = Math.floor(m.y / VOXEL), y1 = Math.floor((m.y + PLAYER.height) / VOXEL);
          const z0 = Math.floor((m.z - PLAYER.radius) / VOXEL), z1 = Math.floor((m.z + PLAYER.radius) / VOXEL);
          if (x1 < c.min[0] || x0 > c.max[0] || z1 < c.min[2] || z0 > c.max[2]) continue;
          let hit = false;
          for (let y = y0; y <= y1 && !hit; y++) for (let z = z0; z <= z1 && !hit; z++) for (let x = x0; x <= x1 && !hit; x++) if (c.occupies(x, y, z)) hit = true;
          if (!hit) continue;
          const last = c.lastHit.get(q.id) ?? -1;
          if (last >= 0 && c.age - last < CRUSH.cooldown) continue;
          c.lastHit.set(q.id, c.age);
          const dmg = CRUSH.baseDamage + CRUSH.speedDamage * c.vel;
          m.vy = Math.min(m.vy, -c.vel * 0.8);
          const owner = this.players.get(c.owner) || null;
          const before = q.state;
          this.damage(q, dmg, owner, WEAPON.CRUSH, false, [m.x, m.y + 3, m.z]);
          if (before === 'alive' && q.state === 'dead') this.stats.crushKills++;
        }
      }
      if (landed) {
        const placed = c.settle(w);
        this.emit({ t: 'settle', id: c.id, d: c.drop });
        // what is left after the impact may hang in the air (holes from shattering, landing on one edge):
        // loose bits crumble, bigger loose pieces fall again
        const cl = [];
        for (const idx of w.findFloatingClusters(placed)) {
          const colors = w.extract(idx);
          const id = this.nextClusterId++;
          if (idx.length < CRUSH.minClusterForFall) { cl.push({ id, i: int32ToBase64(idx), d: 1 }); continue; }
          this.clusters.push(new FallingCluster(id, w, idx, colors, c.owner));
          cl.push({ id, i: int32ToBase64(idx) });
        }
        // and bits left dangling off the pile by one face crumble
        const dang = w.findDangling(c.min[0] - 1, c.min[1] - c.drop - 1, c.min[2] - 1, c.max[0] + 1, c.max[1] - c.drop + 1, c.max[2] + 1);
        if (dang.length) { const idx = Int32Array.from(dang); w.extract(idx); cl.push({ id: this.nextClusterId++, i: int32ToBase64(idx), d: 1 }); }
        if (cl.length) this.emit({ t: 'drop', owner: c.owner, cl });
        this.checkProps();
        // free anyone the rubble landed on
        for (const q of this.players.values()) if (q.state === 'alive' && overlapsAt(w, q.move.x, q.move.y, q.move.z)) q.move.vy = Math.max(q.move.vy, 0);
      }
    }
    this.clusters = this.clusters.filter((c) => !c.landed);
  }

  // ------------------------------------------------------------ damage

  damage(q, amount, attacker, weapon, head, from) {
    if (q.state !== 'alive' || this.state !== 'playing') return;
    if (this.tick < q.protectUntil) return;
    if (attacker && attacker.isBot && attacker.brain && attacker !== q) amount *= attacker.brain.d.damage ?? 1;
    amount = Math.max(1, Math.round(amount));
    q.health -= amount;
    if (attacker && attacker !== q) { q.lastDamager = attacker.id; q.lastDamageTick = this.tick; }
    this.emitTo(q, { t: 'dmg', from: attacker ? attacker.id : 0, a: amount, p: from.map(r3), w: weapon });
    const killed = q.health <= 0;
    if (attacker && attacker !== q) this.emitTo(attacker, { t: 'hit', v: q.id, a: amount, h: head ? 1 : 0, k: killed ? 1 : 0, w: weapon });
    if (q.brain) q.brain.onDamaged(attacker);
    if (killed) {
      let killer = attacker;
      if ((!killer || killer === q) && weapon !== WEAPON.ROCKET && q.lastDamageTick > this.tick - 300) killer = this.players.get(q.lastDamager) || killer;
      this.kill(q, killer ? killer.id : 0, weapon, head);
    }
  }

  kill(victim, killerId, weapon, head) {
    if (victim.state !== 'alive') return;
    victim.state = 'dead';
    victim.health = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.respawnTick = this.tick + RESPAWN_SECONDS * TICK_RATE;
    const killer = killerId && killerId !== victim.id ? this.players.get(killerId) : null;
    if (killer) {
      killer.kills++;
      killer.streak++;
      if (killer.state === 'alive') {
        const before = killer.health;
        killer.health = Math.min(MAX_HEALTH, killer.health + KILL_HEAL);
        this.emitTo(killer, { t: 'heal', a: killer.health - before });
      }
    }
    this.stats.kills++;
    const m = victim.move;
    this.emit({ t: 'kill', k: killer ? killer.id : 0, v: victim.id, w: weapon, h: head ? 1 : 0, s: killer ? killer.streak : 0, f: [r3(m.vx), r3(m.vy), r3(m.vz)], p: [r3(m.x), r3(m.y), r3(m.z)] });
    if (victim.brain) victim.brain.onDeath();
  }

  // ------------------------------------------------------------ networking

  sendSnapshot() {
    const players = [];
    for (const p of this.players.values()) {
      if (p.state === 'idle') continue;
      const w = p.weapons, m = p.move;
      let flags = 0;
      if (p.state === 'alive') flags |= PF.ALIVE;
      if (m.onGround) flags |= PF.GROUND;
      if (this.tick - p.lastFireTick <= SNAPSHOT_EVERY) flags |= PF.FIRING;
      if (this.tick - p.lastRocketTick < 45) flags |= PF.ROCKET;
      if (w.reload > 0) flags |= PF.RELOADING;
      if (this.tick < p.protectUntil) flags |= PF.PROTECTED;
      if (p.isBot) flags |= PF.BOT;
      players.push({
        id: p.id, flags, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz, yaw: p.yaw, pitch: p.pitch,
        health: p.health, lastSeq: p.lastSeq, ammo: w.ammo, rockets: w.rockets, reload: w.reload,
        rocketRegen: w.rocketRegen, rocketCd: w.rocketCd, fireCd: w.fireCd, spread: w.spread,
      });
    }
    const buf = encodeSnapshot({ tick: this.tick, players, rockets: this.rockets.map((r) => ({ id: r.id, owner: r.owner, x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, vz: r.vz })) });
    for (const p of this.players.values()) if (p.conn && p.state !== 'idle') p.conn.sendBinary(buf);
  }

  sendScores() {
    const secs = this.state === 'playing' ? Math.max(0, (this.roundEndTick - this.tick) / TICK_RATE) : Math.max(0, (this.nextRoundTick - this.tick) / TICK_RATE);
    const msg = {
      t: 'scores', tick: this.tick, state: this.state, secs: Math.round(secs), map: this.mapName,
      l: [...this.players.values()].map((p) => [p.id, p.kills, p.deaths, p.ping | 0]),
    };
    for (const p of this.players.values()) if (p.conn) p.conn.send(msg);
  }
}

function r3(v) { return Math.round(v * 1000) / 1000; }
