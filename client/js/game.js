// Client game controller: map loading, client-side prediction with server reconciliation,
// interpolated remote players, event-driven effects/destruction, camera and rendering.

import * as THREE from 'three';
import {
  DT, TICK_RATE, INTERP_DELAY_TICKS, VOXEL, PLAYER, RIFLE, ROCKET, PLAYER_COLORS, WEAPON, MAX_HEALTH,
} from '/shared/constants.js';
import { VoxelWorld, FallingCluster } from '/shared/voxelWorld.js';
import { createMoveState, copyMoveState, stepPlayer } from '/shared/physics.js';
import { createWeaponState, copyWeaponState, stepWeapons, shotSpread, addBloom, applySpread, resetWeapons } from '/shared/weapons.js';
import { encodeInputs, PF } from '/shared/protocol.js';
import { base64ToBytes, base64ToInt32, dirFromYawPitch, lerpAngle, clamp } from '/shared/util.js';
import { VoxelRenderer } from './voxels.js';
import { Effects } from './effects.js';
import { ViewModel } from './viewmodel.js';
import { settings, QUALITY } from './settings.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

export class ClientGame {
  constructor(app) {
    this.app = app;
    this.net = app.net;
    this.audio = app.audio;
    this.input = app.input;
    this.hud = app.hud;
    this.sm = app.sceneManager;
    this.scene = this.sm.scene;
    this.camera = this.sm.camera;
    this.factory = app.characterFactory;
    this.quality = QUALITY[settings.get('quality')] || QUALITY.medium;
    this.voxels = new VoxelRenderer(this.scene);
    this.voxels.setShadows(this.quality.shadows);
    this.effects = new Effects(this.scene, this.quality);
    this.vm = new ViewModel();
    this.vm.scene.environment = this.sm.envMap;
    this.vm.scene.environmentIntensity = 0.8;
    this.sm.onResize = (w, h) => this.vm.resize(w / h);
    this.vm.resize(window.innerWidth / window.innerHeight);
    this.characters = new Map();
    this.players = new Map();
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.world = null;
    this.myId = 0;
    this.snapshots = [];
    this.pred = createMoveState();
    this.prev = createMoveState();
    this.wpn = createWeaponState();
    this.pending = [];
    this.outbox = [];
    this.seq = 0;
    this.acc = 0;
    this.yaw = 0; this.pitch = 0;
    this.alive = false;
    this.health = MAX_HEALTH;
    this.correction = new THREE.Vector3();
    this.clockOffset = null;
    this.clusters = new Map();
    this.rocketAlias = new Map();
    this.eventQueue = [];
    this.serverState = 'playing';
    this.roundEndTick = 0;
    this.nextRoundAt = 0;
    this.roundData = null;
    this.timerSecs = 0;
    this.shake = 0;
    this.recoilDebt = 0;
    this.lastShotTime = 0;
    this.camY = null;
    this.stepDist = 0;
    this.deathInfo = null;
    this.deathCam = null;
    this.lastLocalTick = 0;
    this.frameCount = 0;
    this.mouseDX = 0; this.mouseDY = 0;
    this.loadToken = 0;
    this.respawnAt = 0;
    this.myHits = 0;
    this.lastPing = 0;
  }

  // ------------------------------------------------------------------ setup / teardown

  setMyId(id) { this.myId = id; this.vm.setColor(id); }

  async loadMap(msg) {
    const token = ++this.loadToken;
    this.state = 'loading';
    this.app.showLoading(msg.display);
    this.effects.clear();
    for (const id of [...this.clusters.keys()]) this.voxels.removeFalling(id);
    this.clusters.clear();
    this.eventQueue = [];
    await new Promise((r) => setTimeout(r, 30));
    const [sx, sy, sz] = msg.size;
    const world = new VoxelWorld(sx, sy, sz);
    world.palette.set(msg.palette.slice(0, 256));
    world.hard.set(msg.hard.slice(0, 256));
    world.decodeRLE(base64ToBytes(msg.grid));
    this.world = world;
    this.sm.applyTheme(msg.theme, [sx * VOXEL, sy * VOXEL, sz * VOXEL]);
    this.vm.setLighting(msg.theme);
    this.voxels.setWorld(world);
    await this.voxels.buildAll((p) => this.app.loadingProgress(p));
    if (token !== this.loadToken) return;
    for (const c of msg.clusters || []) {
      const idx = base64ToInt32(c.i);
      const colors = base64ToBytes(c.c);
      const fc = new FallingCluster(c.id, world, idx, colors, c.owner);
      fc.offset = c.off; fc.vel = c.vel; fc.drop = c.drop;
      this.clusters.set(c.id, fc);
      this.voxels.addFalling(fc);
    }
    this.effects.setWorld(world);
    for (const ch of this.characters.values()) ch.world = world;
    this.mapName = msg.display;
    this.mapId = msg.name;
    this.roundEndTick = msg.roundEnd;
    this.serverState = msg.state;
    this.snapshots = [];
    this.pending = [];
    this.alive = false;
    this.clockOffset = msg.tick - performance.now() * TICK_RATE / 1000;
    this.hud.showRoundEnd(false);
    this.hud.showDeath(false);
    this.state = 'playing';
    const queued = this.eventQueue;
    this.eventQueue = [];
    for (const list of queued) this.onEvents(list);
    this.net.send({ t: 'ready' });
    this.app.showHud();
  }

  stop() {
    this.loadToken++;
    this.state = 'idle';
    for (const ch of this.characters.values()) this.scene.remove(ch.root);
    this.characters.clear();
    this.players.clear();
    this.hud.clearPlates();
    this.effects.clear();
    this.voxels.clear();
    this.hud.showDeath(false);
    this.hud.showRoundEnd(false);
    this.hud.showScoreboard(false);
    const id = this.myId;
    this.reset();
    this.myId = id;
  }

  applyQuality() {
    this.quality = QUALITY[settings.get('quality')] || QUALITY.medium;
    this.sm.setQuality(this.quality);
    this.voxels.setShadows(this.quality.shadows);
    this.effects.setQuality(this.quality);
    for (const ch of this.characters.values()) ch.root.traverse((o) => { if (o.isMesh) o.castShadow = this.quality.characterShadows; });
  }

  // ------------------------------------------------------------------ roster / players

  onRoster(msg) {
    const seen = new Set();
    for (const p of msg.players) {
      seen.add(p.id);
      let info = this.players.get(p.id);
      if (!info) { info = { id: p.id, k: 0, d: 0, ping: 0 }; this.players.set(p.id, info); }
      info.name = p.name; info.color = p.color; info.bot = p.bot;
      if (p.k !== undefined) { info.k = p.k; info.d = p.d; }
      if (p.id !== this.myId && !this.characters.has(p.id)) {
        const ch = this.factory.create(p.id, p.name, this.quality);
        ch.world = this.world;
        ch.setVisible(false);
        this.characters.set(p.id, ch);
        this.scene.add(ch.root);
      }
    }
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id)) {
        this.players.delete(id);
        const ch = this.characters.get(id);
        if (ch) { this.scene.remove(ch.root); ch.dispose?.(); this.characters.delete(id); }
        this.hud.removePlate(id);
      }
    }
  }

  onScores(msg) {
    for (const [id, k, d, ping] of msg.l) {
      const p = this.players.get(id);
      if (p) { p.k = k; p.d = d; p.ping = ping; }
    }
    this.serverState = msg.state;
    this.timerSecs = msg.secs;
    if (msg.state === 'playing' && this.roundData) { this.roundData = null; this.hud.showRoundEnd(false); }
    const me = this.players.get(this.myId);
    if (me) this.lastPing = me.ping;
  }

  name(id) { return this.players.get(id)?.name ?? `#${id}`; }

  // ------------------------------------------------------------------ clock

  serverTickNow() { return performance.now() * TICK_RATE / 1000 + (this.clockOffset ?? 0); }
  renderTick() { return this.serverTickNow() - INTERP_DELAY_TICKS; }

  // ------------------------------------------------------------------ snapshots

  onSnapshot(s) {
    if (this.state !== 'playing') return;
    const now = performance.now();
    const sample = s.tick - now * TICK_RATE / 1000;
    if (this.clockOffset === null || Math.abs(sample - this.clockOffset) > 20) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * (sample > this.clockOffset ? 0.2 : 0.04);
    s.map = new Map();
    for (const p of s.players) s.map.set(p.id, p);
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && s.tick <= last.tick) return;
    this.snapshots.push(s);
    while (this.snapshots.length > 40) this.snapshots.shift();
    // rockets we have not seen (e.g. fired before we joined)
    for (const r of s.rockets) {
      if (r.owner === this.myId) continue;
      if (!this.effects.rockets.has(r.id) && !this.rocketAlias.has(r.id) && !this.seenRocket?.has(r.id)) {
        this.effects.spawnRocket(r.id, _v.set(r.x, r.y, r.z), _v2.set(r.vx, r.vy, r.vz), r.owner);
      }
    }
    this.reconcile(s);
  }

  reconcile(s) {
    const me = s.map.get(this.myId);
    if (!me || !this.world) return;
    this.health = me.health;
    const alive = (me.flags & PF.ALIVE) !== 0;
    if (!alive) {
      if (this.alive) { this.alive = false; }
      this.pending.length = 0;
      return;
    }
    if (!this.alive) {
      this.alive = true;
      this.hud.showDeath(false);
      this.pred.x = me.x; this.pred.y = me.y; this.pred.z = me.z;
      copyMoveState(this.prev, this.pred);
      this.correction.set(0, 0, 0);
    }
    while (this.pending.length && this.pending[0].seq <= me.lastSeq) this.pending.shift();
    const ox = this.pred.x, oy = this.pred.y, oz = this.pred.z;
    const P = this.pred;
    P.x = me.x; P.y = me.y; P.z = me.z; P.vx = me.vx; P.vy = me.vy; P.vz = me.vz;
    P.onGround = (me.flags & PF.GROUND) !== 0;
    const shots = this.wpn.shots;
    copyWeaponState(this.wpn, { ammo: me.ammo, reload: me.reload, fireCd: me.fireCd, rockets: me.rockets, rocketRegen: me.rocketRegen, rocketCd: me.rocketCd, spread: me.spread, shots });
    for (const inp of this.pending) {
      stepPlayer(P, inp.buttons, inp.yaw, this.world, DT);
      const res = stepWeapons(this.wpn, inp.buttons);
      if (res & 1) addBloom(this.wpn);
    }
    this.wpn.shots = shots;
    const dx = ox - P.x, dy = oy - P.y, dz = oz - P.z;
    const err = Math.hypot(dx, dy, dz);
    if (err > 3) { this.correction.set(0, 0, 0); copyMoveState(this.prev, P); }
    else if (err > 1e-4) {
      this.correction.x += dx; this.correction.y += dy; this.correction.z += dz;
      this.prev.x -= dx; this.prev.y -= dy; this.prev.z -= dz;
    }
  }

  sampleRemote(id, rt) {
    const snaps = this.snapshots;
    if (!snaps.length) return null;
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      const s = snaps[i];
      if (s.tick <= rt && s.map.has(id)) { a = s; b = snaps[i + 1] && snaps[i + 1].map.has(id) ? snaps[i + 1] : null; break; }
    }
    if (!a) {
      const first = snaps.find((s) => s.map.has(id));
      return first ? { ...first.map.get(id) } : null;
    }
    const pa = a.map.get(id);
    if (!b) {
      // extrapolate briefly
      const dt = Math.min(12, rt - a.tick) / TICK_RATE;
      return { ...pa, x: pa.x + pa.vx * dt, y: pa.y + Math.max(-2, pa.vy) * dt * 0.5, z: pa.z + pa.vz * dt };
    }
    const pb = b.map.get(id);
    const t = clamp((rt - a.tick) / (b.tick - a.tick), 0, 1);
    // teleport (respawn) -> no interpolation
    if (Math.abs(pb.x - pa.x) + Math.abs(pb.z - pa.z) > 8 || ((pa.flags ^ pb.flags) & PF.ALIVE)) return { ...pb };
    return {
      ...pb,
      x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, z: pa.z + (pb.z - pa.z) * t,
      vx: pa.vx + (pb.vx - pa.vx) * t, vy: pa.vy + (pb.vy - pa.vy) * t, vz: pa.vz + (pb.vz - pa.vz) * t,
      yaw: lerpAngle(pa.yaw, pb.yaw, t), pitch: pa.pitch + (pb.pitch - pa.pitch) * t,
      flags: t < 0.5 ? pa.flags : pb.flags,
    };
  }

  // ------------------------------------------------------------------ local simulation

  localTick() {
    const playing = this.serverState === 'playing' && !this.app.paused;
    const buttons = this.alive && playing ? this.input.buttons() : 0;
    const inp = { seq: ++this.seq, buttons, yaw: this.yaw, pitch: this.pitch, renderTick: Math.floor(this.renderTick()) };
    this.outbox.push(inp);
    if (!this.alive || this.serverState !== 'playing') return;
    copyMoveState(this.prev, this.pred);
    const wasGround = this.pred.onGround, vyBefore = this.pred.vy;
    stepPlayer(this.pred, buttons, this.yaw, this.world, DT);
    if (!wasGround && this.pred.onGround && vyBefore < -5) { this.audio.land(true); this.vm.land(-vyBefore); }
    if (wasGround && !this.pred.onGround && this.pred.vy > 5) this.audio.jump();
    const res = stepWeapons(this.wpn, buttons);
    if (res & 1) this.localFire();
    if (res & 2) this.localRocket(inp);
    if (res & 4) { this.vm.reload(); this.audio.reload(); }
    this.pending.push(inp);
    if (this.pending.length > 240) this.pending.shift();
  }

  eyePos(out) { return out.set(this.pred.x, this.pred.y + PLAYER.eye, this.pred.z); }

  localFire() {
    const eye = this.eyePos(new THREE.Vector3());
    const base = dirFromYawPitch(this.yaw, this.pitch);
    const cone = shotSpread(this.wpn, this.pred);
    const d = applySpread(base, cone, this.myId, this.wpn.shots);
    addBloom(this.wpn);
    const dir = new THREE.Vector3(d[0], d[1], d[2]);
    const hit = this.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, RIFLE.range);
    let dist = hit ? hit.dist : RIFLE.range;
    // predicted player hit (visual only, server decides damage)
    let hitChar = null;
    for (const [id, ch] of this.characters) {
      if (!ch.root.visible || ch.dead) continue;
      const p = ch.root.position;
      const t = rayAabb(eye, dir, p.x - 0.36, p.y, p.z - 0.36, p.x + 0.36, p.y + 1.86, p.z + 0.36);
      if (t >= 0 && t < dist) { dist = t; hitChar = ch; }
    }
    const end = eye.clone().addScaledVector(dir, dist);
    const muzzle = this.vm.muzzleWorld(this.camera, new THREE.Vector3());
    this.vm.fire();
    this.audio.rifle(null, true);
    this.effects.tracer(muzzle, end);
    this.effects.muzzle(muzzle, true);
    if (hitChar) {
      this.effects.blood(end, dir.clone().negate());
    } else if (hit) {
      const n = new THREE.Vector3(hit.nx, hit.ny, hit.nz);
      this.effects.impact(end, n, this.voxels.colorOf(hit.v), this.world.index(hit.x, hit.y, hit.z));
    }
    // recoil
    const kick = RIFLE.recoilPitch * (0.8 + Math.random() * 0.4);
    this.pitch = clamp(this.pitch + kick, -1.55, 1.55);
    this.yaw += (Math.random() - 0.5) * 2 * RIFLE.recoilYaw;
    this.recoilDebt += kick;
    this.lastShotTime = performance.now();
    this.shake = Math.max(this.shake, 0.04);
  }

  localRocket(inp) {
    const dir = dirFromYawPitch(inp.yaw, inp.pitch);
    const rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
    const e = this.eyePos(new THREE.Vector3());
    const pos = new THREE.Vector3(e.x + dir[0] * 0.45 + rx * 0.16, e.y + dir[1] * 0.45 - 0.1, e.z + dir[2] * 0.45 + rz * 0.16);
    const vel = new THREE.Vector3(dir[0], dir[1], dir[2]).multiplyScalar(ROCKET.speed);
    this.effects.spawnRocket(`p${inp.seq}`, pos, vel, this.myId);
    this.vm.fireRocket();
    this.audio.rocketLaunch(null, true);
    this.effects.muzzle(pos, true);
    this.shake = Math.max(this.shake, 0.15);
  }

  // ------------------------------------------------------------------ events

  onEvents(list) {
    if (this.state === 'loading') { this.eventQueue.push(list); return; }
    if (this.state !== 'playing' || !this.world) {
      // roster / round info still matter between maps
      for (const ev of list) if (ev.t === 'roster') this.onRoster(ev);
      return;
    }
    for (const ev of list) {
      try { this.handleEvent(ev); } catch (e) { console.error('event error', ev.t, e); }
    }
  }

  handleEvent(ev) {
    const camPos = this.camera.position;
    switch (ev.t) {
      case 'roster': this.onRoster(ev); break;
      case 'shot': {
        const end = _v.set(ev.e[0], ev.e[1], ev.e[2]).clone();
        const origin = new THREE.Vector3(ev.o[0], ev.o[1], ev.o[2]);
        const dir = end.clone().sub(origin).normalize();
        if (ev.id !== this.myId) {
          const ch = this.characters.get(ev.id);
          const start = ch && ch.root.visible ? ch.muzzleWorld(new THREE.Vector3()) : origin;
          if (ch) ch.fire();
          if (ev.h === this.myId) end.addScaledVector(dir, -1.2);
          this.effects.tracer(start, end);
          this.effects.muzzle(start, false);
          this.audio.rifle(start, false);
          if (!ev.h && ev.n) {
            const n = new THREE.Vector3(ev.n[0], ev.n[1], ev.n[2]);
            const vx = Math.floor((end.x - n.x * 0.05) / VOXEL), vy = Math.floor((end.y - n.y * 0.05) / VOXEL), vz = Math.floor((end.z - n.z * 0.05) / VOXEL);
            this.effects.impact(end, n, this.voxels.colorOf(ev.v), this.world.inBounds(vx, vy, vz) ? this.world.index(vx, vy, vz) : undefined);
            this.audio.impact(end);
          }
        }
        if (ev.h) {
          const victim = this.characters.get(ev.h);
          if (victim) victim.hit();
          if (ev.id !== this.myId && ev.h !== this.myId) this.effects.blood(end, dir.clone().negate());
          if (ev.h !== this.myId) this.audio.flesh(end);
        }
        break;
      }
      case 'rocket': {
        this.seenRocket ??= new Set();
        this.seenRocket.add(ev.id);
        if (this.seenRocket.size > 500) this.seenRocket = new Set([ev.id]);
        if (ev.owner === this.myId) { this.rocketAlias.set(ev.id, `p${ev.seq}`); break; }
        const p = new THREE.Vector3(...ev.p), v = new THREE.Vector3(...ev.v);
        this.effects.spawnRocket(ev.id, p, v, ev.owner);
        this.effects.muzzle(p, false);
        this.audio.rocketLaunch(p, false);
        break;
      }
      case 'rgone': this.removeRocket(ev.id); break;
      case 'boom': this.onBoom(ev); break;
      case 'settle': this.onSettle(ev); break;
      case 'kill': this.onKill(ev); break;
      case 'spawn': {
        if (ev.id === this.myId) {
          this.alive = true;
          const P = this.pred;
          P.x = ev.p[0]; P.y = ev.p[1]; P.z = ev.p[2]; P.vx = P.vy = P.vz = 0; P.onGround = false;
          copyMoveState(this.prev, P);
          this.correction.set(0, 0, 0);
          this.yaw = ev.yaw; this.pitch = 0; this.recoilDebt = 0;
          this.pending.length = 0;
          resetWeapons(this.wpn);
          this.vm.cancelReload();
          this.vm.draw();
          this.hud.showDeath(false);
          this.deathCam = null;
          this.camY = null;
          this.audio.spawn();
        } else {
          const ch = this.characters.get(ev.id);
          if (ch) { ch.respawn(); ch.root.position.set(ev.p[0], ev.p[1], ev.p[2]); }
        }
        break;
      }
      case 'dmg': {
        const from = new THREE.Vector3(...ev.p);
        this.hud.damage(() => {
          const dx = from.x - this.pred.x, dz = from.z - this.pred.z;
          const ang = Math.atan2(-dx, -dz);
          return -(ang - this.yaw);
        });
        this.audio.hurt();
        this.shake = Math.max(this.shake, Math.min(0.5, ev.a / 80));
        break;
      }
      case 'hit': {
        const kind = ev.k ? 2 : ev.h ? 1 : 0;
        this.hud.hitmarker(kind);
        this.audio.hitmarker(kind);
        break;
      }
      case 'heal': this.hud.heal(ev.a); this.audio.heal(); break;
      case 'round': {
        if (ev.s === 'end') {
          this.serverState = 'intermission';
          this.roundData = ev;
          this.nextRoundAt = performance.now() + ev.secs * 1000;
          this.hud.showRoundEnd(true, ev, this.myId);
          this.hud.roundCountdown(ev.secs, ev.nextName);
          this.audio.roundEnd();
          for (const s of ev.standings) { const p = this.players.get(s.id); if (p) { p.k = s.k; p.d = s.d; } }
        }
        break;
      }
      default: break;
    }
    void camPos;
  }

  removeRocket(id) {
    const alias = this.rocketAlias.get(id);
    if (alias) { this.effects.removeRocket(alias); this.rocketAlias.delete(id); }
    this.effects.removeRocket(id);
  }

  onBoom(ev) {
    this.removeRocket(ev.r);
    const w = this.world;
    const p = new THREE.Vector3(ev.p[0], ev.p[1], ev.p[2]);
    const colors = [];
    const removed = w.carve(ev.c[0], ev.c[1], ev.c[2], ev.rv, colors);
    const debris = [];
    const tmp = [0, 0, 0];
    const step = Math.max(1, Math.floor(removed.length / 70));
    for (let i = 0; i < removed.length; i += step) {
      w.coords(removed[i], tmp);
      debris.push({ x: (tmp[0] + 0.5) * VOXEL, y: (tmp[1] + 0.5) * VOXEL, z: (tmp[2] + 0.5) * VOXEL, c: this.voxels.colorOf(colors[i]) });
    }
    this.effects.explosion(p, debris);
    const dist = p.distanceTo(this.camera.position);
    this.audio.explosion(p, dist);
    this.shake = Math.max(this.shake, Math.max(0, 1.1 - dist / 22));
    for (const cl of ev.cl || []) {
      const idx = base64ToInt32(cl.i);
      const cols = w.extract(idx);
      if (cl.d) {
        for (let k = 0; k < idx.length; k++) {
          w.coords(idx[k], tmp);
          this.effects.debris.spawn((tmp[0] + 0.5) * VOXEL, (tmp[1] + 0.5) * VOXEL, (tmp[2] + 0.5) * VOXEL, (Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4, 0.35, this.voxels.colorOf(cols[k]));
        }
        continue;
      }
      const fc = new FallingCluster(cl.id, w, idx, cols, ev.owner);
      this.clusters.set(cl.id, fc);
      this.voxels.addFalling(fc);
      const cx = (fc.min[0] + fc.max[0] + 1) * 0.5 * VOXEL, cz = (fc.min[2] + fc.max[2] + 1) * 0.5 * VOXEL;
      this.audio.crumble(new THREE.Vector3(cx, fc.min[1] * VOXEL, cz), Math.log2(idx.length));
    }
  }

  onSettle(ev) {
    const fc = this.clusters.get(ev.id);
    if (!fc) return;
    const w = this.world;
    fc.settle(w, ev.d);
    this.voxels.removeFalling(ev.id);
    this.clusters.delete(ev.id);
    const shattered = [];
    const n = fc.indices.length;
    const step = Math.max(1, Math.floor(n / 160));
    for (let k = 0; k < n; k += step) {
      if (!fc.shatters(k)) continue;
      shattered.push({ x: (fc.xs[k] + 0.5) * VOXEL, y: (fc.ys[k] - ev.d + 0.5) * VOXEL, z: (fc.zs[k] + 0.5) * VOXEL, c: this.voxels.colorOf(fc.colors[k]) });
    }
    const y = (fc.min[1] - ev.d) * VOXEL;
    this.effects.collapseDust(fc.min[0] * VOXEL, (fc.max[0] + 1) * VOXEL, y, fc.min[2] * VOXEL, (fc.max[2] + 1) * VOXEL, Math.min(90, 12 + n / 40), shattered);
    const c = new THREE.Vector3((fc.min[0] + fc.max[0]) * 0.5 * VOXEL, y, (fc.min[2] + fc.max[2]) * 0.5 * VOXEL);
    this.audio.crumble(c, Math.log2(n) + 2);
    const dist = c.distanceTo(this.camera.position);
    this.shake = Math.max(this.shake, Math.min(1, Math.log2(n) / 10) * Math.max(0, 1 - dist / 40));
  }

  onKill(ev) {
    const killer = this.players.get(ev.k), victim = this.players.get(ev.v);
    if (victim) victim.d++;
    if (killer && ev.k !== ev.v) killer.k++;
    this.hud.killfeed(ev.k, ev.v, ev.w, ev.h, this.myId, (id) => this.name(id));
    const ch = this.characters.get(ev.v);
    if (ch) {
      if (ev.p) ch.root.position.set(ev.p[0], ev.p[1], ev.p[2]);
      ch.die(ev.f || [0, 0, 0], this.world);
    }
    if (ev.v === this.myId) {
      this.alive = false;
      this.deathInfo = { killer: ev.k, weapon: ev.w };
      this.respawnAt = performance.now() + 3000;
      this.deathCam = { pos: this.camera.position.clone(), yaw: this.yaw, t: 0, from: new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z) };
      this.hud.showDeath(true, ev.k && ev.k !== ev.v ? this.name(ev.k) : '', ev.w);
      this.vm.cancelReload();
    }
    if (ev.k === this.myId && ev.v !== this.myId) {
      const streak = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'RAMPAGE', 5: 'UNSTOPPABLE' }[Math.min(ev.s, 5)] || '';
      const extra = ev.w === WEAPON.CRUSH ? 'DEMOLITION KILL' : ev.h ? 'HEADSHOT' : streak;
      this.hud.centerMessage(`ELIMINATED <span style="color:${hex(PLAYER_COLORS[(ev.v - 1) % PLAYER_COLORS.length])}">${escapeHtml(this.name(ev.v))}</span>${extra ? `<small>${extra}</small>` : ''}`);
    }
  }

  // ------------------------------------------------------------------ frame

  frame(dt) {
    if (this.state !== 'playing' || !this.world) return false;
    this.frameCount++;
    // mouse look
    const [mdx, mdy] = this.input.consumeMouse();
    this.mouseDX = mdx; this.mouseDY = mdy;
    if (this.input.locked && this.alive && !this.app.paused) {
      const sens = settings.get('sensitivity') * 0.0022;
      this.yaw -= mdx * sens;
      this.pitch -= mdy * sens * (settings.get('invertY') ? -1 : 1);
      this.pitch = clamp(this.pitch, -1.55, 1.55);
    }
    // recoil recovery
    if (this.recoilDebt > 0 && performance.now() - this.lastShotTime > 140) {
      const r = Math.min(this.recoilDebt, dt * 0.3);
      this.pitch -= r * 0.7;
      this.recoilDebt -= r;
    }
    // fixed-step prediction
    this.acc += Math.min(dt, 0.25);
    let n = 0;
    while (this.acc >= DT && n < 15) { this.localTick(); this.acc -= DT; n++; }
    if (n >= 15) this.acc = 0;
    if (this.outbox.length) {
      this.net.sendBinary(encodeInputs(this.outbox));
      this.outbox.length = 0;
    }
    const alpha = this.acc / DT;
    const decay = Math.exp(-dt * 12);
    this.correction.multiplyScalar(decay);

    // falling chunks (visual simulation, server confirms landing)
    for (const fc of this.clusters.values()) if (!fc.landed) fc.step(this.world, Math.min(dt, 0.05));
    this.voxels.updateFalling();
    this.voxels.update(this.clusters.size ? 14 : 8);

    this.updateCamera(dt, alpha);
    this.updateRemotes(dt);
    this.effects.update(dt, this.camera, this.scene.fog);
    this.sm.update(dt);
    const speed = Math.hypot(this.pred.vx, this.pred.vz);
    this.vm.update(dt, { speed, onGround: this.pred.onGround, mouseDX: mdx, mouseDY: mdy, alive: this.alive && !this.deathCam });
    this.updateHud(dt);
    // audio listener
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const up = _v2.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.audio.updateListener(this.camera.position, fwd, up);
    // footsteps
    if (this.alive && this.pred.onGround && speed > 2.5) {
      this.stepDist += speed * dt;
      if (this.stepDist > 2.3) { this.stepDist = 0; this.audio.footstep(null, true); }
    }
    return true;
  }

  updateCamera(dt, alpha) {
    const cam = this.camera;
    cam.fov = settings.get('fov');
    cam.updateProjectionMatrix();
    const shakeOn = settings.get('shake');
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const sh = shakeOn ? this.shake * this.shake : 0;
    if (this.alive && !this.deathCam) {
      const P = this.pred, Q = this.prev;
      const x = Q.x + (P.x - Q.x) * alpha + this.correction.x;
      const y = Q.y + (P.y - Q.y) * alpha + this.correction.y;
      const z = Q.z + (P.z - Q.z) * alpha + this.correction.z;
      let ey = y + PLAYER.eye;
      // smooth step-ups
      if (this.camY !== null && P.onGround && ey > this.camY && ey - this.camY < 0.7) ey = this.camY + (ey - this.camY) * (1 - Math.exp(-dt * 22));
      this.camY = ey;
      cam.position.set(x + (Math.random() - 0.5) * sh * 0.3, ey + (Math.random() - 0.5) * sh * 0.3, z + (Math.random() - 0.5) * sh * 0.3);
      cam.rotation.set(this.pitch + (Math.random() - 0.5) * sh * 0.05, this.yaw + (Math.random() - 0.5) * sh * 0.05, 0);
    } else if (this.deathCam) {
      const d = this.deathCam;
      d.t += dt;
      const killerCh = this.deathInfo && this.characters.get(this.deathInfo.killer);
      const look = killerCh && killerCh.root.visible && !killerCh.dead ? killerCh.root.position.clone().add(_v3.set(0, 1.2, 0)) : d.from.clone().add(_v3.set(0, 0.3, 0));
      const target = d.from.clone().add(_v3.set(Math.sin(d.yaw) * 3.5, 3.2, Math.cos(d.yaw) * 3.5));
      const k = 1 - Math.exp(-dt * 3);
      d.pos.lerp(target, k);
      cam.position.copy(d.pos);
      cam.lookAt(look);
      const remain = Math.max(0, (this.respawnAt - performance.now()) / 1000);
      this.hud.deathTimer(remain);
    }
  }

  updateRemotes(dt) {
    const rt = this.renderTick();
    const cam = this.camera;
    const showNames = settings.get('showNames');
    const w = window.innerWidth, h = window.innerHeight;
    for (const [id, ch] of this.characters) {
      const s = this.sampleRemote(id, rt);
      if (!s) { ch.setVisible(false); this.hud.updatePlate(id, false); continue; }
      const alive = (s.flags & PF.ALIVE) !== 0;
      if (!alive && !ch.dead) { ch.setVisible(false); this.hud.updatePlate(id, false); continue; }
      if (alive && ch.dead) ch.respawn();
      if (alive && !ch.root.visible) ch.setVisible(true);
      ch.update(dt, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, vx: s.vx, vy: s.vy, vz: s.vz, onGround: (s.flags & PF.GROUND) !== 0, launcher: (s.flags & PF.ROCKET) !== 0 });
      // remote footsteps
      const sp = Math.hypot(s.vx, s.vz);
      if (alive && (s.flags & PF.GROUND) && sp > 3) {
        ch.stepAcc = (ch.stepAcc || 0) + sp * dt;
        if (ch.stepAcc > 2.3) { ch.stepAcc = 0; this.audio.footstep(_v.set(s.x, s.y, s.z), false); }
      }
      // nameplate with health bar
      if (!alive || !showNames) { this.hud.updatePlate(id, false); continue; }
      const head = _v.set(s.x, s.y + 2.15, s.z);
      const dist = head.distanceTo(cam.position);
      if (dist > 55) { this.hud.updatePlate(id, false); continue; }
      if ((this.frameCount + id) % 6 === 0) ch.occluded = !this.world.clearLine(cam.position.x, cam.position.y, cam.position.z, head.x, head.y - 0.4, head.z);
      const ndc = head.clone().project(cam);
      if (ndc.z > 1 || ndc.z < -1 || ch.occluded) { this.hud.updatePlate(id, false); continue; }
      const info = this.players.get(id);
      const color = hex(PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]);
      this.hud.updatePlate(id, true, (ndc.x * 0.5 + 0.5) * w, (-ndc.y * 0.5 + 0.5) * h, info?.name ?? '?', color, s.health, info?.bot, clamp(1.25 - dist / 50, 0.6, 1.1));
    }
  }

  updateHud(dt) {
    let timer = this.timerSecs;
    if (this.serverState === 'playing' && this.roundEndTick) timer = (this.roundEndTick - this.serverTickNow()) / TICK_RATE;
    else if (this.serverState === 'intermission') timer = (this.nextRoundAt - performance.now()) / 1000;
    if (this.roundData) this.hud.roundCountdown(timer, this.roundData.nextName);
    const sorted = [...this.players.values()].sort((a, b) => b.k - a.k || a.d - b.d);
    const rankIdx = sorted.findIndex((p) => p.id === this.myId);
    const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)] || 'th');
    const me = this.players.get(this.myId);
    const rank = rankIdx >= 0 ? `${ord(rankIdx + 1)} / ${sorted.length} · ${me ? me.k : 0} K` : '—';
    this.hud.update(dt, {
      health: this.alive ? this.health : 0, ammo: this.wpn.ammo, reload: this.wpn.reload, rockets: this.wpn.rockets, rocketRegen: this.wpn.rocketRegen,
      spread: this.alive ? shotSpread(this.wpn, this.pred) : 0, timer, mapName: this.mapName || '', rank, alive: this.alive, playing: this.serverState === 'playing',
    });
    if (this.app.scoreboardOpen || this.serverState === 'intermission') {
      this.hud.renderScoreboard(sorted.map((p) => ({ id: p.id, name: p.name, k: p.k, d: p.d, ping: p.ping, bot: p.bot })), this.myId, 'SCOREBOARD', `${this.mapName} · FREE FOR ALL`);
    }
    if (settings.get('showFps')) {
      const st = this.voxels.stats();
      this.hud.perf(`${this.app.fps.toFixed(0)} FPS  ${this.lastPing} ms  ${(st.tris / 1000).toFixed(0)}k tris  calls ${this.sm.renderer.info.render.calls}`);
    } else if (this.frameCount % 30 === 0) this.hud.perf('');
  }

  render() {
    const r = this.sm.renderer;
    r.clear();
    r.render(this.scene, this.camera);
    if (this.alive && !this.deathCam) {
      r.clearDepth();
      r.render(this.vm.scene, this.vm.camera);
    }
  }
}

function rayAabb(o, d, minx, miny, minz, maxx, maxy, maxz) {
  let tmin = 0, tmax = Infinity;
  const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z], MN = [minx, miny, minz], MX = [maxx, maxy, maxz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(D[a]) < 1e-9) { if (O[a] < MN[a] || O[a] > MX[a]) return -1; continue; }
    let t1 = (MN[a] - O[a]) / D[a], t2 = (MX[a] - O[a]) / D[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
