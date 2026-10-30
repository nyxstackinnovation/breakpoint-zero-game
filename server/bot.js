// Server-side bot AI. Bots produce the same input packets a human client would,
// so they obey identical physics, weapon timing and damage rules.

import { BTN, BOT_DIFFICULTY, PLAYER, VOXEL, ROCKET, RIFLE, TICK_RATE } from '../shared/constants.js';
import { angleDiff, clamp } from '../shared/util.js';
import { findPath } from './nav.js';

export const BOT_NAMES = ['Viper', 'Rook', 'Nova', 'Blitz', 'Echo', 'Havoc', 'Jinx', 'Onyx', 'Talon', 'Vortex', 'Ember', 'Kestrel', 'Static', 'Glitch', 'Mako', 'Rift'];

export class BotBrain {
  constructor(game, player, difficulty = 'medium') {
    this.game = game;
    this.p = player;
    this.setDifficulty(difficulty);
    this.seq = 0;
    this.yaw = player.yaw;
    this.pitch = 0;
    this.target = null;
    this.targetSeenTick = 0;
    this.lastSeenPos = null;
    this.path = null;
    this.pathIndex = 0;
    this.repathTick = 0;
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.burstUntil = 0;
    this.pauseUntil = 0;
    this.stuckCheckTick = 0;
    this.stuckPos = [0, 0, 0];
    this.stuckCount = 0;
    this.wanderUntil = 0;
    this.wanderYaw = 0;
    this.rocketPlanTick = 0;
    this.perceiveOffset = player.id * 3;
    this.noisePhase = Math.random() * 100;
    this.trackTicks = 0;
    this.missOffset = 0;
  }

  setDifficulty(d) {
    this.difficultyName = BOT_DIFFICULTY[d] ? d : 'medium';
    this.d = BOT_DIFFICULTY[this.difficultyName];
  }

  onSpawn() { this.target = null; this.path = null; this.yaw = this.p.yaw; this.pitch = 0; this.repathTick = 0; this.trackTicks = 0; }
  onDeath() { this.target = null; this.path = null; }
  onDamaged(attacker) {
    if (attacker && attacker !== this.p && attacker.state === 'alive' && (!this.target || Math.random() < 0.5)) {
      this.lastSeenPos = [attacker.move.x, attacker.move.y, attacker.move.z];
      if (!this.target) this.repathTick = 0;
    }
  }

  eye(p) { return [p.move.x, p.move.y + PLAYER.eye, p.move.z]; }

  perceive(tick) {
    const me = this.p, w = this.game.world;
    const [ex, ey, ez] = this.eye(me);
    let best = null, bestScore = Infinity;
    for (const q of this.game.players.values()) {
      if (q === me || q.state !== 'alive') continue;
      const dx = q.move.x - ex, dz = q.move.z - ez, dy = q.move.y + 1.2 - ey;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > this.d.viewRange) continue;
      if (!w.clearLine(ex, ey, ez, q.move.x, q.move.y + 1.25, q.move.z) && !w.clearLine(ex, ey, ez, q.move.x, q.move.y + 1.7, q.move.z)) continue;
      const facing = Math.abs(angleDiff(this.yaw, Math.atan2(-dx, -dz)));
      let score = dist + (facing > 1.2 ? 15 : 0);
      if (q === this.target) score -= 12;
      if (score < bestScore) { bestScore = score; best = q; }
    }
    if (best !== this.target) {
      if (best) {
        const dx = best.move.x - ex, dz = best.move.z - ez;
        const facing = Math.abs(angleDiff(this.yaw, Math.atan2(-dx, -dz)));
        this.targetSeenTick = tick + Math.round((this.d.reaction + (facing > 1.2 ? 0.25 : 0)) * TICK_RATE * (0.8 + Math.random() * 0.4));
        this.trackTicks = 0;
      }
      this.target = best;
    }
    if (best) this.lastSeenPos = [best.move.x, best.move.y, best.move.z];
  }

  huntGoal() {
    if (this.lastSeenPos) return this.lastSeenPos;
    let best = null, bd = Infinity;
    const me = this.p.move;
    for (const q of this.game.players.values()) {
      if (q === this.p || q.state !== 'alive') continue;
      const d = Math.hypot(q.move.x - me.x, q.move.z - me.z) + Math.abs(q.move.y - me.y) * 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best ? [best.move.x, best.move.y, best.move.z] : null;
  }

  repath(goal) {
    const me = this.p.move;
    const s = [Math.floor(me.x / VOXEL), Math.floor((me.y + 0.05) / VOXEL), Math.floor(me.z / VOXEL)];
    const g = [Math.floor(goal[0] / VOXEL), Math.floor((goal[1] + 0.05) / VOXEL), Math.floor(goal[2] / VOXEL)];
    this.path = findPath(this.game.world, s, g, this.difficultyName === 'hard' ? 9000 : 6000);
    this.pathIndex = this.path && this.path.length > 1 ? 1 : 0;
  }

  nextWaypoint() {
    if (!this.path || this.pathIndex >= this.path.length) return null;
    const me = this.p.move;
    while (this.pathIndex < this.path.length) {
      const [wx, wy, wz] = this.path[this.pathIndex];
      const px = (wx + 0.5) * VOXEL, pz = (wz + 0.5) * VOXEL, py = wy * VOXEL;
      const dh = Math.hypot(px - me.x, pz - me.z);
      if (dh < 0.42 && Math.abs(py - me.y) < 1.2) { this.pathIndex++; continue; }
      return [px, py, pz];
    }
    return null;
  }

  think(tick) {
    const me = this.p, m = me.move, d = this.d;
    let buttons = 0;
    if (me.state !== 'alive') return this.packet(0, tick);
    if ((tick + this.perceiveOffset) % 8 === 0) this.perceive(tick);
    if (this.target && this.target.state !== 'alive') { this.target = null; this.lastSeenPos = null; }

    let wishX = 0, wishZ = 0;
    let desiredYaw = this.yaw, desiredPitch = 0;
    let lookAtMove = true;
    const t = this.target;

    if (t) {
      const [ex, ey, ez] = this.eye(me);
      const dx = t.move.x - ex, dz = t.move.z - ez;
      const dist = Math.hypot(dx, dz);
      this.trackTicks++;
      // aim
      const wantHead = Math.random() < d.headshot * 0.05 ? true : (this.aimHead ?? false);
      if (tick % 90 === 0) this.aimHead = Math.random() < d.headshot;
      let ay = t.move.y + (wantHead ? 1.65 : 1.15);
      let tx = t.move.x, tz = t.move.z;
      const usingRocket = this.rocketPlanTick > tick;
      if (usingRocket) {
        const tt = dist / ROCKET.speed;
        tx += t.move.vx * tt * d.lead; tz += t.move.vz * tt * d.lead;
        ay = t.move.onGround ? t.move.y + 0.15 : t.move.y + 0.9;
      }
      const ax = tx - ex, az = tz - ez;
      desiredYaw = Math.atan2(-ax, -az);
      desiredPitch = Math.atan2(ay - ey, Math.hypot(ax, az));
      // aim wobble that decays while tracking
      this.noisePhase += 0.05;
      // aim wobble decays while tracking, grows with range and with how fast the target moves
      const settle = Math.max(0.45, 1 - this.trackTicks / (TICK_RATE * d.settleTime));
      const tSpeed = Math.hypot(t.move.vx, t.move.vz);
      const wobble = d.aimError * settle * (1 + Math.min(1.5, dist / 30)) * (1 + Math.min(1, tSpeed / 7) * 0.8);
      desiredYaw += Math.sin(this.noisePhase * 1.7) * wobble + this.missOffset;
      desiredPitch += Math.cos(this.noisePhase * 1.3) * wobble * 0.6;
      if (tick % 30 === 0) this.missOffset = Math.random() < d.missChance ? (Math.random() < 0.5 ? -1 : 1) * (0.04 + Math.random() * 0.06) : 0;
      lookAtMove = false;

      // movement: hold preferred distance and strafe
      const pref = this.difficultyName === 'hard' ? 11 : this.difficultyName === 'medium' ? 15 : 18;
      const fx = dx / (dist || 1), fz = dz / (dist || 1);
      let approach = dist > pref + 6 ? 1 : dist < 5 ? -1 : 0;
      if (tick > this.strafeUntil) {
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        this.strafeUntil = tick + Math.round(TICK_RATE * (0.5 + Math.random() * 1.1));
      }
      const strafe = Math.random() < 0.98 ? this.strafeDir * d.strafe : 0;
      if (approach > 0 && this.path) {
        const wp = this.nextWaypoint();
        if (wp) { const wx = wp[0] - m.x, wz = wp[2] - m.z; const l = Math.hypot(wx, wz) || 1; wishX += wx / l; wishZ += wz / l; }
        else { wishX += fx; wishZ += fz; }
      } else {
        wishX += fx * approach; wishZ += fz * approach;
      }
      wishX += -fz * strafe; wishZ += fx * strafe;
      if (approach > 0 && (!this.path || tick >= this.repathTick)) {
        this.repath([t.move.x, t.move.y, t.move.z]);
        this.repathTick = tick + 60;
      }

      // weapons
      const yawErr = Math.abs(angleDiff(this.yaw, desiredYaw));
      const pitchErr = Math.abs(desiredPitch - this.pitch);
      const canShoot = tick >= this.targetSeenTick;
      if (canShoot) {
        // rockets: choose a rocket attack occasionally
        if (!usingRocket && me.weapons.rockets > 0 && dist > 6 && dist < 34 && Math.random() < d.rocketChance / TICK_RATE * 1.5) {
          this.rocketPlanTick = tick + 40;
        }
        if (usingRocket) {
          if (yawErr < 0.06 && pitchErr < 0.06 && dist > 5.5) {
            const dir = [Math.cos(this.pitch) * -Math.sin(this.yaw), Math.sin(this.pitch), Math.cos(this.pitch) * -Math.cos(this.yaw)];
            const block = this.game.world.raycast(ex, ey, ez, dir[0], dir[1], dir[2], 5);
            if (!block) { buttons |= BTN.ROCKET; this.rocketPlanTick = 0; }
          }
        } else if (yawErr < d.fireCone + 0.4 / Math.max(3, dist) && pitchErr < d.fireCone + 0.3) {
          if (tick < this.burstUntil) buttons |= BTN.FIRE;
          else if (tick >= this.pauseUntil) {
            const n = d.burst[0] + Math.floor(Math.random() * (d.burst[1] - d.burst[0] + 1));
            this.burstUntil = tick + n * Math.round(RIFLE.fireInterval * TICK_RATE);
            this.pauseUntil = this.burstUntil + Math.round(d.burstPause * TICK_RATE * (0.6 + Math.random() * 0.8));
            buttons |= BTN.FIRE;
          }
        }
      }
      if (this.difficultyName !== 'easy' && m.onGround && Math.random() < (this.difficultyName === 'hard' ? 0.012 : 0.004)) buttons |= BTN.JUMP;
    } else {
      // hunt
      const goal = this.huntGoal();
      if (goal && (tick >= this.repathTick || !this.path)) {
        this.repath(goal);
        this.repathTick = tick + 75 + (me.id % 5) * 7;
        if (this.lastSeenPos && Math.hypot(this.lastSeenPos[0] - m.x, this.lastSeenPos[2] - m.z) < 2) this.lastSeenPos = null;
      }
      if (tick < this.wanderUntil) {
        wishX = -Math.sin(this.wanderYaw); wishZ = -Math.cos(this.wanderYaw);
      } else {
        const wp = this.nextWaypoint();
        if (wp) {
          const wx = wp[0] - m.x, wz = wp[2] - m.z;
          const l = Math.hypot(wx, wz) || 1;
          wishX = wx / l; wishZ = wz / l;
          if (wp[1] > m.y + 0.6 && m.onGround) buttons |= BTN.JUMP;
          desiredPitch = clamp(Math.atan2(wp[1] - m.y, l) * 0.5, -0.4, 0.4);
        } else if (goal) {
          const wx = goal[0] - m.x, wz = goal[2] - m.z;
          const l = Math.hypot(wx, wz) || 1;
          wishX = wx / l; wishZ = wz / l;
          this.repathTick = Math.min(this.repathTick, tick + 20);
        }
      }
      // breach: rocket a wall between us and a nearby enemy we know about
      if (this.lastSeenPos && me.weapons.rockets >= 2 && this.difficultyName !== 'easy' && Math.random() < 0.004) {
        const [ex, ey, ez] = this.eye(me);
        const gx = this.lastSeenPos[0] - ex, gy = this.lastSeenPos[1] + 1 - ey, gz = this.lastSeenPos[2] - ez;
        const gl = Math.hypot(gx, gy, gz);
        if (gl < 25 && gl > 6) {
          const hit = this.game.world.raycast(ex, ey, ez, gx / gl, gy / gl, gz / gl, gl);
          if (hit && hit.dist > 5.5) {
            this.yaw = Math.atan2(-gx, -gz); this.pitch = Math.atan2(gy, Math.hypot(gx, gz));
            buttons |= BTN.ROCKET;
            lookAtMove = false;
            desiredYaw = this.yaw; desiredPitch = this.pitch;
          }
        }
      }
      if (me.weapons.ammo < RIFLE.magazine * 0.4 && me.weapons.reload === 0) buttons |= BTN.RELOAD;
    }

    // stuck detection
    if (tick >= this.stuckCheckTick) {
      const moved = Math.hypot(m.x - this.stuckPos[0], m.z - this.stuckPos[2]);
      const wants = Math.hypot(wishX, wishZ) > 0.3;
      if (wants && moved < 0.35) {
        this.stuckCount++;
        buttons |= BTN.JUMP;
        if (this.stuckCount >= 3) {
          this.wanderYaw = Math.random() * Math.PI * 2;
          this.wanderUntil = tick + 40;
          this.repathTick = tick + 40;
          this.stuckCount = 0;
          this.path = null;
        }
      } else this.stuckCount = 0;
      this.stuckPos = [m.x, m.y, m.z];
      this.stuckCheckTick = tick + 30;
    }

    if (lookAtMove && (wishX || wishZ)) desiredYaw = Math.atan2(-wishX, -wishZ);

    // turn toward desired view at limited rate
    const maxTurn = d.turnRate / TICK_RATE;
    const dy = angleDiff(this.yaw, desiredYaw);
    this.yaw += clamp(dy, -maxTurn, maxTurn);
    this.pitch += clamp(desiredPitch - this.pitch, -maxTurn, maxTurn);
    this.pitch = clamp(this.pitch, -1.4, 1.4);

    // world wish -> local buttons
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 0.1) {
      const nx = wishX / wl, nz = wishZ / wl;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const f = nx * -sin + nz * -cos;
      const r = nx * cos + nz * -sin;
      if (f > 0.38) buttons |= BTN.FORWARD;
      if (f < -0.38) buttons |= BTN.BACK;
      if (r > 0.38) buttons |= BTN.RIGHT;
      if (r < -0.38) buttons |= BTN.LEFT;
    }
    return this.packet(buttons, tick);
  }

  packet(buttons, tick) {
    this.seq++;
    return { seq: this.seq, buttons, yaw: this.yaw, pitch: this.pitch, renderTick: tick };
  }
}
