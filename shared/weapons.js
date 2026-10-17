// Weapon timing logic shared by the server and client prediction.
// All timers are integer ticks so both sides agree exactly.

import { RIFLE, ROCKET, TICK_RATE, BTN, PLAYER } from './constants.js';
import { hash3 } from './util.js';

export const FIRE_TICKS = Math.round(RIFLE.fireInterval * TICK_RATE);
export const RELOAD_TICKS = Math.round(RIFLE.reloadTime * TICK_RATE);
export const ROCKET_CD_TICKS = Math.round(ROCKET.cooldown * TICK_RATE);
export const ROCKET_REGEN_TICKS = Math.round(ROCKET.regenTime * TICK_RATE);

export function createWeaponState() {
  return { ammo: RIFLE.magazine, reload: 0, fireCd: 0, rockets: ROCKET.maxAmmo, rocketRegen: 0, rocketCd: 0, spread: 0, shots: 0 };
}

export function copyWeaponState(dst, src) {
  dst.ammo = src.ammo; dst.reload = src.reload; dst.fireCd = src.fireCd;
  dst.rockets = src.rockets; dst.rocketRegen = src.rocketRegen; dst.rocketCd = src.rocketCd;
  dst.spread = src.spread; dst.shots = src.shots;
  return dst;
}

export function resetWeapons(w) {
  copyWeaponState(w, createWeaponState());
}

// Returns bitmask: 1 = rifle fired, 2 = rocket fired, 4 = reload started
export function stepWeapons(w, buttons) {
  let result = 0;
  if (w.fireCd > 0) w.fireCd--;
  if (w.rocketCd > 0) w.rocketCd--;
  if (w.reload > 0) {
    w.reload--;
    if (w.reload === 0) w.ammo = RIFLE.magazine;
  }
  if (w.rockets < ROCKET.maxAmmo) {
    w.rocketRegen++;
    if (w.rocketRegen >= ROCKET_REGEN_TICKS) { w.rockets++; w.rocketRegen = 0; }
  } else {
    w.rocketRegen = 0;
  }
  w.spread = Math.max(0, w.spread - RIFLE.spreadRecovery / TICK_RATE);

  if ((buttons & BTN.RELOAD) && w.reload === 0 && w.ammo < RIFLE.magazine) {
    w.reload = RELOAD_TICKS;
    result |= 4;
  }
  if ((buttons & BTN.FIRE) && w.reload === 0 && w.fireCd === 0) {
    if (w.ammo > 0) {
      w.ammo--;
      w.fireCd = FIRE_TICKS;
      w.shots = (w.shots + 1) & 0xffff;
      result |= 1;
      if (w.ammo === 0) { w.reload = RELOAD_TICKS; result |= 4; }
    } else {
      w.reload = RELOAD_TICKS;
      result |= 4;
    }
  }
  if ((buttons & BTN.ROCKET) && w.rocketCd === 0 && w.rockets > 0) {
    w.rockets--;
    w.rocketCd = ROCKET_CD_TICKS;
    result |= 2;
  }
  return result;
}

// Spread cone (radians) for the next rifle shot, before the per-shot bloom is added.
export function shotSpread(w, move) {
  const speed = Math.hypot(move.vx, move.vz);
  let s = RIFLE.spreadBase + w.spread + Math.min(1, speed / PLAYER.walkSpeed) * RIFLE.spreadMove;
  if (!move.onGround) s += RIFLE.spreadAir;
  return Math.min(s, RIFLE.spreadMax + RIFLE.spreadAir);
}

export function addBloom(w) {
  w.spread = Math.min(RIFLE.spreadMax, w.spread + RIFLE.spreadPerShot);
}

// Deterministic spread perturbation of a direction vector.
export function applySpread(dir, cone, seedA, seedB, out = [0, 0, 0]) {
  const r1 = hash3(seedA, seedB, 17, 3);
  const r2 = hash3(seedA, seedB, 91, 5);
  const ang = r1 * Math.PI * 2;
  const mag = Math.sqrt(r2) * cone;
  // build an orthonormal basis around dir
  const [dx, dy, dz] = dir;
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(dy) > 0.95) { ux = 1; uy = 0; }
  // right = dir x up
  let rx = dy * uz - dz * uy, ry = dz * ux - dx * uz, rz = dx * uy - dy * ux;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // up2 = right x dir
  const qx = ry * dz - rz * dy, qy = rz * dx - rx * dz, qz = rx * dy - ry * dx;
  const a = Math.cos(ang) * mag, b = Math.sin(ang) * mag;
  let ox = dx + rx * a + qx * b, oy = dy + ry * a + qy * b, oz = dz + rz * a + qz * b;
  const ol = Math.hypot(ox, oy, oz);
  out[0] = ox / ol; out[1] = oy / ol; out[2] = oz / ol;
  return out;
}
